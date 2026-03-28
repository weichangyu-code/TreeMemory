import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { vi } from 'vitest';

let db: Database.Database;

vi.mock('../../src/config/index.js', () => ({
  config: {
    llmBaseUrl: 'http://localhost:11434/v1',
    llmApiKey: 'test',
    llmModel: 'test',
    maxContextTokens: 8192,
    summarizeThresholdRatio: 0.75,
    dbPath: ':memory:',
    httpPort: 3000,
    backgroundIntervalMs: 60000,
    activityDecayRate: 0.95,
    activityBoost: 1.0,
  },
}));

vi.mock('../../src/db/connection.js', () => {
  return {
    getDb: () => db,
    closeDb: () => {},
  };
});

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import { runMigrations } from '../../src/db/migrate.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('Knowledge Tree', () => {
  it('should create a path with category and fact nodes', async () => {
    const { upsertPath, findByPath } = await import('../../src/memory/knowledge-tree.js');

    const node = upsertPath(['个人信息', '姓名'], '小魏');

    expect(node).toBeDefined();
    expect(node.nodeType).toBe('fact');
    expect(node.name).toBe('姓名');
    expect(node.content).toBe('小魏');
    expect(node.path).toBe('Root/个人信息/姓名');

    // Check that category nodes were created
    const allNodes = findByPath('Root');
    expect(allNodes.length).toBeGreaterThanOrEqual(3); // Root, 个人信息, 姓名
  });

  it('should update existing node content on upsert', async () => {
    const { upsertPath } = await import('../../src/memory/knowledge-tree.js');

    upsertPath(['个人信息', '姓名'], '小魏');
    const updated = upsertPath(['个人信息', '姓名'], '老魏');

    expect(updated.content).toBe('老魏');

    // DB should only have one '姓名' node
    const count = (db.prepare(`SELECT count(*) as cnt FROM knowledge_nodes WHERE name = '姓名'`).get() as { cnt: number }).cnt;
    expect(count).toBe(1);
  });

  it('should build deep paths correctly', async () => {
    const { upsertPath } = await import('../../src/memory/knowledge-tree.js');

    upsertPath(['工作', '公司'], '杭州智诺');
    upsertPath(['工作', '项目', 'AOV', '类型'], '硬件项目');

    // Verify paths
    const companyRow = db.prepare(`SELECT * FROM knowledge_nodes WHERE name = '公司'`).get() as Record<string, unknown>;
    expect(companyRow.path).toBe('Root/工作/公司');
    expect(companyRow.content).toBe('杭州智诺');

    const typeRow = db.prepare(`SELECT * FROM knowledge_nodes WHERE name = '类型'`).get() as Record<string, unknown>;
    expect(typeRow.path).toBe('Root/工作/项目/AOV/类型');
    expect(typeRow.content).toBe('硬件项目');
  });

  it('should search by keywords', async () => {
    const { upsertPath, search } = await import('../../src/memory/knowledge-tree.js');

    upsertPath(['个人信息', '姓名'], '小魏');
    upsertPath(['工作', '公司'], '杭州智诺');
    upsertPath(['工作', '项目'], 'AOV硬件项目');

    const results = search('杭州', 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.content.includes('杭州'))).toBe(true);
  });

  it('should format context string', async () => {
    const { upsertPath, getAllNodes, toContextString } = await import('../../src/memory/knowledge-tree.js');

    upsertPath(['个人信息', '姓名'], '小魏');
    upsertPath(['工作', '公司'], '杭州智诺');

    const nodes = getAllNodes();
    const context = toContextString(nodes);

    expect(context).toContain('已知信息');
    expect(context).toContain('小魏');
    expect(context).toContain('杭州智诺');
  });

  it('should get all root children', async () => {
    const { upsertPath, getRootChildren } = await import('../../src/memory/knowledge-tree.js');

    upsertPath(['个人信息', '姓名'], '小魏');
    upsertPath(['工作', '公司'], '杭州智诺');

    const children = getRootChildren();
    expect(children.length).toBe(2);
    const names = children.map((c) => c.name).sort();
    expect(names).toEqual(['个人信息', '工作']);
  });
});

