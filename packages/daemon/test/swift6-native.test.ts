import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  AgentPeripheralStatus,
  NOTIFICATION_SNAPSHOT,
  NOTIFICATION_SLOT_UPDATED,
  NOTIFICATION_FOCUS_CHANGED,
  NOTIFICATION_SERVER_SHUTTING_DOWN,
  METHOD_SWITCH_FOCUS,
  METHOD_SET_BRAINPOWER,
  METHOD_SELECT_OPTION,
  METHOD_ABORT,
  createJsonRpcNotification,
  createJsonRpcSuccessResponse,
  type SlotInfo,
} from '@dsh-hid/protocol';

const __dirname = dirname(fileURLToPath(import.meta.url));
const daemonRoot = resolve(__dirname, '..');
const swiftSourcePath = resolve(daemonRoot, 'native/DshDaemon.swift');
const swiftBinaryPath = resolve(daemonRoot, 'bin/dsh-daemon');

function ensureSwiftBinaryCompiled(): void {
  mkdirSync(resolve(daemonRoot, 'bin'), { recursive: true });
  if (!existsSync(swiftBinaryPath)) {
    execFileSync(
      'swiftc',
      ['-swift-version', '6', '-strict-concurrency=complete', '-O', swiftSourcePath, '-o', swiftBinaryPath],
      { stdio: 'inherit' },
    );
  }
}

class NativeProcessHarness {
  readonly proc: ChildProcessWithoutNullStreams;
  private readonly lines: Array<Record<string, unknown>> = [];
  private readonly waiters: Array<(msg: Record<string, unknown>) => boolean> = [];

  constructor(args: string[] = []) {
    this.proc = spawn(swiftBinaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        this.lines.push(parsed);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          if (this.waiters[i]!(parsed)) {
            this.waiters.splice(i, 1);
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    });
  }

  sendJsonl(payload: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  waitForMessage(
    predicate: (msg: Record<string, unknown>) => boolean,
    timeoutMs = 3000,
  ): Promise<Record<string, unknown>> {
    const existing = this.lines.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        rejectPromise(new Error(`Timed out waiting for native daemon stdout message after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push((msg) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          resolvePromise(msg);
          return true;
        }
        return false;
      });
    });
  }

  async close(): Promise<void> {
    if (this.proc.exitCode !== null) return;
    this.sendJsonl({ id: 9999, op: 'quit' });
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        this.proc.kill('SIGTERM');
        resolvePromise();
      }, 1500);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
}

describe('Swift 6 Native S4 Daemon (DshDaemon.swift) Cross-Verification', () => {
  let wss: WebSocketServer;
  let wsUrl: string;

  beforeAll(() => {
    ensureSwiftBinaryCompiled();
  });

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolvePromise) => {
      wss.on('listening', () => {
        const addr = wss.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        wsUrl = `ws://127.0.0.1:${port}/peripheral/v1`;
        resolvePromise();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolvePromise) => {
      wss.close(() => resolvePromise());
    });
  });

  it('renders 84-key Codex Micro layout and NEEDS_INPUT quick-response keys via JSONL dshRender', async () => {
    const harness = new NativeProcessHarness();
    try {
      harness.sendJsonl({
        id: 1,
        op: 'dshRender',
        dryRun: true,
        focusedSlot: 2,
        pulseFocused: false,
        slots: [
          { slotIndex: 1, sessionId: 's1', status: 'RUNNING' },
          {
            slotIndex: 2,
            sessionId: 's2',
            status: 'NEEDS_INPUT',
            question: {
              prompt: 'Allow command execution?',
              options: ['ACCEPT', 'REJECT', 'ALWAYS_ALLOW'],
            },
          },
          { slotIndex: 3, sessionId: 's3', status: 'COMPLETED' },
          { slotIndex: 4, sessionId: 's4', status: 'ERROR' },
        ],
      });

      const res = await harness.waitForMessage((m) => m.id === 1);
      expect(res.ok).toBe(true);
      const result = res.result as { colors: string[]; ledCount: number };
      expect(result.ledCount).toBe(84);
      expect(result.colors).toHaveLength(84);

      // F1..F4 correspond to LED indices 1..4
      expect(result.colors[1]).toBe('#304ffe'); // RUNNING
      expect(result.colors[2]).toBe('#ff6d00'); // NEEDS_INPUT (focused)
      expect(result.colors[3]).toBe('#00ff4c'); // COMPLETED
      expect(result.colors[4]).toBe('#ff0033'); // ERROR

      // NEEDS_INPUT quick-response decision keys:
      // Enter (57) and Y (36) -> #00ff4c (ACCEPT)
      expect(result.colors[57]).toBe('#00ff4c');
      expect(result.colors[36]).toBe('#00ff4c');
      // Esc (0) and N (65) -> #ff0033 (REJECT)
      expect(result.colors[0]).toBe('#ff0033');
      expect(result.colors[65]).toBe('#ff0033');
      // Number keys 1, 2, 3 (indices 16, 17, 18) -> #ff6d00
      expect(result.colors[16]).toBe('#ff6d00');
      expect(result.colors[17]).toBe('#ff6d00');
      expect(result.colors[18]).toBe('#ff6d00');
      // Unmapped reserved slot 83 -> #000000
      expect(result.colors[83]).toBe('#000000');
    } finally {
      await harness.close();
    }
  });

