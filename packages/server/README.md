# dsh-plugin-peripheral-server

English | [中文](README.zh.md)

Official DeepSeek Harness (DSH) Cordis peripheral bridge plugin.

Runs inside the DSH host runtime, exposing agent lifecycle, state transitions, slot routing, and human-in-the-loop interaction decisions to external hardware daemons over a lightweight local WebSocket interface.

---

## Key Features

- **Pure TypeScript Implementation**: Contains no native C++ extensions, guaranteeing zero crash propagation and high stability for the DSH host environment.
- **Official DSH Internationalization (i18n)**:
  - Aligned with official DSH i18n architecture, providing full bilingual support for English (`en`) and Chinese (`zh` / `zh-CN`).
  - Seamlessly registers with `ctx.locale` for real-time reactivity in the sidebar and panel without requiring a page refresh.
  - Exposes standardized `locale/*.json` metadata for DSH Plugin Manager discovery.
- **F1-F12 Physical Key Slot Routing (`SessionRouter`)**:
  - Automatically maps active agent sessions to slots 1 through 12.
  - Focus tracking with slot eviction protection for active focused sessions.
  - LRU replacement with overflow pool when concurrent sessions exceed 12 slots.
- **DSH Core Lifecycle & Event Subscriptions**:
  - Subscribes to `agent/created`, `agent/disposed`, and `agent/status`.
  - Deep Human-In-The-Loop approval integration (`interaction/user-questions`) projecting high-risk tool decisions onto physical keys.
  - Real-time active tool execution tracking (`agent/tool-start`, `agent/tool-end`).
- **JSON-RPC 2.0 WebSocket Service (`PeripheralWsServer`)**:
  - Bound exclusively to loopback (`127.0.0.1:45678`) to prevent external network exposure.
  - Immediate full snapshot push on handshake (`peripheral/snapshot`).
  - Incremental state broadcasts (`peripheral/slotUpdated`, `peripheral/focusChanged`).
  - Bidirectional dispatch: focus switching (`switchFocus`), rotary brainpower step adjustment (`setBrainpower`), option decisions (`selectOption`), and emergency abort (`abort`).

---

## Installation & Configuration

Install via pnpm in your DSH workspace:

```bash
pnpm add dsh-plugin-peripheral-server
```

Enable in `cordis.yml`:

```yaml
plugins:
  peripheral-server:
    host: 127.0.0.1
    port: 45678
    path: /peripheral/v1
    totalSlots: 12
    autoBindSlots: true
```

Or load programmatically in a Cordis context:

```typescript
import { Context } from 'cordis';
import PeripheralServerPlugin from 'dsh-plugin-peripheral-server';

const ctx = new Context();
ctx.plugin(PeripheralServerPlugin, {
  port: 45678,
  autoBindSlots: true,
});
```

---

## Testing

```bash
pnpm test
```
