import { describe, it, expect, vi, afterEach } from 'vitest';
import { DaemonManager } from '../src/daemon-manager.js';
import path from 'node:path';
import os from 'node:os';

describe('DaemonManager', () => {
  let manager: DaemonManager | null = null;

  afterEach(async () => {
    if (manager) {
      await manager.stop();
      manager = null;
    }
  });

  it('resolves native daemon command when binary exists', () => {
    manager = new DaemonManager({
      wsUrl: 'ws://127.0.0.1:45678/peripheral/v1',
    });

    const resolved = manager.resolveDaemonCommand();
    expect(resolved).not.toBeNull();
    expect(resolved?.args).toContain('--ws');
    expect(resolved?.args).toContain('ws://127.0.0.1:45678/peripheral/v1');
  });

  it('honors custom daemonPath and arguments', () => {
    const mockBin = path.resolve(os.homedir(), 'project/dsh-hid/packages/daemon/bin/dsh-daemon');
    manager = new DaemonManager({
      wsUrl: 'ws://127.0.0.1:45678/peripheral/v1',
      daemonPath: mockBin,
      daemonArgs: ['--test-flag'],
    });

    const resolved = manager.resolveDaemonCommand();
    expect(resolved).not.toBeNull();
    expect(resolved?.command).toBe(mockBin);
    expect(resolved?.args).toEqual(['--test-flag']);
  });

  it('reports not running before start', () => {
    manager = new DaemonManager({
      wsUrl: 'ws://127.0.0.1:45678/peripheral/v1',
      autoRestart: false,
    });
    expect(manager.isRunning()).toBe(false);
  });
});
