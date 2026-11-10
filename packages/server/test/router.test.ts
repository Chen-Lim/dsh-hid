import { describe, it, expect, vi } from 'vitest';
import {
  AgentPeripheralStatus,
  MIN_SLOT_INDEX,
  TOTAL_SLOTS,
} from '@dsh-hid/protocol';
import { SessionRouter } from '../src/router.js';

describe('SessionRouter', () => {
  it('initializes 12 inactive slots with focused slot at 1', () => {
    const router = new SessionRouter();
    const snapshot = router.getSnapshot();

    expect(snapshot.focusedSlot).toBe(1);
    expect(snapshot.slots).toHaveLength(TOTAL_SLOTS);
    expect(snapshot.slots[0].slotIndex).toBe(1);
    expect(snapshot.slots[0].status).toBe(AgentPeripheralStatus.INACTIVE);
    expect(snapshot.slots[0].sessionId).toBeNull();
  });

  it('allocates the first inactive slot for a new session and fires listener', () => {
    const router = new SessionRouter();
    const slotUpdateListener = vi.fn();
    router.onSlotUpdate(slotUpdateListener);

    const slot1 = router.allocateSlot('session-1', AgentPeripheralStatus.RUNNING, 'high');

    expect(slot1.slotIndex).toBe(1);
    expect(slot1.sessionId).toBe('session-1');
    expect(slot1.status).toBe(AgentPeripheralStatus.RUNNING);
    expect(slot1.brainpower).toBe('high');
    expect(slotUpdateListener).toHaveBeenCalledTimes(1);
    expect(slotUpdateListener).toHaveBeenCalledWith(slot1);

    const slot2 = router.allocateSlot('session-2', AgentPeripheralStatus.IDLE);
    expect(slot2.slotIndex).toBe(2);
    expect(slot2.sessionId).toBe('session-2');
  });

  it('returns existing slot when allocating already tracked session', () => {
    const router = new SessionRouter();
    const slotA = router.allocateSlot('session-repeat', AgentPeripheralStatus.IDLE);
    const slotB = router.allocateSlot('session-repeat', AgentPeripheralStatus.RUNNING);

    expect(slotA.slotIndex).toBe(slotB.slotIndex);
    expect(slotB.sessionId).toBe('session-repeat');
  });

  it('updates slot by slotIndex and sessionId', () => {
    const router = new SessionRouter();
    router.allocateSlot('session-target', AgentPeripheralStatus.IDLE);

    const updated = router.updateSlotBySessionId('session-target', {
      status: AgentPeripheralStatus.NEEDS_INPUT,
      activeTool: 'bash',
      question: { prompt: 'Allow execution?', options: ['Yes', 'No'] },
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe(AgentPeripheralStatus.NEEDS_INPUT);
    expect(updated?.activeTool).toBe('bash');
    expect(updated?.question?.options).toEqual(['Yes', 'No']);

    // Directly update by index
    const updatedByIndex = router.updateSlot(1, { status: AgentPeripheralStatus.COMPLETED });
    expect(updatedByIndex?.status).toBe(AgentPeripheralStatus.COMPLETED);
  });

  it('switches focus and emits focus change event', () => {
    const router = new SessionRouter();
    router.allocateSlot('session-focus', AgentPeripheralStatus.IDLE);
    const focusListener = vi.fn();
    router.onFocusChange(focusListener);

    const ok = router.switchFocus(2);
    expect(ok).toBe(true);
    expect(router.getFocusedSlot()).toBe(2);
    expect(focusListener).toHaveBeenCalledWith(2, null);

    // Out of bounds focus switch should fail
    expect(router.switchFocus(0)).toBe(false);
    expect(router.switchFocus(13)).toBe(false);
  });

  it('releases session and slot correctly', () => {
    const router = new SessionRouter();
    router.allocateSlot('sess-1', AgentPeripheralStatus.RUNNING);
    router.allocateSlot('sess-2', AgentPeripheralStatus.RUNNING);

    const released = router.releaseSession('sess-1');
    expect(released?.slotIndex).toBe(1);
    expect(released?.status).toBe(AgentPeripheralStatus.INACTIVE);
    expect(released?.sessionId).toBeNull();

    expect(router.getSlotBySessionId('sess-1')).toBeNull();
  });

  it('handles 12-slot exhaustion via LRU and protects focused slot', () => {
    const router = new SessionRouter();

    // Fill all 12 slots
    for (let i = 1; i <= 12; i++) {
      router.allocateSlot(`session-${i}`, AgentPeripheralStatus.RUNNING);
    }
    expect(router.getAllSlots().every((s) => s.sessionId !== null)).toBe(true);

    // Focus slot 1
    router.switchFocus(1);

    // Make slot 2 accessed more recently than slot 3
    router.updateSlot(2, { status: AgentPeripheralStatus.RUNNING });

    // Mark slot 3 as completed (inactive category)
    router.updateSlot(3, { status: AgentPeripheralStatus.COMPLETED });

    // Allocate 13th session - slot 3 should be evicted first due to inactive status + LRU
    const slot13 = router.allocateSlot('session-13', AgentPeripheralStatus.IDLE);
    expect(slot13.slotIndex).toBe(3);
    expect(slot13.sessionId).toBe('session-13');
    expect(router.getOverflowCount()).toBe(1);

    // Slot 1 (focused) must remain untouched
    expect(router.getSlot(1)?.sessionId).toBe('session-1');

    // When releasing slot 3, overflow session should be promoted
    const promoted = router.releaseSlot(3);
    expect(promoted?.sessionId).toBe('session-3');
    expect(router.getOverflowCount()).toBe(0);
  });

  it('bindSlot explicitly pins session and migrates from old slot', () => {
    const router = new SessionRouter();
    router.allocateSlot('sess-test', AgentPeripheralStatus.IDLE);
    expect(router.getSlot(1)?.sessionId).toBe('sess-test');

    // Bind sess-test to slot 5 with title
    const bound = router.bindSlot(5, 'sess-test', 'My Pinned Session', true);
    expect(bound?.slotIndex).toBe(5);
    expect(bound?.sessionId).toBe('sess-test');
    expect(bound?.sessionTitle).toBe('My Pinned Session');
    expect(bound?.pinned).toBe(true);

    // Old slot 1 must be automatically released (auto-migrated)
    expect(router.getSlot(1)?.sessionId).toBeNull();
    expect(router.getSlot(1)?.status).toBe(AgentPeripheralStatus.INACTIVE);

    // Releasing slot 5 clears pinned status and title
    const released = router.releaseSlot(5);
    expect(released?.sessionId).toBeNull();
    expect(released?.pinned).toBe(false);
    expect(released?.sessionTitle).toBeUndefined();
  });

  it('pinned slots are protected from LRU eviction', () => {
    const router = new SessionRouter();
    for (let i = 1; i <= 12; i++) {
      router.allocateSlot(`session-${i}`, AgentPeripheralStatus.IDLE);
    }
    router.switchFocus(1);

    // Pin slot 2
    router.bindSlot(2, 'session-pinned', 'Pinned Work', true);

    // Slot 3 is completed and not pinned
    router.updateSlot(3, { status: AgentPeripheralStatus.COMPLETED });

    // Allocate 13th session - slot 3 should be evicted, slot 2 must be protected
    const newSlot = router.allocateSlot('session-new', AgentPeripheralStatus.IDLE);
    expect(newSlot.slotIndex).toBe(3);
    expect(router.getSlot(2)?.sessionId).toBe('session-pinned');
    expect(router.getSlot(2)?.pinned).toBe(true);
  });
});
