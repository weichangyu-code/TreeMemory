import { ulid } from 'ulid';
import { getDb } from '../db/connection.js';
import { countTokens } from '../llm/tokenizer.js';
import { chatCompletion } from '../llm/client.js';
import { activateNode, effectiveScore } from './activity.js';
import { getHourKey, getDayKey, hourKeyToStart, hourKeyToEnd, dayKeyToStart, dayKeyToEnd, nowISO } from '../utils/time.js';
import { HOUR_SUMMARY_PROMPT, DAY_SUMMARY_PROMPT } from '../prompts/index.js';
import type { TemporalNode } from './types.js';

function rowToTemporalNode(row: Record<string, unknown>): TemporalNode {
  return {
    id: row.id as string,
    parentId: row.parent_id as string | null,
    level: row.level as 0 | 1 | 2,
    role: row.role as string,
    content: row.content as string,
    tokenCount: row.token_count as number,
    timeStart: row.time_start as string,
    timeEnd: row.time_end as string,
    activityScore: row.activity_score as number,
    lastActivatedAt: row.last_activated_at as string,
    summarized: (row.summarized as number) === 1,
    metadata: JSON.parse((row.metadata as string) || '{}'),
    createdAt: row.created_at as string,
  };
}

/**
 * Insert a leaf node (individual message or command) into the temporal tree.
 */
export function insertLeaf(
  role: string,
  content: string,
  timestamp?: Date
): TemporalNode {
  const db = getDb();
  const now = timestamp || new Date();
  const iso = now.toISOString();
  const id = ulid();
  const tokens = countTokens(content);

  db.prepare(`
    INSERT INTO temporal_nodes (id, parent_id, level, role, content, token_count, time_start, time_end, activity_score, last_activated_at, metadata, created_at, summarized)
    VALUES (?, NULL, 0, ?, ?, ?, ?, ?, 1.0, ?, '{}', ?, 0)
  `).run(id, role, content, tokens, iso, iso, iso, iso);

  return {
    id,
    parentId: null,
    level: 0,
    role,
    content,
    tokenCount: tokens,
    timeStart: iso,
    timeEnd: iso,
    activityScore: 1.0,
    lastActivatedAt: iso,
    summarized: false,
    metadata: {},
    createdAt: iso,
  };
}

/**
 * Get recent unsummarized leaf nodes, ordered by time descending.
 */
