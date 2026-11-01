# 通讯契约与协议规范 (Communication Protocol Specification)

## 1. 协议层次全貌

系统涉及两套协议边界：
1. **上层通信（Server <-> Daemon）**：基于 WebSocket 传输的 **JSON-RPC 2.0 协议**，承载高层语义数据。
2. **底层通信（Daemon <-> Hardware）**：基于 USB HID 的二进制报文，包含 **VIA/QMK 32 字节 Raw HID 帧** 以及 **Nuphy 64 字节加密报文**。

---

## 2. JSON-RPC 2.0 通讯契约 (WebSocket Layer)

### 2.1 连接约定
- **地址**：`ws://127.0.0.1:45678/peripheral/v1`
- **编解码**：UTF-8 编码的标准 JSON-RPC 2.0 报文。

### 2.2 服务端推送通知 (Server -> Client)

#### 1. `peripheral/snapshot` (初始全量快照)
Daemon 建立连接后，服务端立即下发一次快照，同步全部 12 个槽位及聚焦状态。
```json
{
  "jsonrpc": "2.0",
  "method": "peripheral/snapshot",
  "params": {
    "focusedSlot": 1,
    "slots": [
      {
        "slotIndex": 1,
        "sessionId": "sess_main_01",
        "status": "RUNNING",
        "brainpower": "high"
      },
      {
        "slotIndex": 2,
        "sessionId": "sess_sub_02",
        "status": "IDLE",
        "brainpower": "medium"
      }
    ]
  }
}
```

#### 2. `peripheral/slotUpdated` (单槽位状态变更)
某一个 Agent 状态或思考预算变化时增量广播。
```json
{
  "jsonrpc": "2.0",
  "method": "peripheral/slotUpdated",
  "params": {
    "slotIndex": 1,
    "sessionId": "sess_main_01",
    "status": "NEEDS_INPUT",
    "activeTool": "bash",
    "question": {
      "prompt": "Proceed with deployment?",
      "options": ["Yes, deploy now", "No, cancel", "View diff first"]
    }
  }
}
```

#### 3. `peripheral/focusChanged` (焦点切换通知)
```json
{
  "jsonrpc": "2.0",
  "method": "peripheral/focusChanged",
  "params": {
    "focusedSlot": 2,
    "sessionId": "sess_sub_02"
  }
}
```

---

### 2.3 客户端控制指令 (Client -> Server)

#### 1. `peripheral/switchFocus` (F1-F12 焦点切换)
* **Request**:
```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "method": "peripheral/switchFocus",
  "params": {
    "slotIndex": 2
  }
}
```
* **Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 1001,
  "result": { "success": true, "focusedSlot": 2 }
}
```

#### 2. `peripheral/setBrainpower` (旋钮调节思考预算)
* **Request**:
```json
{
  "jsonrpc": "2.0",
  "id": 1002,
  "method": "peripheral/setBrainpower",
  "params": {
    "slotIndex": 1,
    "direction": "stepUp" // 或 "stepDown", 或直接指定 level: "high"
  }
}
```

#### 3. `peripheral/selectOption` (快速选项响应)
* **Request**:
```json
{
  "jsonrpc": "2.0",
  "id": 1003,
  "method": "peripheral/selectOption",
  "params": {
    "slotIndex": 1,
    "optionIndex": 1,
    "action": "ACCEPT"
  }
}
```

#### 4. `peripheral/abort` (紧急打断)
```json
{
  "jsonrpc": "2.0",
  "id": 1004,
  "method": "peripheral/abort",
  "params": {
    "slotIndex": 1
  }
}
```

---

## 3. VIA / QMK 32 字节 Raw HID 协议规范

针对支持 QMK/VIA 的客制化键盘（默认 `UsagePage = 0xFF60`, `UsageId = 0x61`），定义 32 字节通信帧。

### 3.1 下行报文（Daemon -> 键盘，控制灯效与槽位矩阵）
- `Byte 0`: `0xD5`（Magic Header，用于识别 DSH 外设协议，避免冲突）
- `Byte 1`: 指令类型（`0x01`: 槽位单键 LED 更新；`0x02`: 全量 12 槽位状态刷新；`0x03`: 聚焦槽位变更；`0xFF`: 退出复位）
- `Byte 2`: 目标槽位号（`0x01` ~ `0x0C`，对应 F1~F12）
- `Byte 3`: 状态码（`0x00`: INACTIVE, `0x01`: IDLE, `0x02`: RUNNING, `0x03`: NEEDS_INPUT, `0x04`: COMPLETED, `0x05`: ERROR）
- `Byte 4`: Brainpower 档位（`0x01` ~ `0x04`）
- `Byte 5..31`: 保留字节（填充 `0x00`）

### 3.2 上行报文（键盘 -> Daemon，按键与旋钮输入上报）
- `Byte 0`: `0xD5`（Magic Header）
- `Byte 1`: 事件类型：
  - `0x10`: F 键切换焦点（`Byte 2`: 槽位号 `1`~`12`）
  - `0x11`: 旋钮旋转（`Byte 2`: `0x01` 顺时针，`0x02` 逆时针，`0x03` 按下）
  - `0x12`: 选项按键（`Byte 2`: 选项编号 `1`~`4`；`0x0A`: 同意，`0x0B`: 拒绝）
- `Byte 3..31`: 填充 `0x00`

---

## 4. Nuphy Air V3 逆向 64 字节报文规范 (Keyphore-Derived)

借鉴 `Keyphore` 逆向 Nuphy 固件的研究成果：

### 4.1 会话握手与 SessionKey 交换
1. **发起握手 (TemporarySession)**：
   - Host 发送 64 字节报文：`Byte 0 = 0x55` (Host Direction), `Byte 1 = 0xEE` (Cmd TemporarySession), 附带 56 字节随机 Challenge。
2. **设备应答**：
   - 键盘返回 `0xAA` 头，并在特定偏移携带生成的 `SessionKey`。
3. **后续报文加密**：
   - 所有后续读写指令的 Payload 与参数均与 `SessionKey` 执行按位异或（XOR），并在 `Byte 3` 计算校验和 `checksum`。

### 4.2 背光与侧边指示灯写入
- **写入指令**：`Command::SetData = 0xD6`。
- **寄存器地址**：
  - 主背光模式地址：`0x0001`
  - 侧边/顶部节奏灯状态地址：`0x0002`
- **预设颜色序列**：
  - 运行中（蓝色）：`BLUE_EXECUTION_MAIN` (`[3, 100, 3, 0, 1, 0, 0, 0, 0xff]`)
  - 需交互（橙色）：`ORANGE_ATTENTION_MAIN` (`[3, 100, 3, 0, 1, 0, 0xff, 0x84, 0]`)
  - 完成（绿色）：`GREEN_COMPLETION_MAIN` (`[3, 100, 3, 0, 1, 0, 0, 0xff, 0]`)
  - 关灯/复位：`SIGNAL_OFF_MAIN` (`[3, 0, 3, 0, 1, 0, 0, 0, 0]`)
