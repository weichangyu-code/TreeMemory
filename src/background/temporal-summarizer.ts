import * as temporalTree from '../memory/temporal-tree.js';
import { logger } from '../utils/logger.js';

/**
 * Roll up temporal tree nodes:
 * 1. Summarize hours with enough unsummarized leaves that are old enough
 * 2. Summarize days where all hours have been summarized
 */
export async function runTemporalRollup(): Promise<void> {
  // 1. Summarize stale hours (>= 5 leaves, > 30 minutes old)
  const staleHours = temporalTree.getStaleHours(5, 30);
  for (const hourKey of staleHours) {
    try {
      logger.info({ hourKey }, 'Summarizing hour');
      await temporalTree.summarizeHour(hourKey);
      logger.info({ hourKey }, 'Hour summarized');
    } catch (err) {
      logger.error({ hourKey, err }, 'Failed to summarize hour');
    }
  }

  // 2. Summarize stale days
  const staleDays = temporalTree.getStaleDays();
  for (const dayKey of staleDays) {
    try {
      logger.info({ dayKey }, 'Summarizing day');
      await temporalTree.summarizeDay(dayKey);
      logger.info({ dayKey }, 'Day summarized');
    } catch (err) {
      logger.error({ dayKey, err }, 'Failed to summarize day');
    }
  }
}