export function getRecentLeaves(limit: number = 50): TemporalNode[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM temporal_nodes
    WHERE level = 0 AND summarized = 0
    ORDER BY time_start DESC
    LIMIT ?
  `).all(limit) as Record<string, unknown>[];
  return rows.map(rowToTemporalNode).reverse(); // chronological order
}

/**
 * Get all leaves for a specific hour bucket.
 */
export function getLeavesByHour(hourKey: string): TemporalNode[] {
  const db = getDb();
  const start = hourKeyToStart(hourKey);
  const end = hourKeyToEnd(hourKey);
  const rows = db.prepare(`
    SELECT * FROM temporal_nodes
    WHERE level = 0 AND time_start >= ? AND time_start <= ?
    ORDER BY time_start ASC
  `).all(start, end) as Record<string, unknown>[];
  return rows.map(rowToTemporalNode);
}

/**
 * Summarize all leaves within an hour bucket using LLM.
 * Creates a level-1 (hour summary) node and marks leaves as summarized.
 */
export async function summarizeHour(hourKey: string): Promise<TemporalNode | null> {
  const leaves = getLeavesByHour(hourKey);
  if (leaves.length === 0) return null;

  const conversationText = leaves
    .map((l) => `[${l.role}] ${l.content}`)
    .join('\n');

  const summary = await chatCompletion([
    {
      role: 'system',
      content: HOUR_SUMMARY_PROMPT,
    },
    { role: 'user', content: conversationText },
  ], { temperature: 0.3 });

  const db = getDb();
  const id = ulid();
  const now = nowISO();
  const tokens = countTokens(summary);
  const timeStart = hourKeyToStart(hourKey);
  const timeEnd = hourKeyToEnd(hourKey);

  db.prepare(`
    INSERT INTO temporal_nodes (id, parent_id, level, role, content, token_count, time_start, time_end, activity_score, last_activated_at, metadata, created_at, summarized)
    VALUES (?, NULL, 1, 'summary', ?, ?, ?, ?, 1.0, ?, '{}', ?, 0)
  `).run(id, summary, tokens, timeStart, timeEnd, now, now);

  // Mark leaves as summarized and set parent
  const leafIds = leaves.map((l) => l.id);
  const placeholders = leafIds.map(() => '?').join(',');
  db.prepare(`
    UPDATE temporal_nodes SET summarized = 1, parent_id = ? WHERE id IN (${placeholders})
  `).run(id, ...leafIds);

  return {
    id,
    parentId: null,
    level: 1,
    role: 'summary',
    content: summary,
    tokenCount: tokens,
    timeStart,
    timeEnd,
    activityScore: 1.0,
    lastActivatedAt: now,
    summarized: false,
    metadata: {},
    createdAt: now,
  };
}

/**
 * Get all hour summaries for a specific day.
 */
export function getHourSummariesByDay(dayKey: string): TemporalNode[] {
  const db = getDb();
  const start = dayKeyToStart(dayKey);
  const end = dayKeyToEnd(dayKey);
  const rows = db.prepare(`
    SELECT * FROM temporal_nodes
    WHERE level = 1 AND time_start >= ? AND time_end <= ?
    ORDER BY time_start ASC
  `).all(start, end) as Record<string, unknown>[];
  return rows.map(rowToTemporalNode);
}

/**
 * Summarize all hour summaries within a day into a day-level summary.
 */
export async function summarizeDay(dayKey: string): Promise<TemporalNode | null> {
  const hourSummaries = getHourSummariesByDay(dayKey);
  if (hourSummaries.length === 0) return null;

  const text = hourSummaries
    .map((h) => `[${h.timeStart.slice(11, 16)}] ${h.content}`)
    .join('\n');

  const summary = await chatCompletion([
    {
      role: 'system',
      content: DAY_SUMMARY_PROMPT,
    },
    { role: 'user', content: text },
  ], { temperature: 0.3 });

  const db = getDb();
  const id = ulid();
  const now = nowISO();
  const tokens = countTokens(summary);
  const timeStart = dayKeyToStart(dayKey);
  const timeEnd = dayKeyToEnd(dayKey);

  db.prepare(`
    INSERT INTO temporal_nodes (id, parent_id, level, role, content, token_count, time_start, time_end, activity_score, last_activated_at, metadata, created_at, summarized)
    VALUES (?, NULL, 2, 'summary', ?, ?, ?, ?, 1.0, ?, '{}', ?, 0)
  `).run(id, summary, tokens, timeStart, timeEnd, now, now);

  // Mark hour summaries as summarized
  const hourIds = hourSummaries.map((h) => h.id);
  const placeholders = hourIds.map(() => '?').join(',');
  db.prepare(`
    UPDATE temporal_nodes SET summarized = 1, parent_id = ? WHERE id IN (${placeholders})
  `).run(id, ...hourIds);

  return {
    id,
    parentId: null,
    level: 2,
    role: 'summary',
    content: summary,
    tokenCount: tokens,
    timeStart,
    timeEnd,
    activityScore: 1.0,
    lastActivatedAt: now,
    summarized: false,
    metadata: {},
    createdAt: now,
  };
}

/**
 * Get a context window fitting within a token budget.
 * Priority: recent leaves → hour summaries → day summaries (older history).
 */
export function getContextWindow(tokenBudget: number): TemporalNode[] {
  const db = getDb();
  const result: TemporalNode[] = [];
  let remaining = tokenBudget;

  // 1. Recent unsummarized leaves (most important)
  const leaves = db.prepare(`
    SELECT * FROM temporal_nodes
    WHERE level = 0 AND summarized = 0
    ORDER BY time_start DESC
    LIMIT 100
  `).all() as Record<string, unknown>[];

  for (const row of leaves.reverse()) {
    const node = rowToTemporalNode(row);
    if (node.tokenCount > remaining) break;
    result.push(node);
    remaining -= node.tokenCount;
  }

  if (remaining <= 50) return result;

  // 2. Hour summaries (for recent history that's been summarized)
  const hourSummaries = db.prepare(`
    SELECT * FROM temporal_nodes
    WHERE level = 1
    ORDER BY time_start DESC
    LIMIT 50
  `).all() as Record<string, unknown>[];

  for (const row of hourSummaries) {
    const node = rowToTemporalNode(row);
    const score = effectiveScore(node.activityScore, node.lastActivatedAt);
    if (node.tokenCount > remaining) continue;
    // Skip hour summaries that overlap with unsummarized leaves
    if (result.some((r) => r.level === 0 && r.timeStart >= node.timeStart && r.timeStart <= node.timeEnd)) continue;
    result.push({ ...node, activityScore: score });
    remaining -= node.tokenCount;
    if (remaining <= 50) break;
  }

  if (remaining <= 50) return sortByTime(result);

  // 3. Day summaries (for older history)
  const daySummaries = db.prepare(`
    SELECT * FROM temporal_nodes
    WHERE level = 2
    ORDER BY time_start DESC
    LIMIT 20
  `).all() as Record<string, unknown>[];

  for (const row of daySummaries) {
    const node = rowToTemporalNode(row);
    const score = effectiveScore(node.activityScore, node.lastActivatedAt);
    if (node.tokenCount > remaining) continue;
    result.push({ ...node, activityScore: score });
    remaining -= node.tokenCount;
    if (remaining <= 50) break;
  }

  return sortByTime(result);
}

/**
 * Get temporal nodes by time range.
 */
export function getByTimeRange(start: string, end: string): TemporalNode[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM temporal_nodes
    WHERE time_start >= ? AND time_end <= ?
    ORDER BY level DESC, time_start ASC
  `).all(start, end) as Record<string, unknown>[];
  return rows.map(rowToTemporalNode);
}

