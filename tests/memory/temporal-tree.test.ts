import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ulid } from 'ulid';

// We need to set up the DB before importing modules that use it
// Use a temporary in-memory database for tests
let db: Database.Database;

// Mock the config and db modules
import { vi } from 'vitest';

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

describe('Temporal Tree', () => {
  it('should insert a leaf node', async () => {
    const { insertLeaf } = await import('../../src/memory/temporal-tree.js');
    const node = insertLeaf('user', 'Hello, world!');

    expect(node).toBeDefined();
    expect(node.level).toBe(0);
    expect(node.role).toBe('user');
    expect(node.content).toBe('Hello, world!');
    expect(node.summarized).toBe(false);
    expect(node.activityScore).toBe(1.0);
    expect(node.tokenCount).toBeGreaterThan(0);

    // Verify in DB
    const row = db.prepare('SELECT * FROM temporal_nodes WHERE id = ?').get(node.id) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.content).toBe('Hello, world!');
  });

  it('should get recent leaves in chronological order', async () => {
    const { insertLeaf, getRecentLeaves } = await import('../../src/memory/temporal-tree.js');

    const now = new Date();
    insertLeaf('user', 'First message', new Date(now.getTime() - 3000));
    insertLeaf('assistant', 'Second message', new Date(now.getTime() - 2000));
    insertLeaf('user', 'Third message', new Date(now.getTime() - 1000));

    const leaves = getRecentLeaves(10);
    expect(leaves.length).toBe(3);
    expect(leaves[0].content).toBe('First message');
    expect(leaves[1].content).toBe('Second message');
    expect(leaves[2].content).toBe('Third message');
  });

  it('should get context window within token budget', async () => {
    const { insertLeaf, getContextWindow } = await import('../../src/memory/temporal-tree.js');

    for (let i = 0; i < 10; i++) {
      insertLeaf('user', `Message number ${i}`);
    }

    // Small budget should return fewer messages
    const small = getContextWindow(50);
    expect(small.length).toBeLessThanOrEqual(10);

    // Large budget should return more
    const large = getContextWindow(5000);
    expect(large.length).toBe(10);
  });

  it('should get stale hours', async () => {
    const { insertLeaf, getStaleHours } = await import('../../src/memory/temporal-tree.js');

    // Insert leaves 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (let i = 0; i < 6; i++) {
      insertLeaf('user', `Old message ${i}`, twoHoursAgo);
    }

    const staleHours = getStaleHours(5, 30);
    expect(staleHours.length).toBe(1);
  });
});
