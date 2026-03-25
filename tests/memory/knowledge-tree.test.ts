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
