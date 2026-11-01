import { describe, it, expect } from 'vitest';
import { PLUGIN_NAME } from '../src/index.js';

describe('package sanity', () => {
  it('should export correct plugin name', () => {
    expect(PLUGIN_NAME).toBe('dsh-plugin-peripheral-server');
  });
});
