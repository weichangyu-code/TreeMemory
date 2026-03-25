import { config } from '../config/index.js';
import { runTemporalRollup } from './temporal-summarizer.js';
import { runKnowledgeExtraction } from './knowledge-extractor.js';
import { logger } from '../utils/logger.js';

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

async function tick(): Promise<void> {
  if (isRunning) return; // prevent overlapping ticks
  isRunning = true;

  try {
    await runTemporalRollup();
    await runKnowledgeExtraction();
  } catch (err) {
    logger.error({ err }, 'Background scheduler tick failed');
  } finally {
    isRunning = false;
  }
}

/**
 * Start the background scheduler.
 */
export function startBackgroundScheduler(): void {
  if (intervalHandle) return;

  logger.info({ intervalMs: config.backgroundIntervalMs }, 'Starting background scheduler');
  intervalHandle = setInterval(tick, config.backgroundIntervalMs);

  // Run once immediately after a short delay
  setTimeout(tick, 5000);
}

/**
 * Stop the background scheduler.
 */
export function stopBackgroundScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Background scheduler stopped');
  }
}
