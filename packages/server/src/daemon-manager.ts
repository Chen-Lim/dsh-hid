import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export interface DaemonManagerOptions {
  wsUrl: string;
  daemonPath?: string;
  daemonArgs?: string[];
  autoRestart?: boolean;
  restartDelayMs?: number;
  maxConsecutiveRestarts?: number;
}

export interface ResolvedDaemonCommand {
  command: string;
  args: string[];
  isNative: boolean;
}

export class DaemonManager {
  private readonly wsUrl: string;
  private readonly customPath?: string;
  private readonly customArgs?: string[];
  private readonly autoRestart: boolean;
  private readonly restartDelayMs: number;
  private readonly maxConsecutiveRestarts: number;

  private child: ChildProcess | null = null;
  private isStopping = false;
  private stopPromise: Promise<void> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private consecutiveRestarts = 0;
  private lastStartTime = 0;

  private readonly onProcessExit = () => {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  };

  constructor(options: DaemonManagerOptions) {
    this.wsUrl = options.wsUrl;
    this.customPath = options.daemonPath;
    this.customArgs = options.daemonArgs;
    this.autoRestart = options.autoRestart ?? true;
    this.restartDelayMs = options.restartDelayMs ?? 2000;
    this.maxConsecutiveRestarts = options.maxConsecutiveRestarts ?? 5;

    // Register process-level cleanup handlers for when Electron/Node exits
    process.once('exit', this.onProcessExit);
    process.once('SIGINT', this.onProcessExit);
    process.once('SIGTERM', this.onProcessExit);
    process.once('beforeExit', this.onProcessExit);
  }

  /**
   * Resolves the most suitable daemon executable or script available on the system.
   */
  public resolveDaemonCommand(): ResolvedDaemonCommand | null {
    // 1. Explicitly configured path
    if (this.customPath && fs.existsSync(this.customPath)) {
      const isNative = !this.customPath.endsWith('.js') && !this.customPath.endsWith('.mjs');
      return {
        command: isNative ? this.customPath : process.execPath,
        args: isNative
          ? (this.customArgs ?? ['--ws', this.wsUrl])
          : [this.customPath, ...(this.customArgs ?? [`--url=${this.wsUrl}`, '--adapter=nuphy'])],
        isNative,
      };
    }

    // 2. Environment variable override
    const envBin = process.env.DSH_DAEMON_BIN;
    if (envBin && fs.existsSync(envBin)) {
      return {
        command: envBin,
        args: this.customArgs ?? ['--ws', this.wsUrl],
        isNative: true,
      };
    }

    const currentDir = typeof __dirname !== 'undefined'
      ? __dirname
      : path.dirname(fileURLToPath(import.meta.url));

    // 3. Search candidate locations for Swift 6 native daemon binary
    const homeDir = os.homedir();
    const nativeCandidates = [
      path.resolve(homeDir, 'project/dsh-hid/packages/daemon/bin/dsh-daemon'),
      path.resolve(process.cwd(), 'packages/daemon/bin/dsh-daemon'),
      path.resolve(currentDir, '../../daemon/bin/dsh-daemon'),
      path.resolve(currentDir, '../../../daemon/bin/dsh-daemon'),
      path.resolve(currentDir, '../../../../packages/daemon/bin/dsh-daemon'),
    ];

    for (const candidate of nativeCandidates) {
      if (fs.existsSync(candidate)) {
        return {
          command: candidate,
          args: this.customArgs ?? ['--ws', this.wsUrl],
          isNative: true,
        };
      }
    }

    // 4. Fallback candidate locations for Node.js CLI daemon script
    const scriptCandidates = [
      path.resolve(homeDir, 'project/dsh-hid/packages/daemon/dist/cli.js'),
      path.resolve(process.cwd(), 'packages/daemon/dist/cli.js'),
      path.resolve(currentDir, '../../daemon/dist/cli.js'),
      path.resolve(currentDir, '../../../daemon/dist/cli.js'),
      path.resolve(currentDir, '../../../../packages/daemon/dist/cli.js'),
    ];

    for (const candidate of scriptCandidates) {
      if (fs.existsSync(candidate)) {
        return {
          command: process.execPath,
          args: [candidate, `--url=${this.wsUrl}`, '--adapter=nuphy', ...(this.customArgs ?? [])],
          isNative: false,
        };
      }
    }

    return null;
  }

