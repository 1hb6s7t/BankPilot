import type { serve } from '@hono/node-server';

/** Stop accepting HTTP before draining both request handlers and background plans. */
export function installApiShutdown(options: {
  server: ReturnType<typeof serve>;
  waitForPlanning(): Promise<void>;
  closePool(): Promise<void>;
}) {
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (stopping) return stopping;
    stopping = new Promise<void>((resolve, reject) => options.server.close(error => error ? reject(error) : resolve()))
      .then(async () => { await options.waitForPlanning(); await options.closePool(); });
    void stopping.catch(error => {
      console.error('BankPilot API shutdown failed:', error instanceof Error ? error.message : 'API_SHUTDOWN_FAILED');
      process.exitCode = 1;
    });
    return stopping;
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
  return stop;
}
