import { ulid } from 'ulid';
import { getDb } from '../db/connection.js';
import { countTokens } from '../llm/tokenizer.js';
import { activateNode, effectiveScore } from './activity.js';
import { nowISO } from '../utils/time.js';
import type { KnowledgeNode } from './types.js';

const ROOT_PATH = 'Root';

function rowToKnowledgeNode(row: Record<string, unknown>): KnowledgeNode {
  return {
    id: row.id as string,
    parentId: row.parent_id as string | null,
    nodeType: row.node_type as 'category' | 'fact',
    name: row.name as string,
    content: row.content as string,
    path: row.path as string,
    tokenCount: row.token_count as number,
    activityScore: row.activity_score as number,
    lastActivatedAt: row.last_activated_at as string,
    sourceTemporalId: row.source_temporal_id as string | null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/**
 * Ensure the root node exists.
 */
function ensureRoot(): string {
  const db = getDb();
  const row = db.prepare(`SELECT id FROM knowledge_nodes WHERE path = ? AND parent_id IS NULL`).get(ROOT_PATH) as
    | { id: string }
    | undefined;
  if (row) return row.id;

  const id = ulid();
  const now = nowISO();
  db.prepare(`
    INSERT INTO knowledge_nodes (id, parent_id, node_type, name, content, path, token_count, activity_score, last_activated_at, source_temporal_id, created_at, updated_at)
    VALUES (?, NULL, 'category', 'Root', '', ?, 0, 1.0, ?, NULL, ?, ?)
  `).run(id, ROOT_PATH, now, now, now);
  return id;
}

/**
 * Upsert a knowledge path. Creates category nodes along the path as needed,
 * then creates or updates the leaf fact.
 *
 * @param pathSegments - Path segments like ["Work", "Company"]
 * @param content - The fact content like "杭州智诺"
 * @param sourceTemporalId - Optional source temporal node ID
 * @returns The created/updated leaf node
 */
export function upsertPath(
  pathSegments: string[],
  content: string,
  sourceTemporalId?: string
): KnowledgeNode {
  const db = getDb();
  const now = nowISO();
  let parentId = ensureRoot();
  let currentPath = ROOT_PATH;

  // Traverse/create category nodes along the path
  for (let i = 0; i < pathSegments.length; i++) {
    const segment = pathSegments[i];
    currentPath = `${currentPath}/${segment}`;
    const isLast = i === pathSegments.length - 1;

    const existing = db.prepare(`
      SELECT * FROM knowledge_nodes WHERE parent_id = ? AND name = ?
    `).get(parentId, segment) as Record<string, unknown> | undefined;

    if (existing) {
      if (isLast) {
        // Update existing leaf/node content
        const tokens = countTokens(content);
        db.prepare(`
          UPDATE knowledge_nodes
          SET content = ?, token_count = ?, updated_at = ?, source_temporal_id = COALESCE(?, source_temporal_id)
          WHERE id = ?
        `).run(content, tokens, now, sourceTemporalId || null, existing.id);
        return rowToKnowledgeNode({ ...existing, content, token_count: tokens, updated_at: now });
      }
      parentId = existing.id as string;
    } else {
      const id = ulid();
      const nodeType = isLast ? 'fact' : 'category';
      const nodeContent = isLast ? content : '';
      const tokens = isLast ? countTokens(content) : 0;

      db.prepare(`
        INSERT INTO knowledge_nodes (id, parent_id, node_type, name, content, path, token_count, activity_score, last_activated_at, source_temporal_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, ?, ?, ?, ?)
      `).run(id, parentId, nodeType, segment, nodeContent, currentPath, tokens, now, sourceTemporalId || null, now, now);

      if (isLast) {
        return {
          id,
          parentId,
          nodeType: 'fact',
          name: segment,
          content,
          path: currentPath,
          tokenCount: tokens,
          activityScore: 1.0,
          lastActivatedAt: now,
          sourceTemporalId: sourceTemporalId || null,
          createdAt: now,
          updatedAt: now,
        };
      }
      parentId = id;
    }
  }

  // Shouldn't reach here if pathSegments is non-empty
  throw new Error('pathSegments cannot be empty');
}

/**
 * Find all nodes under a path prefix.
 */
export function findByPath(pathPrefix: string): KnowledgeNode[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM knowledge_nodes
    WHERE path LIKE ? || '%'
    ORDER BY path ASC
  `).all(pathPrefix) as Record<string, unknown>[];
  return rows.map(rowToKnowledgeNode);
}

/**
 * Search knowledge nodes by text query, ranked by effective activity score.
 */
export function search(query: string, topK: number = 10): KnowledgeNode[] {
  const db = getDb();
  const keywords = query.split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return [];

  // Build a LIKE-based search across name and content
  const conditions = keywords.map(() => '(name LIKE ? OR content LIKE ?)').join(' OR ');
  const params = keywords.flatMap((kw) => [`%${kw}%`, `%${kw}%`]);

  const rows = db.prepare(`
    SELECT * FROM knowledge_nodes
    WHERE ${conditions}
    ORDER BY activity_score DESC
    LIMIT ?
  `).all(...params, topK * 3) as Record<string, unknown>[];

  // Re-rank by effective score
  return rows
    .map(rowToKnowledgeNode)
    .map((node) => ({
      ...node,
      _effectiveScore: effectiveScore(node.activityScore, node.lastActivatedAt),
    }))
    .sort((a, b) => b._effectiveScore - a._effectiveScore)
    .slice(0, topK)
    .map(({ _effectiveScore, ...node }) => node as KnowledgeNode);
}

/**
 * Get the entire subtree under a node.
 */
export function getSubtree(nodeId: string): KnowledgeNode[] {
  const db = getDb();
  // Get the node's path first
  const node = db.prepare(`SELECT path FROM knowledge_nodes WHERE id = ?`).get(nodeId) as
    | { path: string }
    | undefined;
  if (!node) return [];

  const rows = db.prepare(`
    SELECT * FROM knowledge_nodes
    WHERE path LIKE ? || '%'
    ORDER BY path ASC
  `).all(node.path) as Record<string, unknown>[];
  return rows.map(rowToKnowledgeNode);
}

/**
 * Format knowledge nodes into a readable context string for the LLM prompt.
 */
export function toContextString(nodes: KnowledgeNode[]): string {
  if (nodes.length === 0) return '';

  const lines: string[] = ['## 已知信息'];
  for (const node of nodes) {
    const indent = node.path.split('/').length - 1;
    const prefix = '  '.repeat(Math.max(0, indent - 1));
    if (node.nodeType === 'category') {
      lines.push(`${prefix}- **${node.name}**${node.content ? ': ' + node.content : ''}`);
    } else {
      lines.push(`${prefix}- ${node.name}: ${node.content}`);
    }
  }
  return lines.join('\n');
}

/**
 * Activate a knowledge node (boost score).
 */
export function activate(nodeId: string): void {
  activateNode('knowledge_nodes', nodeId);
}

/**
 * Get all root-level children for tree display.
 */
export function getRootChildren(): KnowledgeNode[] {
  const db = getDb();
  const root = db.prepare(`SELECT id FROM knowledge_nodes WHERE path = ? AND parent_id IS NULL`).get(ROOT_PATH) as
    | { id: string }
    | undefined;
  if (!root) return [];

  const rows = db.prepare(`
    SELECT * FROM knowledge_nodes
    WHERE parent_id = ?
    ORDER BY name ASC
  `).all(root.id) as Record<string, unknown>[];
  return rows.map(rowToKnowledgeNode);
}

/**
 * Get all knowledge nodes for tree display.
 */
export function getAllNodes(): KnowledgeNode[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM knowledge_nodes ORDER BY path ASC
  `).all() as Record<string, unknown>[];
  return rows.map(rowToKnowledgeNode);
}
