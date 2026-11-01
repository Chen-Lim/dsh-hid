import { describe, it, expect, vi } from 'vitest';
import { AgentPeripheralStatus } from '@dsh-hid/protocol';
import { MockAdapter } from '../src/index.js';

describe('MockAdapter', () => {
  it('connects and disconnects cleanly', async () => {
    const adapter = new MockAdapter();
    expect(adapter.isConnected()).toBe(false);

    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);

    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it('renders 12 slots, focus and status grid into formatted string', async () => {
    const adapter = new MockAdapter();
    await adapter.connect();

    await adapter.renderSlots(
      [
        { slotIndex: 1, status: AgentPeripheralStatus.IDLE },
        { slotIndex: 2, status: AgentPeripheralStatus.RUNNING, activeTool: 'bash' },
        {
          slotIndex: 3,
          status: AgentPeripheralStatus.NEEDS_INPUT,
          question: { prompt: 'Execute rm -rf?', options: ['Yes', 'No'] },
        },
      ],
      2,
    );

    const rendered = adapter.getLastRenderedString();
    expect(rendered).toContain('MockAdapter');
    expect(rendered).toContain('F1:IDL');
    expect(rendered).toContain('F2:RUN');
    expect(rendered).toContain('F3:ASK');
    expect(rendered).toContain('Focus: Slot F2 (RUNNING)');
    expect(rendered).toContain('Execute rm -rf?');
  });

  it('dispatches simulated hardware inputs to registered listeners', async () => {
    const adapter = new MockAdapter();
    await adapter.connect();

    const listener = vi.fn();
    const unsubscribe = adapter.onEvent(listener);

    adapter.simulateKeyPress(4);
    expect(listener).toHaveBeenCalledWith({ type: 'switchFocus', slotIndex: 4 });

    adapter.simulateKnob('stepUp');
    expect(listener).toHaveBeenCalledWith({ type: 'knob', action: 'stepUp' });

    adapter.simulateOption('ACCEPT');
    expect(listener).toHaveBeenCalledWith({ type: 'option', action: 'ACCEPT' });

    adapter.simulateAbort();
    expect(listener).toHaveBeenCalledWith({ type: 'abort' });

    unsubscribe();
    adapter.simulateKeyPress(5);
    expect(listener).toHaveBeenCalledTimes(4);
  });
});