/**
 * Get top nodes by activity score.
 */
export function getTopByActivity(minLevel: number, limit: number, excludeIds: Set<string>): TemporalNode[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM temporal_nodes
    WHERE level >= ?
    ORDER BY activity_score DESC
    LIMIT ?
  `).all(minLevel, limit * 2) as Record<string, unknown>[]; // fetch more to filter

  return rows
    .map(rowToTemporalNode)
    .filter((n) => !excludeIds.has(n.id))
    .slice(0, limit);
}

/**
 * Activate a temporal node (boost score).
 */
export function activate(nodeId: string): void {
  activateNode('temporal_nodes', nodeId);
}

/**
 * Get stale hours: hours with enough unsummarized leaves that are old enough.
 */
export function getStaleHours(minLeaves: number, minAgeMinutes: number): string[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - minAgeMinutes * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT substr(time_start, 1, 13) as hour_key, count(*) as cnt
    FROM temporal_nodes
    WHERE level = 0 AND summarized = 0
    GROUP BY hour_key
    HAVING cnt >= ? AND max(time_end) < ?
  `).all(minLeaves, cutoff) as { hour_key: string; cnt: number }[];
  return rows.map((r) => r.hour_key);
}

/**
 * Get days where all hour summaries exist and are unsummarized at day level.
 */
export function getStaleDays(): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT substr(time_start, 1, 10) as day_key, count(*) as cnt
    FROM temporal_nodes
    WHERE level = 1 AND summarized = 0
    GROUP BY day_key
    HAVING cnt >= 1
      AND NOT EXISTS (
        SELECT 1 FROM temporal_nodes t2
        WHERE t2.level = 0 AND t2.summarized = 0
        AND substr(t2.time_start, 1, 10) = substr(temporal_nodes.time_start, 1, 10)
      )
  `).all() as { day_key: string; cnt: number }[];
  return rows.map((r) => r.day_key);
}

function sortByTime(nodes: TemporalNode[]): TemporalNode[] {
  return nodes.sort((a, b) => a.timeStart.localeCompare(b.timeStart));
}
