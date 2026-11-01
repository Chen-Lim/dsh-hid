import {
  AgentPeripheralStatus,
  type BrainpowerLevel,
  type SlotInfo,
  type SnapshotParams,
  MIN_SLOT_INDEX,
  MAX_SLOT_INDEX,
  TOTAL_SLOTS,
} from '@dsh-hid/protocol';

export interface SessionRouterOptions {
  totalSlots?: number;
}

interface InternalSlot extends SlotInfo {
  lastAccessedAt: number;
}

export type SlotUpdateListener = (slot: SlotInfo) => void;
export type FocusChangeListener = (focusedSlot: number, sessionId: string | null) => void;

/**
 * SessionRouter manages physical slot assignments (F1 - F12), focus tracking,
 * and LRU eviction for concurrent agent sessions in DeepSeek Harness.
 */
export class SessionRouter {
  private readonly totalSlots: number;
  private readonly slots: Map<number, InternalSlot> = new Map();
  private readonly overflowSessions: Set<string> = new Set();
  private focusedSlot: number = MIN_SLOT_INDEX;

  private readonly slotUpdateListeners: Set<SlotUpdateListener> = new Set();
  private readonly focusChangeListeners: Set<FocusChangeListener> = new Set();

  constructor(options?: SessionRouterOptions) {
    this.totalSlots = options?.totalSlots ?? TOTAL_SLOTS;
    this.initializeSlots();
  }

  private initializeSlots(): void {
    const now = Date.now();
    for (let i = MIN_SLOT_INDEX; i <= this.totalSlots; i++) {
      this.slots.set(i, {
        slotIndex: i,
        sessionId: null,
        status: AgentPeripheralStatus.INACTIVE,
        brainpower: 'medium',
        lastAccessedAt: now,
      });
    }
  }

  /**
   * Subscribes to slot update events.
   * Returns an unsubscribe function.
   */
  public onSlotUpdate(listener: SlotUpdateListener): () => void {
    this.slotUpdateListeners.add(listener);
    return () => this.slotUpdateListeners.delete(listener);
  }

  /**
   * Subscribes to focus change events.
   * Returns an unsubscribe function.
   */
  public onFocusChange(listener: FocusChangeListener): () => void {
    this.focusChangeListeners.add(listener);
    return () => this.focusChangeListeners.delete(listener);
  }

  private notifySlotUpdate(slot: SlotInfo): void {
    for (const listener of this.slotUpdateListeners) {
      try {
        listener(slot);
      } catch (err) {
        // Prevent listener failures from disrupting router state
        console.error('[SessionRouter] Error in slot update listener:', err);
      }
    }
  }

  private notifyFocusChange(focusedSlot: number, sessionId: string | null): void {
    for (const listener of this.focusChangeListeners) {
      try {
        listener(focusedSlot, sessionId);
      } catch (err) {
        console.error('[SessionRouter] Error in focus change listener:', err);
      }
    }
  }

  /**
   * Returns all active slot objects ordered by slotIndex (1 to totalSlots).
   */
  public getAllSlots(): SlotInfo[] {
    const result: SlotInfo[] = [];
    for (let i = MIN_SLOT_INDEX; i <= this.totalSlots; i++) {
      const internal = this.slots.get(i);
      if (internal) {
        result.push(this.sanitizeSlot(internal));
      }
    }
    return result;
  }

  /**
   * Returns a snapshot of the current state including focused slot and all slots.
   */
  public getSnapshot(): SnapshotParams {
    return {
      focusedSlot: this.focusedSlot,
      slots: this.getAllSlots(),
    };
  }

  /**
   * Retrieves a slot by its 1-based physical index.
   */
  public getSlot(slotIndex: number): SlotInfo | null {
    const internal = this.slots.get(slotIndex);
    return internal ? this.sanitizeSlot(internal) : null;
  }

  /**
   * Finds the slot assigned to a given session ID.
   */
  public getSlotBySessionId(sessionId: string): SlotInfo | null {
    for (const internal of this.slots.values()) {
      if (internal.sessionId === sessionId) {
        return this.sanitizeSlot(internal);
      }
    }
    return null;
  }

  /**
   * Gets the currently focused slot index.
   */
  public getFocusedSlot(): number {
    return this.focusedSlot;
  }

