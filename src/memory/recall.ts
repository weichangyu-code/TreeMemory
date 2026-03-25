import { config } from '../config/index.js';
import * as temporalTree from './temporal-tree.js';
import * as knowledgeTree from './knowledge-tree.js';
import { effectiveScore } from './activity.js';
import type { RecallResult, TemporalNode, KnowledgeNode } from './types.js';

/**
 * Extract simple keywords from a user message.
 * For Chinese text, splits on common particles and stop words.
 * For mixed text, also splits on whitespace and punctuation.
 */
function extractKeywords(message: string): string[] {
  const stopWords = new Set([
    '的', '了', '是', '在', '我', '你', '他', '她', '它', '们',
    '有', '和', '与', '或', '不', '这', '那', '着', '到', '被',
    '把', '也', '就', '都', '而', '及', '对', '以', '从', '吗',
    '吧', '呢', '啊', '哦', '嗯', '好', '很', '会', '能', '可以',
    '什么', '怎么', '哪个', '哪些', '为什么', '如何', '请问',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can',
    'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from',
    'and', 'or', 'but', 'not', 'no', 'this', 'that', 'it', 'i',
    'you', 'he', 'she', 'we', 'they', 'me', 'my', 'your', 'what',
    'how', 'when', 'where', 'why', 'which', 'who',
  ]);

  // Split on whitespace, punctuation, and common Chinese particles
  const rawTokens = message
    .split(/[\s,，。！？!?.、；;：:""''()（）\[\]【】的了是在有和与或不这那着到被把也就都而及对以从吗吧呢啊]+/)
    .filter((w) => w.length > 0);

  // For each token, if it's long Chinese text, also break into 2-3 char grams
  const keywords: string[] = [];
  for (const token of rawTokens) {
    if (stopWords.has(token.toLowerCase())) continue;
    if (token.length > 1) {
      keywords.push(token);
    }
    // For Chinese tokens longer than 4 chars, also generate sub-tokens (bigrams)
    if (token.length >= 4 && /[\u4e00-\u9fff]/.test(token)) {
      for (let i = 0; i < token.length - 1; i += 2) {
        const sub = token.slice(i, i + 2);
        if (sub.length === 2 && !stopWords.has(sub)) {
          keywords.push(sub);
        }
      }
    }
  }

  // Deduplicate
  return [...new Set(keywords)];
}

/**
 * Extract time references from a message.
 * Returns a time range { start, end } or null.
 */
function extractTimeReference(message: string): { start: string; end: string } | null {
  const now = new Date();

  if (/昨天|yesterday/i.test(message)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    const dayKey = d.toISOString().slice(0, 10);
    return { start: `${dayKey}T00:00:00.000Z`, end: `${dayKey}T23:59:59.999Z` };
  }

  if (/前天/i.test(message)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 2);
    const dayKey = d.toISOString().slice(0, 10);
    return { start: `${dayKey}T00:00:00.000Z`, end: `${dayKey}T23:59:59.999Z` };
  }

  if (/上周|last\s*week/i.test(message)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    const start = d.toISOString().slice(0, 10);
    const end = now.toISOString().slice(0, 10);
    return { start: `${start}T00:00:00.000Z`, end: `${end}T23:59:59.999Z` };
  }

  if (/今天|today/i.test(message)) {
    const dayKey = now.toISOString().slice(0, 10);
    return { start: `${dayKey}T00:00:00.000Z`, end: `${dayKey}T23:59:59.999Z` };
  }

  return null;
}

/**
 * Unified memory recall.
 * Given a user message and token budget, retrieves relevant context from both trees.
 */
export function recall(userMessage: string, tokenBudget: number): RecallResult {
  const result: RecallResult = {
    knowledgeContext: [],
    temporalContext: [],
    totalTokens: 0,
  };

  let remaining = tokenBudget;
  const keywords = extractKeywords(userMessage);
  const timeRef = extractTimeReference(userMessage);

  // Phase 1: Knowledge recall (~15% of budget)
  const knowledgeBudget = Math.floor(tokenBudget * 0.25); // slightly more generous
  let knowledgeRemaining = knowledgeBudget;

  if (keywords.length > 0) {
    const candidates = knowledgeTree.search(keywords.join(' '), 20);
    for (const node of candidates) {
      if (node.tokenCount > knowledgeRemaining) continue;
      result.knowledgeContext.push(node);
      knowledgeRemaining -= node.tokenCount;
      knowledgeTree.activate(node.id);
    }
  }

  remaining -= (knowledgeBudget - knowledgeRemaining);
  result.totalTokens += (knowledgeBudget - knowledgeRemaining);

  // Phase 2: Recent leaves (always included, most important)
  const recentLeaves = temporalTree.getRecentLeaves(100);
  for (const leaf of recentLeaves) {
    if (leaf.tokenCount > remaining) break;
    result.temporalContext.push(leaf);
    remaining -= leaf.tokenCount;
    result.totalTokens += leaf.tokenCount;
  }

  // Phase 3: Time range search if referenced
  if (timeRef && remaining > 100) {
    const rangeNodes = temporalTree.getByTimeRange(timeRef.start, timeRef.end);
    const existingIds = new Set(result.temporalContext.map((n) => n.id));
    const scored = rangeNodes
      .filter((n) => !existingIds.has(n.id))
      .map((n) => ({ ...n, _eff: effectiveScore(n.activityScore, n.lastActivatedAt) }))
      .sort((a, b) => b._eff - a._eff);

    for (const node of scored) {
      if (node.tokenCount > remaining) continue;
      const { _eff, ...clean } = node;
      result.temporalContext.push(clean as TemporalNode);
      remaining -= node.tokenCount;
      result.totalTokens += node.tokenCount;
      temporalTree.activate(node.id);
    }
  }

  // Phase 4: High-activity historical summaries to fill remaining budget
  if (remaining > 200) {
    const existingIds = new Set(result.temporalContext.map((n) => n.id));
    const historical = temporalTree.getTopByActivity(1, 10, existingIds);
    for (const node of historical) {
      if (node.tokenCount > remaining) continue;
      result.temporalContext.push(node);
      remaining -= node.tokenCount;
      result.totalTokens += node.tokenCount;
    }
  }

  // Sort temporal context by time
  result.temporalContext.sort((a, b) => a.timeStart.localeCompare(b.timeStart));

  return result;
}
