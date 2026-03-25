import Database from 'better-sqlite3';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { runMigrations } from './migrate.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    logger.info({ dbPath: config.dbPath }, 'Database connection opened');
    runMigrations(db);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}
