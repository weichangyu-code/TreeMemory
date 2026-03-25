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

describe('Recall', () => {
  it('should recall knowledge context matching keywords', async () => {
    const { upsertPath } = await import('../../src/memory/knowledge-tree.js');
    const { recall } = await import('../../src/memory/recall.js');

    upsertPath(['工作', '公司'], '杭州智诺');
    upsertPath(['工作', '项目', 'AOV'], '硬件项目');
    upsertPath(['个人信息', '姓名'], '小魏');

    const result = recall('杭州智诺的项目是什么', 5000);

    expect(result.knowledgeContext.length).toBeGreaterThanOrEqual(1);
    const hasRelevant = result.knowledgeContext.some(
      (k) => k.content.includes('杭州') || k.content.includes('项目')
    );
    expect(hasRelevant).toBe(true);
  });

  it('should recall recent temporal context', async () => {
    const { insertLeaf } = await import('../../src/memory/temporal-tree.js');
    const { recall } = await import('../../src/memory/recall.js');

    insertLeaf('user', '我在杭州智诺工作');
    insertLeaf('assistant', '好的，我记住了');
    insertLeaf('user', 'AOV项目进展如何');

    const result = recall('最近说了什么', 5000);

    expect(result.temporalContext.length).toBe(3);
  });

  it('should respect token budget', async () => {
    const { insertLeaf } = await import('../../src/memory/temporal-tree.js');
    const { recall } = await import('../../src/memory/recall.js');

    // Insert many messages
    for (let i = 0; i < 50; i++) {
      insertLeaf('user', `这是第${i}条比较长的测试消息，包含一些内容来占用token`);
    }

    const result = recall('测试', 100);
    expect(result.totalTokens).toBeLessThanOrEqual(200); // some slack
  });
});
