import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Context } from 'cordis';
import WebSocket from 'ws';
import { AgentPeripheralStatus } from '@dsh-hid/protocol';
import { PeripheralServerService } from '../src/service.js';

describe('Hot-Start and Dynamic Lifecycle Integration (No Harness Reboot)', () => {
  let ctx: Context;
  let service: PeripheralServerService;

  beforeEach(() => {
    ctx = new Context();
  });

  afterEach(async () => {
    if (service) {
      await service.stop();
    }
  });

  it('supports closing and reopening the plugin repeatedly without port collision', async () => {
    service = new PeripheralServerService(ctx, {
      port: 0,
      autoStartDaemon: false,
      autoBindSlots: true,
    });
    await service.start();

    expect(service.isRunning()).toBe(true);
    const initialPort = service.wsServer.getPort();
    expect(initialPort).toBeGreaterThan(0);

    // 1. Close the plugin dynamically while harness keeps running
    await service.close();
    expect(service.isRunning()).toBe(false);
    expect(service.isEnabled()).toBe(false);

    // 2. Hot-start the plugin again
    await service.open();
    expect(service.isRunning()).toBe(true);
    expect(service.isEnabled()).toBe(true);

    // Verify WebSocket accepts fresh client connection
    const client = new WebSocket(`ws://127.0.0.1:${service.wsServer.getPort()}/peripheral/v1`);
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve());
      client.on('error', reject);
    });

    expect(service.wsServer.getClientCount()).toBe(1);
    client.close();

    // 3. Close once more
    await service.close();
    expect(service.isRunning()).toBe(false);

    // 4. Hot-start once more
    await service.open();
    expect(service.isRunning()).toBe(true);
  });

  it('hydrates existing DSH sessions upon hot-start when DSH has prior active sessions', async () => {
    // Simulate DSH session and agent store already populated before plugin mounts
    const mockSessions = [
      { id: 'prior-session-1' },
      { id: 'prior-session-2' },
    ];
    const mockAgents = [
      { id: 'prior-agent-3', session: { id: 'prior-session-3' } },
    ];

    (ctx as any).sessions = {
      list: vi.fn(() => mockSessions),
    };
    (ctx as any).agents = {
      list: vi.fn(() => mockAgents),
    };

    service = new PeripheralServerService(ctx, {
      port: 0,
      autoStartDaemon: false,
      autoBindSlots: true,
    });
    await service.start();

    // Verify pre-existing sessions were automatically bound to slots
    const slot1 = service.router.getSlotBySessionId('prior-session-1');
    const slot2 = service.router.getSlotBySessionId('prior-session-2');
    const slot3 = service.router.getSlotBySessionId('prior-session-3');

    expect(slot1).not.toBeNull();
    expect(slot1?.slotIndex).toBe(1);
    expect(slot2).not.toBeNull();
    expect(slot2?.slotIndex).toBe(2);
    expect(slot3).not.toBeNull();
    expect(slot3?.slotIndex).toBe(3);

    // Verify initial snapshot reports these slots to newly connected hardware/UI
    const snapshot = service.router.getSnapshot();
    expect(snapshot.slots.filter((s) => s.status !== AgentPeripheralStatus.INACTIVE).length).toBe(3);
  });

  it('respects initial config enabled: false (dormant mode) and hot-starts on open()', async () => {
    service = new PeripheralServerService(ctx, {
      port: 0,
      autoStartDaemon: false,
      enabled: false,
    });

    expect(service.isEnabled()).toBe(false);
    expect(service.isRunning()).toBe(false);

    // Calling start() while disabled remains a no-op
    await service.start();
    expect(service.isRunning()).toBe(false);

    // Hot-start explicitly
    await service.open();
    expect(service.isEnabled()).toBe(true);
    expect(service.isRunning()).toBe(true);

    // Hot-stop explicitly
    await service.close();
    expect(service.isEnabled()).toBe(false);
    expect(service.isRunning()).toBe(false);
  });

  it('handles JSON-RPC peripheral/getStatus and peripheral/restart methods', async () => {
    service = new PeripheralServerService(ctx, {
      port: 0,
      autoStartDaemon: false,
    });
    await service.start();

    const client = new WebSocket(`ws://127.0.0.1:${service.wsServer.getPort()}/peripheral/v1?role=ui`);
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve());
      client.on('error', reject);
    });

    // 1. Test peripheral/getStatus
    const statusPromise = new Promise<any>((resolve) => {
      client.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.id === 101) {
          resolve(msg.result);
        }
      });
    });

    client.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 101,
        method: 'peripheral/getStatus',
        params: {},
      })
    );

    const statusResult = await statusPromise;
    expect(statusResult.isRunning).toBe(true);
    expect(statusResult.isEnabled).toBe(true);
    expect(statusResult.uiClientCount).toBe(1);

    // 2. Test peripheral/restart
    const restartPromise = new Promise<any>((resolve) => {
      client.on('message', (data) => {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.id === 102) {
          resolve(msg.result);
        }
      });
    });

    client.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 102,
        method: 'peripheral/restart',
        params: {},
      })
    );

    const restartResult = await restartPromise;
    expect(restartResult.success).toBe(true);

    client.close();
  });
});