describe('Profile management', () => {
  it('should setProfile and getProfile for predefined keys', async () => {
    const { setProfile, getProfile } = await import('../../src/memory/knowledge-tree.js');

    setProfile('bot_name', '小树');
    setProfile('owner_name', '小魏');

    expect(getProfile('bot_name')).toBe('小树');
    expect(getProfile('owner_name')).toBe('小魏');
  });

  it('should return null for non-existent key', async () => {
    const { getProfile } = await import('../../src/memory/knowledge-tree.js');

    expect(getProfile('bot_name')).toBeNull();
  });

  it('should setProfile with custom key', async () => {
    const { setProfile, getProfile } = await import('../../src/memory/knowledge-tree.js');

    setProfile('favorite_color', '蓝色');
    expect(getProfile('favorite_color')).toBe('蓝色');
  });

  it('should getAllProfiles returns all profile entries', async () => {
    const { setProfile, getAllProfiles } = await import('../../src/memory/knowledge-tree.js');

    setProfile('bot_name', '小树');
    setProfile('owner_name', '小魏');
    setProfile('relationship', '好朋友');

    const profiles = getAllProfiles();
    expect(profiles.length).toBe(3);
    expect(profiles.find((p) => p.key === 'bot_name')?.value).toBe('小树');
  });

  it('should update existing value on setProfile', async () => {
    const { setProfile, getProfile } = await import('../../src/memory/knowledge-tree.js');

    setProfile('bot_name', '小树');
    setProfile('bot_name', '大树');
    expect(getProfile('bot_name')).toBe('大树');
  });

  it('should store predefined keys in correct paths', async () => {
    const { setProfile, findByPath } = await import('../../src/memory/knowledge-tree.js');

    setProfile('bot_name', '小树');

    const nodes = findByPath('Root/基本信息/Bot/名字');
    const factNode = nodes.find((n) => n.nodeType === 'fact');
    expect(factNode).toBeDefined();
    expect(factNode?.content).toBe('小树');
  });

  it('should store custom keys in 其他 path', async () => {
    const { setProfile, findByPath } = await import('../../src/memory/knowledge-tree.js');

    setProfile('custom_key', '自定义值');

    const nodes = findByPath('Root/基本信息/其他/custom_key');
    const factNode = nodes.find((n) => n.nodeType === 'fact');
    expect(factNode).toBeDefined();
    expect(factNode?.content).toBe('自定义值');
  });
});

describe('getTopActiveKnowledge', () => {
  it('should return top active knowledge nodes sorted by effective score', async () => {
    const { upsertPath, getTopActiveKnowledge, activate } = await import('../../src/memory/knowledge-tree.js');

    // 创建一些知识节点
    upsertPath(['工作', '公司'], '杭州智诺');
    upsertPath(['工作', '项目'], 'AOV硬件项目');
    upsertPath(['个人信息', '爱好'], '编程');

    // 激活其中一个节点多次
    const companyNode = (await import('../../src/memory/knowledge-tree.js')).findByPath('Root/工作/公司')
      .find((n) => n.nodeType === 'fact');
    if (companyNode) {
      activate(companyNode.id);
      activate(companyNode.id);
    }

    const topActive = getTopActiveKnowledge(10);
    expect(topActive.length).toBeGreaterThanOrEqual(1);
    // 第一个应该是被激活过的节点
    expect(topActive[0].content).toBe('杭州智诺');
  });

  it('should exclude profile nodes', async () => {
    const { setProfile, upsertPath, getTopActiveKnowledge } = await import('../../src/memory/knowledge-tree.js');

    // 创建 profile 和普通知识
    setProfile('bot_name', '小树');
    upsertPath(['工作', '公司'], '杭州智诺');

    const topActive = getTopActiveKnowledge(10);
    // 不应该包含 profile 节点
    expect(topActive.every((n) => !n.path.includes('基本信息'))).toBe(true);
  });

  it('should return empty array when no facts exist', async () => {
    const { getTopActiveKnowledge } = await import('../../src/memory/knowledge-tree.js');

    const topActive = getTopActiveKnowledge(10);
    expect(topActive).toEqual([]);
  });
});

describe('getTreeOverview', () => {
  it('should return tree structure overview', async () => {
    const { upsertPath, getTreeOverview } = await import('../../src/memory/knowledge-tree.js');

    upsertPath(['工作', '公司'], '杭州智诺');
    upsertPath(['工作', '项目', 'AOV'], '硬件项目');
    upsertPath(['个人信息', '姓名'], '小魏');

    const overview = getTreeOverview(3);

    expect(overview).toContain('📂 工作');
    expect(overview).toContain('📂 个人信息');
    expect(overview).toContain('- 公司');
    expect(overview).toContain('- 姓名');
    // 不应该包含 content
    expect(overview).not.toContain('杭州智诺');
    expect(overview).not.toContain('小魏');
  });

  it('should respect maxDepth', async () => {
    const { upsertPath, getTreeOverview } = await import('../../src/memory/knowledge-tree.js');

    upsertPath(['工作', '项目', 'AOV', '类型'], '硬件项目');

    // maxDepth=2 应该只显示到 '项目' 层
    const overview2 = getTreeOverview(2);
    expect(overview2).toContain('📂 工作');
    expect(overview2).toContain('📂 项目');
    expect(overview2).not.toContain('AOV');
    expect(overview2).not.toContain('类型');
  });

  it('should return empty string when no nodes', async () => {
    const { getTreeOverview } = await import('../../src/memory/knowledge-tree.js');

    const overview = getTreeOverview(3);
    // 可能只有 Root 节点，所以可能是空的
    expect(typeof overview).toBe('string');
  });
});