  it('connects over WebSocket JSON-RPC 2.0, synchronizes slot states, and dispatches bidirectional RPC commands', async () => {
    let serverWs: WebSocket | null = null;
    const receivedRpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];

    wss.on('connection', (ws) => {
      serverWs = ws;
      ws.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString()) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
        };
        receivedRpcCalls.push({ method: parsed.method, params: parsed.params });
        ws.send(JSON.stringify(createJsonRpcSuccessResponse(parsed.id, { ok: true })));
      });

      const initialSlots: SlotInfo[] = [
        { slotIndex: 1, sessionId: 'sess-1', status: AgentPeripheralStatus.RUNNING },
        {
          slotIndex: 2,
          sessionId: 'sess-2',
          status: AgentPeripheralStatus.NEEDS_INPUT,
          question: {
            prompt: 'Approve file write?',
            options: ['ACCEPT', 'REJECT'],
          },
        },
      ];
      ws.send(
        JSON.stringify(
          createJsonRpcNotification(NOTIFICATION_SNAPSHOT, {
            slots: initialSlots,
            focusedSlot: 1,
          }),
        ),
      );
    });

    const harness = new NativeProcessHarness(['--ws', wsUrl]);
    try {
      // 1. Wait for initial peripheral/snapshot sync
      const firstSync = await harness.waitForMessage(
        (m) => m.event === 'dshStateSynced' && m.focusedSlot === 1 && m.activeSlotCount === 2,
      );
      expect(firstSync.sideChanged).toBe(true);

      // 2. Server switches focus to Slot 2 (which is NEEDS_INPUT)
      serverWs!.send(
        JSON.stringify(
          createJsonRpcNotification(NOTIFICATION_FOCUS_CHANGED, {
            focusedSlot: 2,
          }),
        ),
      );
      await harness.waitForMessage((m) => m.event === 'dshStateSynced' && m.focusedSlot === 2);

      // Inspect live rendered frame inside the Swift 6 daemon
      harness.sendJsonl({ id: 10, op: 'dshState' });
      const stateRes = await harness.waitForMessage((m) => m.id === 10);
      expect(stateRes.ok).toBe(true);
      const dshState = stateRes.result as {
        focusedSlot: number;
        activeSlotCount: number;
        colors: string[];
      };
      expect(dshState.focusedSlot).toBe(2);
      expect(dshState.colors[1]).toBe('#304ffe'); // F1 = RUNNING
      expect(dshState.colors[2]).toBe('#ff6d00'); // F2 = NEEDS_INPUT
      expect(dshState.colors[57]).toBe('#00ff4c'); // Enter highlighted for approval

      // 3. Trigger outgoing JSON-RPC 2.0 requests from the Swift 6 daemon to the Server
      harness.sendJsonl({ id: 11, op: 'dshSendRpc', rpc: 'selectOption', action: 'REJECT' });
      await harness.waitForMessage((m) => m.id === 11 && m.ok === true);

      harness.sendJsonl({ id: 12, op: 'dshSendRpc', rpc: 'switchFocus', slotIndex: 1 });
      await harness.waitForMessage((m) => m.id === 12 && m.ok === true);

      harness.sendJsonl({ id: 13, op: 'dshSendRpc', rpc: 'setBrainpower', direction: 'stepUp', slotIndex: 1 });
      await harness.waitForMessage((m) => m.id === 13 && m.ok === true);

      harness.sendJsonl({ id: 14, op: 'dshSendRpc', rpc: 'abort', slotIndex: 1 });
      await harness.waitForMessage((m) => m.id === 14 && m.ok === true);

      // Wait for all 4 RPC responses to be acknowledged
      await harness.waitForMessage((m) => m.event === 'dshRpcResponse' && m.id === 4);

      expect(receivedRpcCalls).toEqual([
        {
          method: METHOD_SELECT_OPTION,
          params: { slotIndex: 2, optionIndex: 1, action: 'REJECT' },
        },
        {
          method: METHOD_SWITCH_FOCUS,
          params: { slotIndex: 1 },
        },
        {
          method: METHOD_SET_BRAINPOWER,
          params: { slotIndex: 1, direction: 'stepUp' },
        },
        {
          method: METHOD_ABORT,
          params: { slotIndex: 1 },
        },
      ]);

      // 4. Server sends peripheral/slotUpdated for Slot 1 -> COMPLETED
      serverWs!.send(
        JSON.stringify(
          createJsonRpcNotification(NOTIFICATION_SLOT_UPDATED, {
            slotIndex: 1,
            sessionId: 'sess-1',
            status: AgentPeripheralStatus.COMPLETED,
          }),
        ),
      );
      await harness.waitForMessage(
        (m) => m.event === 'dshStateSynced' && m.focusedSlot === 2 && m.sideChanged === false,
      );

      // 5. Server sends peripheral/serverShuttingDown
      serverWs!.send(JSON.stringify(createJsonRpcNotification(NOTIFICATION_SERVER_SHUTTING_DOWN, {})));
      await harness.waitForMessage((m) => m.event === 'dshServerShuttingDown');
    } finally {
      await harness.close();
    }
  });
});
