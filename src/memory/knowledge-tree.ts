import { ulid } from 'ulid';
import { getDb } from '../db/connection.js';
import { countTokens } from '../llm/tokenizer.js';
import { activateNode, effectiveScore } from './activity.js';
import { nowISO } from '../utils/time.js';
import type { KnowledgeNode, ProfileKey, ProfileEntry } from './types.js';

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

// ============================================================================
// 节点导航函数
// ============================================================================

/**
 * 根据精确路径获取单个节点
 * @param exactPath 完整路径如 "Root/工作/公司"
 * @returns 匹配的节点，或 null
 */
export function getNodeByPath(exactPath: string): KnowledgeNode | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM knowledge_nodes WHERE path = ?`).get(exactPath) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToKnowledgeNode(row) : null;
}

/**
 * 获取指定节点的父节点
 * @param nodeId 节点ID
 * @returns 父节点，或 null（如果是根节点）
 */
export function getParent(nodeId: string): KnowledgeNode | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM knowledge_nodes
    WHERE id = (SELECT parent_id FROM knowledge_nodes WHERE id = ?)
  `).get(nodeId) as Record<string, unknown> | undefined;
  return row ? rowToKnowledgeNode(row) : null;
}

/**
 * 获取指定节点的直接子节点
 * @param nodeId 节点ID
 * @returns 直接子节点列表
 */
