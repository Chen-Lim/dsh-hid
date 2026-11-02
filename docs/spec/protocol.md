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

## 4. NuPhy Air V3 (S4) 64 字节官方协议规范摘要

完整的字节级协议定义、双固件 Schema（17/22 字节）、HSV 色彩量化模型与 Journal 备份恢复状态机详见 **[《NuPhy Air V3 (S4) 硬件通信协议白皮书》](./nuphy-s4-whitepaper.md)**。核心规则摘要如下：

### 4.1 无损会话推导 (`0xA1`) 与物理档位探测 (`0xA0`)
1. **无损推导 `SessionKey` (`0xA1`)**：
   - 废除早期逆向中会覆写键盘 RAM 会话密钥的 `0xEE` 握手，改用只读指令 `0xA1`（`Byte 0 = 0x55, Byte 1 = 0xA1, length = 8, key = 0`）。
   - 利用固件信息第 3 字节恒为 `0xAA` 的特性，直接由响应报文计算 `SessionKey = raw[11] ^ 0xAA`，并解析固件版本 `info[2].info[1].info[0].(info[4] | (info[5] << 8))`。
2. **Mac / Win 档位路由 (`0xA0`)**：
   - 通过 `0xA0` 读取当前物理开关档位（`0` = Mac, `1` = Win）作为 `lightingProfile`，并在后续 `0xD5` / `0xD6` / `0xD8` 报文的 `Byte 7` (`handle`) 中携带该档位。
3. **报文加密与累加校验和**：
   - 路由头（`Bytes 4..7`）与有效载荷（`Bytes 8..(8+length-1)`）均与 `SessionKey` 执行按位异或（XOR），尾部 `0x00` 填充字节不参与异或；`Byte 3` 为 `Bytes 4..63` 的 8 位无符号累加校验和。

### 4.2 84 键逐键 RGB 流式控制 (`0xD6` + `0xD8` + `0xD2`)
- **进入逐键模式 (`Arm`)**：先将原始 `0xD5` 状态（`1.0.16.6` 为 17 字节，`1.0.17.6+` 为 22 字节）与 `0xD2` 312 字节渲染色原子备份至磁盘 Journal，随后通过 `0xD6` 写入 `Effect 21`（自定义逐键模式，硬件亮度 `100`，RGB 模式 `1`），不再执行单独的 `address = 1` 亮度写入。
- **流式增量刷写 (`0xD8`)**：按 `[ledIndex, R, G, B]` 4 字节记录打包（单包最多 13 颗灯珠 / 52 字节），仅向有颜色变化的 `0..83` 号主键灯位发送增量更新。
- **Codex Micro 标准状态色彩**：
  - 空闲 (`IDLE`)：`#FFFFFF` (`[0xFF, 0xFF, 0xFF]`)
  - 运行中 (`RUNNING`)：`#304FFE` (`[0x30, 0x4F, 0xFE]`)
  - 需交互 (`NEEDS_INPUT`)：`#FF6D00` (`[0xFF, 0x6D, 0x00]`)
  - 已完成 (`COMPLETED`)：`#00FF4C` (`[0x00, 0xFF, 0x4C]`)
  - 报错 (`ERROR`)：`#FF0033` (`[0xFF, 0x00, 0x33]`)
  - 未分配 (`INACTIVE`)：`#000000` (`[0x00, 0x00, 0x00]`)
- **无损恢复 (`Restore`)**：守护进程退出、断开或重连时，从磁盘 Journal 恢复用户原有的完整灯效配置与自定义调色板，并通过 `0xD5` / `0xD2` 回读校验。
