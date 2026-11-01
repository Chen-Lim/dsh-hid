import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import {
  AgentPeripheralStatus,
  NOTIFICATION_SNAPSHOT,
  NOTIFICATION_SLOT_UPDATED,
  NOTIFICATION_FOCUS_CHANGED,
  METHOD_SWITCH_FOCUS,
  METHOD_SET_BRAINPOWER,
  METHOD_SELECT_OPTION,
  METHOD_ABORT,
  createJsonRpcNotification,
  createJsonRpcSuccessResponse,
  type SlotInfo,
} from '@dsh-hid/protocol';
import { MockAdapter, DaemonClient } from '../src/index.js';

describe('DaemonClient', () => {
  let wss: WebSocketServer;
  let port: number;
  let wsUrl: string;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => {
      wss.on('listening', () => {
        const addr = wss.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
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

  it('connects to server and processes initial snapshot notification', async () => {
    const adapter = new MockAdapter();
    const client = new DaemonClient(adapter, { url: wsUrl });

    const initialSlots: SlotInfo[] = [
      { slotIndex: 1, status: AgentPeripheralStatus.IDLE },
      { slotIndex: 2, status: AgentPeripheralStatus.RUNNING, activeTool: 'bash' },
    ];

    wss.on('connection', (ws) => {
      const snapshot = createJsonRpcNotification(NOTIFICATION_SNAPSHOT, {
        slots: initialSlots,
        focusedSlot: 2,
      });
      ws.send(JSON.stringify(snapshot));
    });

    await client.start();

    // Wait for message delivery
    await new Promise((r) => setTimeout(r, 80));

    expect(client.isConnected()).toBe(true);
    expect(client.getFocusedSlot()).toBe(2);
    expect(client.getSlots()).toHaveLength(2);
    expect(adapter.getLastRenderedString()).toContain('F2:RUN');

    await client.stop();
    expect(client.isConnected()).toBe(false);
  });

  it('updates slot and focus when notifications arrive', async () => {
    const adapter = new MockAdapter();
    const client = new DaemonClient(adapter, { url: wsUrl });

    let serverWs: WebSocket | null = null;
    wss.on('connection', (ws) => {
      serverWs = ws;
    });

    await client.start();
    await new Promise((r) => setTimeout(r, 60));

    expect(serverWs).not.toBeNull();

    // Send slotUpdated
    const slotUpdate = createJsonRpcNotification(NOTIFICATION_SLOT_UPDATED, {
      slotIndex: 5,
      status: AgentPeripheralStatus.ERROR,
    });
    serverWs!.send(JSON.stringify(slotUpdate));

    // Send focusChanged
    const focusUpdate = createJsonRpcNotification(NOTIFICATION_FOCUS_CHANGED, {
      focusedSlot: 5,
    });
    serverWs!.send(JSON.stringify(focusUpdate));

    await new Promise((r) => setTimeout(r, 80));

    expect(client.getFocusedSlot()).toBe(5);
    const slot5 = client.getSlots().find((s) => s.slotIndex === 5);
    expect(slot5?.status).toBe(AgentPeripheralStatus.ERROR);
    expect(adapter.getLastRenderedString()).toContain('F5:ERR');

    await client.stop();
  });

  it('translates hardware inputs to JSON-RPC requests on the server', async () => {
    const adapter = new MockAdapter();
    const client = new DaemonClient(adapter, { url: wsUrl });

    const receivedRequests: Array<{ method: string; params: unknown }> = [];

    wss.on('connection', (ws) => {
      ws.on('message', (msg) => {
        const parsed = JSON.parse(msg.toString());
        receivedRequests.push({ method: parsed.method, params: parsed.params });
        // Return success response
        const resp = createJsonRpcSuccessResponse(parsed.id, { success: true });
        ws.send(JSON.stringify(resp));
      });
    });

    await client.start();
    await new Promise((r) => setTimeout(r, 60));

    // Simulate keypress -> switchFocus
    adapter.simulateKeyPress(4);
    // Simulate knob -> setBrainpower
    adapter.simulateKnob('stepUp');
    // Simulate option -> selectOption
    adapter.simulateOption('ACCEPT');
    // Simulate abort -> abort
    adapter.simulateAbort();

    await new Promise((r) => setTimeout(r, 100));

    expect(receivedRequests).toHaveLength(4);
    expect(receivedRequests[0]).toEqual({ method: METHOD_SWITCH_FOCUS, params: { slotIndex: 4 } });
    expect(receivedRequests[1]).toEqual({ method: METHOD_SET_BRAINPOWER, params: { slotIndex: 1, direction: 'stepUp' } });
    expect(receivedRequests[2]).toEqual({ method: METHOD_SELECT_OPTION, params: { slotIndex: 1, optionIndex: 0, action: 'ACCEPT' } });
    expect(receivedRequests[3]).toEqual({ method: METHOD_ABORT, params: { slotIndex: 1 } });

    await client.stop();
  });

  it('reconnects automatically with backoff when connection is severed', async () => {
    const adapter = new MockAdapter();
    const client = new DaemonClient(adapter, {
      url: wsUrl,
      initialReconnectDelayMs: 50,
      maxReconnectDelayMs: 200,
    });

    let connectionCount = 0;
    wss.on('connection', (ws) => {
      connectionCount++;
      if (connectionCount === 1) {
        // Disconnect immediately to trigger reconnect
        setTimeout(() => ws.terminate(), 20);
      }
    });

    await client.start();

    // Wait enough for disconnect and auto-reconnect
    await new Promise((r) => setTimeout(r, 250));

    expect(connectionCount).toBeGreaterThanOrEqual(2);
    expect(client.isConnected()).toBe(true);

    await client.stop();
  });
});
