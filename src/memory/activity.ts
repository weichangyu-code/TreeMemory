import { config } from '../config/index.js';
import { getDb } from '../db/connection.js';
import { daysBetween, nowISO } from '../utils/time.js';

/**
 * Calculate the effective activity score with time decay.
 * Uses lazy computation: score * (decayRate ^ daysSinceActivation)
 */
export function effectiveScore(activityScore: number, lastActivatedAt: string): number {
  const days = daysBetween(lastActivatedAt, nowISO());
  return activityScore * Math.pow(config.activityDecayRate, days);
}

/**
 * Activate a node: boost its score and partially boost ancestors.
 * Works for both temporal_nodes and knowledge_nodes tables.
 */
export function activateNode(
  table: 'temporal_nodes' | 'knowledge_nodes',
  nodeId: string
): void {
  const db = getDb();
  const now = nowISO();
  const boost = config.activityBoost;
  const ancestorRatio = 0.3;

  // Boost the node itself
  db.prepare(`
    UPDATE ${table}
    SET activity_score = activity_score + ?,
        last_activated_at = ?
    WHERE id = ?
  `).run(boost, now, nodeId);

  // Propagate partial boost to ancestors
  let currentId: string | null = nodeId;
  while (currentId) {
    const row = db.prepare(`SELECT parent_id FROM ${table} WHERE id = ?`).get(currentId) as
      | { parent_id: string | null }
      | undefined;
    if (!row || !row.parent_id) break;
    currentId = row.parent_id;
    db.prepare(`
      UPDATE ${table}
      SET activity_score = activity_score + ?,
          last_activated_at = ?
      WHERE id = ?
    `).run(boost * ancestorRatio, now, currentId);
  }
}
