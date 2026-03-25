import { getDb, closeDb } from './db/connection.js';
import { startBackgroundScheduler, stopBackgroundScheduler } from './background/scheduler.js';

async function main(): Promise<void> {
  const mode = process.argv[2] || 'cli';

  // Initialize database
  getDb();

  // Start background scheduler
  startBackgroundScheduler();

  // Handle graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    stopBackgroundScheduler();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (mode === 'server') {
    const { startServer } = await import('./server.js');
    await startServer();
  } else {
    const { startCli } = await import('./cli.js');
    await startCli();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