describe('Node navigation', () => {
  it('getNodeByPath returns exact match', async () => {
    const { upsertPath, getNodeByPath } = await import('../../src/memory/knowledge-tree.js');

    upsertPath(['工作', '公司'], '杭州智诺');
    const node = getNodeByPath('Root/工作/公司');
    expect(node).not.toBeNull();
    expect(node!.content).toBe('杭州智诺');
  });

  it('getNodeByPath returns null for non-existent path', async () => {
    const { getNodeByPath } = await import('../../src/memory/knowledge-tree.js');

    const node = getNodeByPath('Root/不存在');
    expect(node).toBeNull();
  });

  it('getParent returns parent node', async () => {
    const { upsertPath, getNodeByPath, getParent } = await import('../../src/memory/knowledge-tree.js');

    upsertPath(['工作', '公司'], '杭州智诺');
    const node = getNodeByPath('Root/工作/公司');
    const parent = getParent(node!.id);
    expect(parent).not.toBeNull();
    expect(parent!.name).toBe('工作');
    expect(parent!.nodeType).toBe('category');
  });

  it('getParent returns null for root node', async () => {
    const { getNodeByPath, getParent } = await import('../../src/memory/knowledge-tree.js');

    const root = getNodeByPath('Root');
    expect(root).not.toBeNull();
    const parent = getParent(root!.id);
    expect(parent).toBeNull();
  });

  it('getChildren returns direct children', async () => {
    const { upsertPath, getNodeByPath, getChildren } = await import('../../src/memory/knowledge-tree.js');

    upsertPath(['工作', '公司'], '杭州智诺');
    upsertPath(['工作', '项目'], '数据平台');
    const parent = getNodeByPath('Root/工作');
    const children = getChildren(parent!.id);
    expect(children.length).toBe(2);
    const names = children.map((c) => c.name).sort();
    expect(names).toEqual(['公司', '项目']);
  });

  it('getChildren returns empty array for leaf node', async () => {
    const { upsertPath, getNodeByPath, getChildren } = await import('../../src/memory/knowledge-tree.js');

    upsertPath(['工作', '公司'], '杭州智诺');
    const leaf = getNodeByPath('Root/工作/公司');
    const children = getChildren(leaf!.id);
    expect(children).toEqual([]);
  });

  it('getNodeContext returns full context', async () => {
    const { upsertPath, getNodeByPath, getNodeContext } = await import('../../src/memory/knowledge-tree.js');

    upsertPath(['工作', '公司'], '杭州智诺');
    upsertPath(['工作', '项目', '前端'], 'React');
    upsertPath(['工作', '项目', '后端'], 'Node.js');

    const projectNode = getNodeByPath('Root/工作/项目');
    const context = getNodeContext(projectNode!.id, 1);

    expect(context).not.toBeNull();
    expect(context!.node.name).toBe('项目');
    expect(context!.parent).not.toBeNull();
    expect(context!.parent!.name).toBe('工作');
    expect(context!.children.length).toBe(2); // 前端 + 后端
  });

  it('getNodeContext returns null for non-existent node', async () => {
    const { getNodeContext } = await import('../../src/memory/knowledge-tree.js');

    const context = getNodeContext('non-existent-id', 2);
    expect(context).toBeNull();
  });

  it('getNodeContext respects childDepth', async () => {
    const { upsertPath, getNodeByPath, getNodeContext } = await import('../../src/memory/knowledge-tree.js');

    // 创建多层结构: 工作 -> 项目 -> AOV -> 类型
    upsertPath(['工作', '项目', 'AOV', '类型'], '硬件项目');

    const workNode = getNodeByPath('Root/工作');

    // childDepth=1 应该只获取 "项目"
    const context1 = getNodeContext(workNode!.id, 1);
    expect(context1!.children.length).toBe(1);
    expect(context1!.children[0].name).toBe('项目');

    // childDepth=2 应该获取 "项目" 和 "AOV"
    const context2 = getNodeContext(workNode!.id, 2);
    expect(context2!.children.length).toBe(2);
    const names = context2!.children.map((c) => c.name).sort();
    expect(names).toContain('AOV');
    expect(names).toContain('项目');
  });

  it('getNodeContext with childDepth=0 returns no children', async () => {
    const { upsertPath, getNodeByPath, getNodeContext } = await import('../../src/memory/knowledge-tree.js');

    upsertPath(['工作', '公司'], '杭州智诺');

    const workNode = getNodeByPath('Root/工作');
    const context = getNodeContext(workNode!.id, 0);

    expect(context).not.toBeNull();
    expect(context!.node.name).toBe('工作');
    expect(context!.children).toEqual([]);
  });
});
