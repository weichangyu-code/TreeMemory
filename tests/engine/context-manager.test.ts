import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import Database from 'better-sqlite3';

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

describe('Context Manager', () => {
  it('should detect when summarization is needed', async () => {
    const { shouldSummarize } = await import('../../src/engine/context-manager.js');

    // Below threshold (75% of 8192 = 6144)
    expect(shouldSummarize(3000)).toBe(false);
    expect(shouldSummarize(6000)).toBe(false);

    // Above threshold
    expect(shouldSummarize(6200)).toBe(true);
    expect(shouldSummarize(8000)).toBe(true);
  });

  it('should calculate recall budget correctly', async () => {
    const { calculateRecallBudget } = await import('../../src/engine/context-manager.js');

    const budget = calculateRecallBudget([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);

    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(8192);
  });

  it('should inject tree overview in assemblePrompt', async () => {
    const { assemblePrompt } = await import('../../src/engine/context-manager.js');
    const { upsertPath } = await import('../../src/memory/knowledge-tree.js');

    // 创建一些知识节点
    upsertPath(['工作', '公司'], '杭州智诺');
    upsertPath(['个人信息', '姓名'], '小魏');

    const messages = assemblePrompt(
      [{ role: 'user', content: '你好' }],
      { knowledgeContext: [], temporalContext: [], totalTokens: 0 }
    );

    // 系统消息应该包含知识结构概览
    const systemMsg = messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.content).toContain('你的知识结构');
    expect(systemMsg?.content).toContain('📂 工作');
  });

  it('should inject top active knowledge in assemblePrompt', async () => {
    const { assemblePrompt } = await import('../../src/engine/context-manager.js');
    const { upsertPath, activate, findByPath } = await import('../../src/memory/knowledge-tree.js');

    // 创建知识节点
    upsertPath(['工作', '公司'], '杭州智诺');

    // 激活节点
    const nodes = findByPath('Root/工作/公司');
    const factNode = nodes.find((n) => n.nodeType === 'fact');
    if (factNode) {
      activate(factNode.id);
    }

    const messages = assemblePrompt(
      [{ role: 'user', content: '你好' }],
      { knowledgeContext: [], temporalContext: [], totalTokens: 0 }
    );

    // 系统消息应该包含高活跃知识
    const systemMsg = messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.content).toContain('近期重要记忆');
    expect(systemMsg?.content).toContain('杭州智诺');
  });

  it('should inject recent summaries in assemblePrompt', async () => {
    const { assemblePrompt } = await import('../../src/engine/context-manager.js');
    const { insertLeaf } = await import('../../src/memory/temporal-tree.js');

    // 创建一些临时节点（模拟摘要，level >= 1）
    const now = new Date();
    db.prepare(`
      INSERT INTO temporal_nodes (id, parent_id, level, role, content, token_count, time_start, time_end, activity_score, last_activated_at, metadata, created_at, summarized)
      VALUES ('test-summary-1', NULL, 1, 'summary', '这是一个小时摘要', 10, ?, ?, 1.0, ?, '{}', ?, 0)
    `).run(now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString());

    const messages = assemblePrompt(
      [{ role: 'user', content: '你好' }],
      { knowledgeContext: [], temporalContext: [], totalTokens: 0 }
    );

    // 系统消息应该包含最近摘要
    const systemMsg = messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.content).toContain('最近的聊天总结');
    expect(systemMsg?.content).toContain('这是一个小时摘要');
  });
});
