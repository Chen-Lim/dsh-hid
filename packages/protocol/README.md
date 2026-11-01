# @dsh-hid/protocol

DeepSeek Harness (DSH) HID 外设桥接协议共享库。

本包为纯 TypeScript 实现，无任何第三方原生二进制依赖，负责定义 DSH 状态流式传输与外设交互的统一契约：
- **上层通信（Server <-> Daemon）**：基于 WebSocket 传输的 JSON-RPC 2.0 报文协议规范与类型保护。
- **底层通信（Daemon <-> Hardware）**：VIA/QMK 32 字节 Raw HID 与 Nuphy 64 字节报文常量及状态映射字典。

---

## 📦 安装

在 monorepo 内部工作区引用：

```json
{
  "dependencies": {
    "@dsh-hid/protocol": "workspace:*"
  }
}
```

---

## 🚀 核心功能

### 1. 核心状态与数据模型

```typescript
import {
  AgentPeripheralStatus,
  BrainpowerLevel,
  SlotInfo,
} from '@dsh-hid/protocol';

const slot: SlotInfo = {
  slotIndex: 1,
  sessionId: 'sess_12345',
  status: AgentPeripheralStatus.RUNNING,
  brainpower: 'high',
  activeTool: 'bash',
};
```

### 2. JSON-RPC 2.0 报文构造与校验

```typescript
import {
  createSnapshotNotification,
  createSwitchFocusRequest,
  serializeJsonRpcMessage,
  parseJsonRpcMessage,
  isJsonRpcRequest,
} from '@dsh-hid/protocol';

// 构造通知
const notif = createSnapshotNotification(1, [slot]);
const rawJson = serializeJsonRpcMessage(notif);

// 解析并校验报文
const msg = parseJsonRpcMessage(rawJson);
if (isJsonRpcRequest(msg)) {
  console.log('Received request:', msg.method);
}
```

### 3. 底层硬件报文与状态映射

```typescript
import {
  STATUS_TO_BYTE_MAP,
  BYTE_TO_STATUS_MAP,
  VIA_RAW_HID_MAGIC,
  AgentPeripheralStatus,
} from '@dsh-hid/protocol';

// 状态枚举转换为 VIA 协议字节 (0x02)
const byteVal = STATUS_TO_BYTE_MAP[AgentPeripheralStatus.RUNNING];
```