export function getChildren(nodeId: string): KnowledgeNode[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM knowledge_nodes
    WHERE parent_id = ?
    ORDER BY name ASC
  `).all(nodeId) as Record<string, unknown>[];
  return rows.map(rowToKnowledgeNode);
}

/**
 * 获取指定节点及其上下文（父节点 + 有限层子节点）
 * 这是一个综合导航函数，一次性返回节点的"邻域"
 * @param nodeId 节点ID
 * @param childDepth 向下展开的层数，默认2
 * @returns { node, parent, children } 结构化的导航结果，或 null 如果节点不存在
 */
export function getNodeContext(
  nodeId: string,
  childDepth: number = 2
): {
  node: KnowledgeNode;
  parent: KnowledgeNode | null;
  children: KnowledgeNode[];
} | null {
  const db = getDb();

  // 1. 获取节点本身
  const nodeRow = db.prepare(`SELECT * FROM knowledge_nodes WHERE id = ?`).get(nodeId) as
    | Record<string, unknown>
    | undefined;
  if (!nodeRow) return null;
  const node = rowToKnowledgeNode(nodeRow);

  // 2. 获取父节点
  const parent = getParent(nodeId);

  // 3. 使用 BFS 获取有限深度的子节点
  const children: KnowledgeNode[] = [];
  if (childDepth > 0) {
    let currentLevel = [nodeId];
    for (let depth = 0; depth < childDepth && currentLevel.length > 0; depth++) {
      const nextLevel: string[] = [];
      for (const parentId of currentLevel) {
        const childRows = db.prepare(`
          SELECT * FROM knowledge_nodes
          WHERE parent_id = ?
          ORDER BY name ASC
        `).all(parentId) as Record<string, unknown>[];
        for (const row of childRows) {
          const childNode = rowToKnowledgeNode(row);
          children.push(childNode);
          nextLevel.push(childNode.id);
        }
      }
      currentLevel = nextLevel;
    }
  }

  return { node, parent, children };
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

// ============================================================================
// Profile (基本信息) 管理函数
// ============================================================================

// 基本信息的根路径
const PROFILE_ROOT = '基本信息';

// ProfileKey 到路径的映射
const PROFILE_PATH_MAP: Record<string, string[]> = {
  bot_name:     ['Bot', '名字'],
  bot_persona:  ['Bot', '人设'],
  owner_name:   ['主人', '名字'],
  owner_info:   ['主人', '简介'],
  relationship: ['关系', '描述'],
};

/**
 * 设置基本信息
 * 对于预定义的 key，使用标准路径；对于自定义 key，存在 基本信息/其他/{key} 下
 */
export function setProfile(key: ProfileKey, value: string): KnowledgeNode {
  const pathParts = PROFILE_PATH_MAP[key]
    ? [PROFILE_ROOT, ...PROFILE_PATH_MAP[key]]
    : [PROFILE_ROOT, '其他', key];
  return upsertPath(pathParts, value);
}

/**
 * 获取基本信息
 * 返回 null 如果不存在
 */
export function getProfile(key: ProfileKey): string | null {
  const pathParts = PROFILE_PATH_MAP[key]
    ? [PROFILE_ROOT, ...PROFILE_PATH_MAP[key]]
    : [PROFILE_ROOT, '其他', key];
  const fullPath = 'Root/' + pathParts.join('/');
  const nodes = findByPath(fullPath);
  const exact = nodes.find((n) => n.path === fullPath && n.nodeType === 'fact');
  return exact ? exact.content : null;
}

/**
 * 获取所有基本信息
 * 返回 基本信息 路径下的所有 fact 节点
 */
export function getAllProfiles(): ProfileEntry[] {
  const nodes = findByPath(`Root/${PROFILE_ROOT}`);
  return nodes
    .filter((n) => n.nodeType === 'fact')
    .map((n) => ({
      key: pathToProfileKey(n.path),
      value: n.content,
      path: n.path,
    }));
}

/**
 * 将路径映射回 ProfileKey（如果是预定义的），否则返回路径最后一段
 */
function pathToProfileKey(path: string): string {
  for (const [key, parts] of Object.entries(PROFILE_PATH_MAP)) {
    const expectedPath = `Root/${PROFILE_ROOT}/${parts.join('/')}`;
    if (path === expectedPath) return key;
  }
  // 自定义键：取路径最后一段
  const segments = path.split('/');
  return segments[segments.length - 1];
}

// ============================================================================
// 高活跃知识与知识树概览函数
// ============================================================================

/**
 * 获取高活跃度的知识节点（fact类型），按 effectiveScore 降序排列
 * 不依赖关键词搜索，始终返回最活跃的 topK 个事实
 * 排除 基本信息 路径下的节点（这些已通过 profile 注入）
 */
export function getTopActiveKnowledge(topK: number = 10): KnowledgeNode[] {
  const db = getDb();
  // 查询所有 fact 节点，排除基本信息路径
  const rows = db.prepare(`
    SELECT * FROM knowledge_nodes
    WHERE node_type = 'fact'
      AND path NOT LIKE 'Root/${PROFILE_ROOT}%'
    ORDER BY activity_score DESC
    LIMIT ?
  `).all(topK * 3) as Record<string, unknown>[];

  // 用 effectiveScore 重新排序
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
 * 获取知识树的结构概览（前 maxDepth 层）
 * 返回格式化的树形字符串，只包含 category 节点名称和 fact 节点的 name
 * 不包含 fact 的具体 content，保持简洁
 * maxDepth 是从 Root 算起的层数（如 maxDepth=3 返回 Root → 分类 → 子分类/事实）
 */
export function getTreeOverview(maxDepth: number = 3): string {
  const allNodes = getAllNodes();
  if (allNodes.length === 0) return '';

  // 构建节点映射和子节点映射
  const nodeMap = new Map<string, KnowledgeNode>();
  const childrenMap = new Map<string | null, KnowledgeNode[]>();

  for (const node of allNodes) {
    nodeMap.set(node.id, node);
    const children = childrenMap.get(node.parentId) || [];
    children.push(node);
    childrenMap.set(node.parentId, children);
  }

  // 递归构建树形字符串
  const lines: string[] = [];

  function buildTree(parentId: string | null, depth: number): void {
    // maxDepth 是从 Root（depth=1）算起，所以 depth > maxDepth 时停止
    if (depth > maxDepth) return;

    const children = childrenMap.get(parentId) || [];
    // 按名称排序
    children.sort((a, b) => a.name.localeCompare(b.name));

    for (const node of children) {
      // Root 节点不显示
      if (node.parentId === null && node.path === ROOT_PATH) {
        // 递归处理 Root 的子节点，depth 保持为 1
        buildTree(node.id, 1);
        continue;
      }

      const indent = '  '.repeat(depth - 1);
      if (node.nodeType === 'category') {
        lines.push(`${indent}📂 ${node.name}`);
        buildTree(node.id, depth + 1);
      } else {
        // fact 节点只显示 name，不显示 content
        lines.push(`${indent}- ${node.name}`);
      }
    }
  }

  buildTree(null, 0);
  return lines.join('\n');
}