  /**
   * Starts the daemon child process if not already running.
   */
  public async start(): Promise<boolean> {
    if (this.stopPromise) {
      await this.stopPromise;
    }

    if (this.child && !this.child.killed) {
      return true;
    }

    const resolved = this.resolveDaemonCommand();
    if (!resolved) {
      console.warn('[dsh-plugin-peripheral-server] No dsh-daemon executable found; auto-daemon skipped.');
      return false;
    }

    this.isStopping = false;
    this.lastStartTime = Date.now();

    try {
      // Gracefully terminate any lingering orphaned daemon from a previous crashed run
      try {
        const { execSync } = await import('node:child_process');
        execSync("pkill -TERM -f 'dsh-daemon --ws' || true", { stdio: 'ignore' });
      } catch {
        // ignore
      }

      console.log(
        `[dsh-plugin-peripheral-server] Spawning hardware daemon: ${resolved.command} ${resolved.args.join(' ')}`
      );

      const child = spawn(resolved.command, resolved.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        env: {
          ...process.env,
        },
      });

      this.child = child;

      child.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString('utf8').trim().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            console.log(`[dsh-daemon] ${line}`);
          }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString('utf8').trim().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            console.warn(`[dsh-daemon:stderr] ${line}`);
          }
        }
      });

      child.on('error', (err: Error) => {
        console.error('[dsh-plugin-peripheral-server] Hardware daemon process error:', err);
      });

      child.on('exit', (code: number | null, signal: string | null) => {
        this.child = null;
        console.log(
          `[dsh-plugin-peripheral-server] Hardware daemon exited with code=${code}, signal=${signal}`
        );

        if (!this.isStopping && this.autoRestart) {
          this.scheduleRestart();
        }
      });

      return true;
    } catch (err) {
      console.error('[dsh-plugin-peripheral-server] Failed to spawn hardware daemon:', err);
      return false;
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const now = Date.now();
    if (now - this.lastStartTime < 10000) {
      this.consecutiveRestarts++;
    } else {
      this.consecutiveRestarts = 1;
    }

    if (this.consecutiveRestarts > this.maxConsecutiveRestarts) {
      console.error(
        `[dsh-plugin-peripheral-server] Daemon failed repeatedly (${this.consecutiveRestarts} times in short period). Stopping automatic restart.`
      );
      return;
    }

    console.log(
      `[dsh-plugin-peripheral-server] Scheduling daemon restart in ${this.restartDelayMs}ms (attempt ${this.consecutiveRestarts}/${this.maxConsecutiveRestarts})...`
    );

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.isStopping) {
        void this.start();
      }
    }, this.restartDelayMs);
  }

  /**
   * Stops the hardware daemon gracefully.
   */
  public async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopPromise = this.doStop();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async doStop(): Promise<void> {
    this.isStopping = true;

    // Unbind global process listeners to avoid memory leaks
    process.off('exit', this.onProcessExit);
    process.off('SIGINT', this.onProcessExit);
    process.off('SIGTERM', this.onProcessExit);
    process.off('beforeExit', this.onProcessExit);

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = null;

    if (child.killed) {
      return;
    }

    return new Promise((resolve) => {
      let resolved = false;

      const finish = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      child.once('exit', finish);

      // Send SIGTERM to give daemon time to restore lighting profile
      try {
        child.kill('SIGTERM');
      } catch {
        finish();
        return;
      }

      // Fast hard kill fallback after 1.2 seconds if not gracefully exited,
      // strictly respecting the Host shutdown deadline (PROCESS_SHUTDOWN_TIMEOUT_MS = 5000ms).
      const forceKillTimer = setTimeout(() => {
        try {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        } catch {
          // ignore
        }
        finish();
      }, 1200);
      forceKillTimer.unref();

      child.once('exit', () => {
        clearTimeout(forceKillTimer);
        finish();
      });
    });
  }

  public isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }

  public getChildProcess(): ChildProcess | null {
    return this.child;
  }
}
