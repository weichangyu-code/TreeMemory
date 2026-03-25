import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

export function runMigrations(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  if (currentVersion < 1) {
    logger.info('Running migration 001: initial schema');
    db.exec(`
      -- Temporal tree nodes (time-based memory)
      CREATE TABLE IF NOT EXISTS temporal_nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES temporal_nodes(id),
        level INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        time_start TEXT NOT NULL,
        time_end TEXT NOT NULL,
        activity_score REAL NOT NULL DEFAULT 1.0,
        last_activated_at TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        summarized INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_temporal_parent ON temporal_nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_temporal_level_time ON temporal_nodes(level, time_start);
      CREATE INDEX IF NOT EXISTS idx_temporal_level_summarized ON temporal_nodes(level, summarized);
      CREATE INDEX IF NOT EXISTS idx_temporal_activity ON temporal_nodes(activity_score DESC);

      -- Knowledge tree nodes (semantic memory)
      CREATE TABLE IF NOT EXISTS knowledge_nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES knowledge_nodes(id),
        node_type TEXT NOT NULL CHECK(node_type IN ('category', 'fact')),
        name TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        path TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        activity_score REAL NOT NULL DEFAULT 1.0,
        last_activated_at TEXT NOT NULL,
        source_temporal_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_parent ON knowledge_nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_path ON knowledge_nodes(path);
      CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge_nodes(node_type);
      CREATE INDEX IF NOT EXISTS idx_knowledge_activity ON knowledge_nodes(activity_score DESC);

      -- Conversations
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL
      );

      -- Conversation messages (working buffer)
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        temporal_node_id TEXT REFERENCES temporal_nodes(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conv_msg_conv ON conversation_messages(conversation_id, created_at);

      -- Background tasks queue
      CREATE TABLE IF NOT EXISTS background_tasks (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        payload TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_bg_tasks_status ON background_tasks(status, task_type);

      PRAGMA user_version = 1;
    `);
    logger.info('Migration 001 completed');
  }
}
