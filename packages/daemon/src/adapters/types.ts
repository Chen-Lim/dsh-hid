import type {
  SlotInfo,
  BrainpowerDirection,
  OptionAction,
} from '@dsh-hid/protocol';

/**
 * Events originated from physical hardware inputs (keys, encoders, buttons).
 */
export type HardwareEvent =
  | { type: 'switchFocus'; slotIndex: number }
  | { type: 'knob'; action: BrainpowerDirection | 'press' }
  | { type: 'option'; action: OptionAction }
  | { type: 'abort' };

export type HardwareEventListener = (event: HardwareEvent) => void;

/**
 * Abstract interface for peripheral hardware adapters.
 */
export interface HardwareAdapter {
  /** Human-readable adapter identifier (e.g. 'mock', 'nuphy-air-v3', 'via-rawhid') */
  readonly name: string;

  /** Initialize connection to the hardware device or simulator */
  connect(): Promise<void>;

  /** Clean up and disconnect from the hardware device */
  disconnect(): Promise<void>;

  /** Synchronize and render slot states and focus indicator to the hardware */
  renderSlots(slots: SlotInfo[], focusedSlot: number): Promise<void>;

  /** Register a callback for incoming hardware events. Returns an unregister function. */
  onEvent(listener: HardwareEventListener): () => void;
}