  /**
   * Allocates a physical slot for a session.
   * If the session is already allocated, returns the existing slot.
   * If all slots are occupied, evicts the least recently accessed non-focused slot via LRU.
   */
  public allocateSlot(
    sessionId: string,
    initialStatus: AgentPeripheralStatus = AgentPeripheralStatus.IDLE,
    brainpower: BrainpowerLevel = 'medium'
  ): SlotInfo {
    const now = Date.now();

    // 1. Check if already allocated
    for (const internal of this.slots.values()) {
      if (internal.sessionId === sessionId) {
        internal.lastAccessedAt = now;
        return this.sanitizeSlot(internal);
      }
    }

    // Remove from overflow set if previously overflowed
    this.overflowSessions.delete(sessionId);

    // 2. Find first inactive slot
    for (let i = MIN_SLOT_INDEX; i <= this.totalSlots; i++) {
      const internal = this.slots.get(i)!;
      if (!internal.sessionId || internal.status === AgentPeripheralStatus.INACTIVE) {
        internal.sessionId = sessionId;
        internal.status = initialStatus;
        internal.brainpower = brainpower;
        internal.activeTool = undefined;
        internal.question = undefined;
        internal.lastAccessedAt = now;

        const sanitized = this.sanitizeSlot(internal);
        this.notifySlotUpdate(sanitized);
        return sanitized;
      }
    }

    // 3. All slots occupied: LRU eviction (protect current focusedSlot)
    const candidates = Array.from(this.slots.values()).filter(
      (s) => s.slotIndex !== this.focusedSlot
    );

    // Prioritize evicting completed / error / idle before active ones
    const isInactiveState = (status: AgentPeripheralStatus) =>
      status === AgentPeripheralStatus.COMPLETED ||
      status === AgentPeripheralStatus.ERROR ||
      status === AgentPeripheralStatus.INACTIVE ||
      status === AgentPeripheralStatus.IDLE;

    candidates.sort((a, b) => {
      const aInactive = isInactiveState(a.status);
      const bInactive = isInactiveState(b.status);
      if (aInactive && !bInactive) return -1;
      if (!aInactive && bInactive) return 1;
      return a.lastAccessedAt - b.lastAccessedAt;
    });

    const targetSlot = candidates[0] ?? this.slots.get(this.focusedSlot)!;
    if (targetSlot.sessionId) {
      this.overflowSessions.add(targetSlot.sessionId);
    }

    targetSlot.sessionId = sessionId;
    targetSlot.status = initialStatus;
    targetSlot.brainpower = brainpower;
    targetSlot.activeTool = undefined;
    targetSlot.question = undefined;
    targetSlot.lastAccessedAt = now;

    const sanitized = this.sanitizeSlot(targetSlot);
    this.notifySlotUpdate(sanitized);
    return sanitized;
  }

  /**
   * Releases the slot allocated to the given session ID.
   * If an overflow session exists, automatically promotes the next session.
   */
  public releaseSession(sessionId: string): SlotInfo | null {
    for (const internal of this.slots.values()) {
      if (internal.sessionId === sessionId) {
        return this.releaseSlot(internal.slotIndex);
      }
    }
    this.overflowSessions.delete(sessionId);
    return null;
  }

  /**
   * Releases an explicit slot by index.
   */
  public releaseSlot(slotIndex: number): SlotInfo | null {
    const internal = this.slots.get(slotIndex);
    if (!internal) return null;

    internal.sessionId = null;
    internal.status = AgentPeripheralStatus.INACTIVE;
    internal.activeTool = undefined;
    internal.question = undefined;
    internal.lastAccessedAt = Date.now();

    // Check if an overflow session can be promoted
    if (this.overflowSessions.size > 0) {
      const [nextSessionId] = this.overflowSessions;
      this.overflowSessions.delete(nextSessionId);
      internal.sessionId = nextSessionId;
      internal.status = AgentPeripheralStatus.IDLE;
    }

    const sanitized = this.sanitizeSlot(internal);
    this.notifySlotUpdate(sanitized);

    // If focused slot is now inactive and has no session, focus still remains on the index
    if (this.focusedSlot === slotIndex) {
      this.notifyFocusChange(this.focusedSlot, internal.sessionId);
    }

    return sanitized;
  }

  /**
   * Switches the active focus to the specified slot index.
   * Returns true if successful, false if index is out of bounds.
   */
  public switchFocus(slotIndex: number): boolean {
    if (slotIndex < MIN_SLOT_INDEX || slotIndex > this.totalSlots) {
      return false;
    }

    if (this.focusedSlot === slotIndex) {
      return true;
    }

    this.focusedSlot = slotIndex;
    const current = this.slots.get(slotIndex);
    if (current) {
      current.lastAccessedAt = Date.now();
    }

    this.notifyFocusChange(this.focusedSlot, current?.sessionId ?? null);
    return true;
  }

  /**
   * Updates state attributes of a slot.
   */
  public updateSlot(
    slotIndex: number,
    patch: Partial<Omit<SlotInfo, 'slotIndex'>>
  ): SlotInfo | null {
    const internal = this.slots.get(slotIndex);
    if (!internal) return null;

    if (patch.status !== undefined) internal.status = patch.status;
    if (patch.brainpower !== undefined) internal.brainpower = patch.brainpower;
    if (patch.activeTool !== undefined) internal.activeTool = patch.activeTool;
    if (patch.question !== undefined) internal.question = patch.question;
    if (patch.sessionId !== undefined) internal.sessionId = patch.sessionId;
    internal.lastAccessedAt = Date.now();

    const sanitized = this.sanitizeSlot(internal);
    this.notifySlotUpdate(sanitized);
    return sanitized;
  }

  /**
   * Updates slot state by session ID.
   */
  public updateSlotBySessionId(
    sessionId: string,
    patch: Partial<Omit<SlotInfo, 'slotIndex' | 'sessionId'>>
  ): SlotInfo | null {
    const current = this.getSlotBySessionId(sessionId);
    if (!current) return null;
    return this.updateSlot(current.slotIndex, patch);
  }

  /**
   * Cleans internal metadata before exposing to public callers.
   */
  private sanitizeSlot(internal: InternalSlot): SlotInfo {
    return {
      slotIndex: internal.slotIndex,
      sessionId: internal.sessionId,
      status: internal.status,
      brainpower: internal.brainpower,
      activeTool: internal.activeTool,
      question: internal.question,
    };
  }

  /**
   * Returns the count of overflow sessions.
   */
  public getOverflowCount(): number {
    return this.overflowSessions.size;
  }
}
