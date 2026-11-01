import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Context } from 'cordis';
import {
  AgentPeripheralStatus,
  type BrainpowerLevel,
} from '@dsh-hid/protocol';
import { PeripheralServerService } from 'dsh-plugin-peripheral-server';
import { DaemonClient, MockAdapter } from '../src/index.js';

describe('Full-Stack E2E Multi-Agent Lifecycle & Hardware Loop', () => {
  let ctx: Context;
  let service: PeripheralServerService;
  let adapter: MockAdapter;
  let client: DaemonClient;

  beforeEach(async () => {
    // 1. Initialize Cordis microkernel and peripheral server
    ctx = new Context();
    service = new PeripheralServerService(ctx, {
      port: 0, // dynamic port for test isolation
      autoBindSlots: true,
      heartbeatIntervalMs: 2000,
    });
    await service.start();

    // 2. Initialize hardware adapter and daemon client
    const port = service.wsServer.getPort();
    const wsUrl = `ws://127.0.0.1:${port}/peripheral/v1`;

    adapter = new MockAdapter({ interactiveOutput: false });
    client = new DaemonClient(adapter, {
      url: wsUrl,
      initialReconnectDelayMs: 60,
      maxReconnectDelayMs: 200,
    });
    await client.start();

    // Wait for initial connection & snapshot sync
    await new Promise((r) => setTimeout(r, 100));
  });

  afterEach(async () => {
    await client.stop();
    await service.stop();
  });

  it('runs complete multi-agent lifecycle, hardware interaction and auto-reconnect recovery', async () => {
    // 1. Initial state: slots 1-12 inactive
    expect(client.isConnected()).toBe(true);
    expect(client.getFocusedSlot()).toBe(1);
    const initialRender = adapter.getLastRenderedString();
    expect(initialRender).toContain('F1:OFF');
    expect(initialRender).toContain('F12:OFF');

    // 2. Concurrent multi-agent registration
    ctx.emit('agent/created', 'session-slot-1');
    ctx.emit('agent/created', 'session-slot-2');
    ctx.emit('agent/created', 'session-slot-3');
    await new Promise((r) => setTimeout(r, 80));

    expect(service.router.getSlot(1)?.sessionId).toBe('session-slot-1');
    expect(service.router.getSlot(2)?.sessionId).toBe('session-slot-2');
    expect(service.router.getSlot(3)?.sessionId).toBe('session-slot-3');

    // 3. Agent 1: running with active tool
    ctx.emit('agent/status', 'session-slot-1', 'running');
    ctx.emit('agent/tool-start', 'session-slot-1', 'bash');
    await new Promise((r) => setTimeout(r, 60));

    let renderOutput = adapter.getLastRenderedString();
    expect(renderOutput).toContain('F1:RUN');
    expect(renderOutput).toContain('[Tool: bash]');

    // 4. Agent 2: HITL question (needs input)
    ctx.emit('interaction/user-questions', 'session-slot-2', {
      prompt: 'Deploy high-risk database migration?',
      options: ['Confirm Deploy', 'Cancel'],
    });
    await new Promise((r) => setTimeout(r, 60));

    renderOutput = adapter.getLastRenderedString();
    expect(renderOutput).toContain('F2:ASK');
    expect(renderOutput).toContain('Deploy high-risk database migration?');

    // 5. Agent 3: error state
    ctx.emit('agent/status', 'session-slot-3', 'error');
    await new Promise((r) => setTimeout(r, 60));

    renderOutput = adapter.getLastRenderedString();
    expect(renderOutput).toContain('F3:ERR');

    // 6. Hardware physical interaction: Switch focus to Slot 2 (F2 key press)
    const focusListener = vi.fn();
    ctx.on('peripheral/focus-switched', focusListener);

    adapter.simulateKeyPress(2);
    await new Promise((r) => setTimeout(r, 100));

    expect(focusListener).toHaveBeenCalledWith(2, 'session-slot-2');
    expect(client.getFocusedSlot()).toBe(2);
    renderOutput = adapter.getLastRenderedString();
    expect(renderOutput).toContain('►[F2:'); // Focused indicator

    // 7. Hardware physical interaction: Rotary knob stepUp to boost brainpower
    const brainpowerListener = vi.fn();
    ctx.on('peripheral/brainpower-changed', brainpowerListener);

    adapter.simulateKnob('stepUp');
    await new Promise((r) => setTimeout(r, 100));

    expect(brainpowerListener).toHaveBeenCalledWith(2, 'high' as BrainpowerLevel, 'session-slot-2');
    expect(service.router.getSlot(2)?.brainpower).toBe('high');

    // 8. Hardware physical interaction: Quick response button (Confirm Deploy)
    const optionListener = vi.fn();
    ctx.on('peripheral/option-selected', optionListener);

    adapter.simulateOption('Confirm Deploy');
    await new Promise((r) => setTimeout(r, 100));

    expect(optionListener).toHaveBeenCalledWith(2, 0, 'Confirm Deploy', 'session-slot-2');
    // Once confirmed, router marks slot running and clears the question
    expect(service.router.getSlot(2)?.status).toBe(AgentPeripheralStatus.RUNNING);
    expect(service.router.getSlot(2)?.question).toBeUndefined();

    // 9. Hardware physical interaction: Emergency abort button
    const abortListener = vi.fn();
    ctx.on('peripheral/abort-requested', abortListener);

    adapter.simulateAbort();
    await new Promise((r) => setTimeout(r, 100));

    expect(abortListener).toHaveBeenCalledWith(2, 'session-slot-2');
    expect(service.router.getSlot(2)?.status).toBe(AgentPeripheralStatus.ERROR);

    // 10. Fault tolerance & auto-reconnect recovery
    // Simulate abrupt network drop by disconnecting active server-side sockets
    for (const ws of (service.wsServer as any).activeClients) {
      ws.terminate();
    }
    await new Promise((r) => setTimeout(r, 200));

    // Verify client auto-reconnected and state is fully preserved
    expect(client.isConnected()).toBe(true);
    expect(client.getFocusedSlot()).toBe(2);
    renderOutput = adapter.getLastRenderedString();
    expect(renderOutput).toContain('F1:RUN');
    expect(renderOutput).toContain('F2:ERR');
    expect(renderOutput).toContain('F3:ERR');

    // 11. Cleanup agents on disposal
    ctx.emit('agent/disposed', 'session-slot-1');
    ctx.emit('agent/disposed', 'session-slot-2');
    ctx.emit('agent/disposed', 'session-slot-3');
    await new Promise((r) => setTimeout(r, 80));

    renderOutput = adapter.getLastRenderedString();
    expect(renderOutput).toContain('F1:OFF');
    expect(renderOutput).toContain('F2:OFF');
    expect(renderOutput).toContain('F3:OFF');
  });
});
