import { describe, it, expect, vi } from 'vitest';
import { Context } from 'cordis';
import apply, { PeripheralServerService } from '../src/index.js';

describe('Cordis Graceful Task Teardown Integration', () => {
  it('correctly shuts down background server and handles upon ctx.fiber.dispose()', async () => {
    const ctx = new Context();
    await ctx.plugin(apply, { port: 0, autoStartDaemon: false });

    const service = (ctx as any).peripheralServer as PeripheralServerService;
    expect(service).toBeDefined();

    const stopSpy = vi.spyOn(service, 'stop');
    const start = Date.now();

    // Emulate host teardown in DeepSeek Harness Desktop update flow
    await ctx.fiber.dispose();
    const duration = Date.now() - start;

    expect(stopSpy).toHaveBeenCalled();
    expect((service.wsServer as any).started).toBe(false);
    expect((service.wsServer as any).pingInterval).toBeNull();
    expect(service.daemonManager.isRunning()).toBe(false);
    // Must complete gracefully well within the 5000ms host teardown deadline
    expect(duration).toBeLessThan(2000);
  });
});
