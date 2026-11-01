import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import {
  AgentPeripheralStatus,
  NOTIFICATION_SNAPSHOT,
  NOTIFICATION_SLOT_UPDATED,
  NOTIFICATION_FOCUS_CHANGED,
  METHOD_SWITCH_FOCUS,
  METHOD_SELECT_OPTION,
  createJsonRpcNotification,
  createJsonRpcSuccessResponse,
  type SlotInfo,
} from '@dsh-hid/protocol';
import { DaemonClient, MockAdapter } from '../src/index.js';

describe('Daemon E2E Multi-Slot Lifecycle & Hardware Interaction Flow', () => {
  let wss: WebSocketServer;
  let wsUrl: string;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => {
      wss.on('listening', () => {
        const addr = wss.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        wsUrl = `ws://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  });

  it('completes full state streaming and input feedback cycle', async () => {
    const adapter = new MockAdapter();
    const client = new DaemonClient(adapter, { url: wsUrl });

    let serverWs: WebSocket | null = null;
    const receivedCalls: Array<{ method: string; params: unknown }> = [];

    wss.on('connection', (ws) => {
      serverWs = ws;
      ws.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString());
        receivedCalls.push({ method: parsed.method, params: parsed.params });
        ws.send(JSON.stringify(createJsonRpcSuccessResponse(parsed.id, { ok: true })));
      });

      // 1. Server emits snapshot with 2 slots
      const initialSlots: SlotInfo[] = [
        { slotIndex: 1, sessionId: 'session-alpha', status: AgentPeripheralStatus.IDLE },
        { slotIndex: 2, sessionId: 'session-beta', status: AgentPeripheralStatus.IDLE },
      ];
      ws.send(JSON.stringify(createJsonRpcNotification(NOTIFICATION_SNAPSHOT, {
        slots: initialSlots,
        focusedSlot: 1,
      })));
    });

    await client.start();
    await new Promise((r) => setTimeout(r, 80));

    expect(client.getFocusedSlot()).toBe(1);
    expect(adapter.getLastRenderedString()).toContain('F1:IDL');
    expect(adapter.getLastRenderedString()).toContain('F2:IDL');

    // 2. Agent in Slot 1 starts running a tool
    serverWs!.send(JSON.stringify(createJsonRpcNotification(NOTIFICATION_SLOT_UPDATED, {
      slotIndex: 1,
      sessionId: 'session-alpha',
      status: AgentPeripheralStatus.RUNNING,
      activeTool: 'git_commit',
    })));
    await new Promise((r) => setTimeout(r, 60));
    expect(adapter.getLastRenderedString()).toContain('F1:RUN');
    expect(adapter.getLastRenderedString()).toContain('[Tool: git_commit]');

    // 3. Agent in Slot 1 pauses for human approval
    serverWs!.send(JSON.stringify(createJsonRpcNotification(NOTIFICATION_SLOT_UPDATED, {
      slotIndex: 1,
      sessionId: 'session-alpha',
      status: AgentPeripheralStatus.NEEDS_INPUT,
      question: {
        prompt: 'Proceed with commit to main?',
        options: ['ACCEPT', 'REJECT'],
      },
    })));
    await new Promise((r) => setTimeout(r, 60));
    expect(adapter.getLastRenderedString()).toContain('F1:ASK');
    expect(adapter.getLastRenderedString()).toContain('Proceed with commit to main?');

    // 4. Physical button press on hardware simulator: Accept
    adapter.simulateOption('ACCEPT');
    await new Promise((r) => setTimeout(r, 80));

    expect(receivedCalls).toContainEqual({
      method: METHOD_SELECT_OPTION,
      params: { action: 'ACCEPT' },
    });

    // 5. User switches focus to Slot 2 via physical F2 key
    adapter.simulateKeyPress(2);
    await new Promise((r) => setTimeout(r, 80));

    expect(receivedCalls).toContainEqual({
      method: METHOD_SWITCH_FOCUS,
      params: { slotIndex: 2 },
    });

    await client.stop();
  });
});
