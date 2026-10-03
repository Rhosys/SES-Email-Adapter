import type { Logger } from '../../src/logger.js';

let invocationId = 'integration-test';

export function createConsoleLogger(): Logger {
  return {
    startInvocation(id: string) { invocationId = id; },
    getInvocationId() { return invocationId; },
    trackPoint() { /* no-op */ },
    info(msg, ctx) { console.log('[info]', msg, ctx ?? ''); },
    track(msg, ctx) { console.log('[track]', msg, ctx ?? ''); },
    warn(msg, ctx) { console.warn('[warn]', msg, ctx ?? ''); },
    error(msg, ctx) { console.error('[error]', msg, ctx ?? ''); },
    critical(msg, ctx) { console.error('[critical]', msg, ctx ?? ''); },
  };
}
