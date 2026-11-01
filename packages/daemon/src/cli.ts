#!/usr/bin/env node

/**
 * CLI Entrypoint for DeepSeek Harness Physical Peripheral Daemon.
 */

import { DEFAULT_WS_URL } from '@dsh-hid/protocol';
import { DaemonClient } from './client.js';
import { MockAdapter } from './adapters/mock.js';
import { NuphyV3Adapter } from './adapters/nuphy.js';
import { ViaRawhidAdapter } from './adapters/via.js';
import type { HardwareAdapter } from './adapters/types.js';

interface CliArgs {
  adapter: 'mock' | 'nuphy' | 'via';
  url: string;
  help: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  let adapter: 'mock' | 'nuphy' | 'via' = 'mock';
  let url = DEFAULT_WS_URL;
  let help = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('--adapter=')) {
      const val = arg.slice('--adapter='.length).toLowerCase();
      if (val === 'mock' || val === 'nuphy' || val === 'via') {
        adapter = val;
      } else {
        console.warn(`[dsh-daemon] Unknown adapter '${val}', falling back to 'mock'`);
      }
    } else if (arg.startsWith('--url=')) {
      url = arg.slice('--url='.length);
    }
  }

  return { adapter, url, help };
}

export function createAdapter(type: 'mock' | 'nuphy' | 'via'): HardwareAdapter {
  switch (type) {
    case 'nuphy':
      return new NuphyV3Adapter();
    case 'via':
      return new ViaRawhidAdapter();
    case 'mock':
    default:
      return new MockAdapter({ interactiveOutput: true });
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(`
DeepSeek Harness (DSH) Peripheral Hardware Daemon

Usage:
  dsh-daemon [options]

Options:
  --adapter=mock|nuphy|via   Hardware adapter to use (default: mock)
  --url=<ws_url>             DSH Peripheral Server WebSocket URL
                             (default: ${DEFAULT_WS_URL})
  -h, --help                 Show this help message
`);
    return;
  }

  console.log(`[dsh-daemon] Initializing with adapter '${args.adapter}'...`);
  console.log(`[dsh-daemon] Connecting to Peripheral Server at: ${args.url}`);

  const adapter = createAdapter(args.adapter);
  const client = new DaemonClient(adapter, { url: args.url });

  const shutdown = async (signal: string) => {
    console.log(`\n[dsh-daemon] Received ${signal}. Shutting down gracefully...`);
    await client.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await client.start();
  console.log('[dsh-daemon] Daemon started and running. Press Ctrl+C to terminate.');
}

// Auto-run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[dsh-daemon] Fatal error:', err);
    process.exit(1);
  });
}
