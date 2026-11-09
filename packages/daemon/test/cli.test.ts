import { describe, it, expect } from 'vitest';
import { parseArgs, createAdapter } from '../src/index.js';

describe('CLI Argument Parser and Adapter Factory', () => {
  it('parses default CLI arguments', () => {
    const args = parseArgs([]);
    expect(args.adapter).toBe('mock');
    expect(args.help).toBe(false);
    expect(args.url).toContain('45679');
  });

  it('parses custom adapter and url options', () => {
    const args = parseArgs(['--adapter=nuphy', '--url=ws://localhost:9999/test']);
    expect(args.adapter).toBe('nuphy');
    expect(args.url).toBe('ws://localhost:9999/test');

    const viaArgs = parseArgs(['--adapter=via']);
    expect(viaArgs.adapter).toBe('via');

    const helpArgs = parseArgs(['--help']);
    expect(helpArgs.help).toBe(true);
  });

  it('creates corresponding adapter instances', () => {
    const mock = createAdapter('mock');
    expect(mock.name).toBe('mock');

    const nuphy = createAdapter('nuphy');
    expect(nuphy.name).toBe('nuphy-air-v3');

    const via = createAdapter('via');
    expect(via.name).toBe('via-rawhid');
  });
});
