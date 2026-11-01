# MRD：DeepSeek Harness 通用外设协同生态（Project Micro-Bridge）

## 1. 背景与机会点

随着 AI Coding Agent 进入高频并发协作阶段，开发者与 Agent 的交互正在从“单窗口同步对话”演进为“多会话后台异步自治”。当前主流交互模式存在以下核心痛点：

* **注意力上下文切换损耗高**：开发者在 IDE、终端、浏览器之间切换时，无法通过边缘视觉（Peripheral Vision）实时感知后台 Agent 的运行状态（推理中、工具执行中、等待人工介入或异常挂起）。
* **关键边界的人机协同（HITL）体验割裂**：Human-in-the-Loop 的核心目的并非单纯降低人工干预频率，而是在**关键权限边界（如高危 Shell 执行、破坏性文件修改、外部系统写操作）确保人类在合适的时机精准介入，防止 Agent 越权操作**。现有基于终端命令行确认（`y/n`）或弹窗的审批方式容易被窗口遮挡，或因频繁切换窗口导致操作疲劳与误判。
* **硬件外设生态碎片化与封闭性**：OpenAI 联合 Work Louder 推出的 Codex Micro 验证了“物理外设 + Agent 状态机”的高效交互范式，但其硬件绑定度高。海量现有的客制化键盘（QMK/VIA/ZMK）、Stream Deck、Loupedeck 等可编程外设缺乏统一、开放的 Agent 接入标准。

依托 `deepseek-ai/deepseek-harness` 开源代码仓库，本项目旨在基于其底层的 Cordis 插件体系，构建一套**兼容 Codex App Server 思想的标准化外设服务层（Peripheral App Server）**，将硬件驱动与 Agent 内核解耦，让任意支持可编程通信的物理外设都能以零侵入方式成为 DeepSeek Harness 的物理控制台。

---

## 2. 目标用户与典型场景

| 用户画像 | 硬件设备特征 | 核心诉求与使用场景 |
| --- | --- | --- |
| **重度 AI Agent 开发者 / 极客** | 拥有支持 VIA / QMK / ZMK 的客制化机械键盘、旋钮小键盘（Macropad） | 利用键盘闲置层（Layer）或独立旋钮/按键，通过单键 RGB 灯效实时监控 Agent 状态，在 Agent 触发越权/高危操作时通过物理按键完成秒级审批（Accept / Reject / Abort）。 |
| **多任务并发研发 / 技术管理（TPM/PM）** | 使用 Elgato Stream Deck、Loupedeck 或桌面副屏外设 | 同时挂载多个 Agent Session，通过外设物理按键一键切换焦点 Session、调整模型思考预算（Brainpower），或向指定 Inbox 注入预设的 `/review`、`/summarize` 等高频 Skill。 |
| **开源硬件与效率工具开发者** | 具备 Rust / Python / C / TypeScript 及 HID / 串口开发能力 | 希望基于一套标准、稳定的 JSON-RPC 2.0 协议快速为自己的硬件编写 Daemon 桥接程序，无需深入阅读或修改 Agent 核心源码。 |

---

## 3. 市场方案对比与架构选型

| 评估维度 | 官方封闭外设方案（如 Codex Micro） | 进程内硬编码 HID 插件方案 | **本项目方案（Cordis 标准协议插件 + 外部 Daemon）** |
| --- | --- | --- | --- |
| **架构解耦度** | 依赖官方 CLI 内置 `app-server` | 低（Node.js 进程强绑定 `node-hid` 原生 C++ 扩展） | **极高**（Harness 仅负责 JSON-RPC 状态广播与拦截，硬件通信由独立进程完成） |
| **外设生态兼容性** | 优先服务官方联名硬件 | 仅限特定 VID/PID 的单一键盘设备 | **全生态兼容**（VIA/QMK 键盘、Stream Deck、串口副屏、移动端均可接入） |
| **稳定性与跨平台** | 强依赖官方客户端版本 | 易受 Node ABI 版本、USB 权限影响导致主进程崩溃 | **主进程零风险**（外设热插拔或驱动崩溃绝不影响 Agent 运行时状态） |
| **协议复用价值** | 协议由 OpenAI 定义，演进受控 | 无通用协议层 | **对齐并扩展 Codex App Server JSON Schema**，可平移复用社区现有驱动 |

---

## 4. 演进路线图（Roadmap）

1. **Milestone 1：协议与核心插件基建（v0.1 MVP）**
* 完成 `dsh-plugin-peripheral-server` Cordis 插件开发，支持本地 WebSocket / Unix Domain Socket 的 JSON-RPC 2.0 通信。
* 跑通核心状态广播（Idle / Thinking / Executing / Awaiting Approval）与工具高危边界拦截（Approve / Reject / Abort）。


2. **Milestone 2：VIA / QMK 客制化键盘参考实现（v0.5）**
* 发布跨平台轻量级 Hardware Daemon（Rust / Python 实现），完成 JSON-RPC 2.0 与 32-Byte Raw HID（`0xFF60` / `0x61`）的双向映射。
* 提供标准 QMK 固件代码片段（Keymap & Raw HID Handler）与 VIA 配置模板。


3. **Milestone 3：多会话路由与生态扩展（v1.0）**
* 支持多 Session 状态订阅、物理旋钮动态调整推理强度（Brainpower / Effort）、动态 Skill 宏注入，并提供 Stream Deck 等主流外设插件示例。



---

---

# PRD：DeepSeek Harness 外设服务插件与 VIA 桥接套件

## 1. 产品架构与系统边界

系统采用“前后端分离、协议标准化”的三层架构设计，严格划分 Agent 核心运行时与硬件驱动边界：

```text
+-----------------------------------------------------------------------+
| Layer 1: DeepSeek Harness Runtime (Cordis Context)                    |
|                                                                       |
|  [ctx.agentLoop]        [ctx.tools (Waterfall)]        [ctx.llm]      |
|         |                          |                       |          |
|         +--------------------------+-----------------------+          |
|                                    |                                  |
|                                    v                                  |
|                 +-------------------------------------+               |
|                 |   dsh-plugin-peripheral-server      |               |
|                 |  (State Aggregator & HITL Blocker)  |               |
|                 +------------------+------------------+               |
+------------------------------------|----------------------------------+
                                     |
                                     | Layer 2: Standard Protocol
                                     | Local WebSocket / IPC
                                     | JSON-RPC 2.0 (Codex-Aligned Schema)
                                     |
+------------------------------------v----------------------------------+
| Layer 3: Peripheral Hardware Daemon (e.g., dsh-via-daemon)            |
|                                                                       |
|  [JSON-RPC Client] <===> [State/Action Mapper] <===> [HID API Driver] |
+------------------------------------------------------------|----------+
                                                             |
                                                             | Raw HID (32-Byte)
                                                             | Usage Page: 0xFF60
                                                             v
                                              +-------------------------+
                                              |  VIA / QMK Keyboard     |
                                              | (RGB Matrix & Keycodes) |
                                              +-------------------------+

```

* **边界职责定义**：
* **`dsh-plugin-peripheral-server`（Cordis 插件）**：运行于 Harness 进程内。负责订阅内部事件、挂载 `tools/pre-execute` 拦截器、维护外设连接池，对外暴露标准 JSON-RPC 2.0 接口；**不包含任何硬件 USB/HID 依赖**。
* **Peripheral Hardware Daemon（外部硬件守护进程）**：独立常驻进程。负责连接插件 WebSocket 端口，将 JSON-RPC 状态翻译为特定硬件指令（如 VIA 32-Byte Raw HID 报文），并将物理按键/旋钮事件转化为 JSON-RPC 请求发回插件。



---

## 2. 功能需求矩阵（Functional Requirements）

### 2.1 状态感知与遥测广播（Server -> Peripheral）

| 需求编号 | 功能模块 | 优先级 | 详细需求描述 |
| --- | --- | --- | --- |
| **FR-01** | **初始状态快照同步** | **P0** | 外设 Daemon 建立连接后，插件须立即下发一次 `peripheral/snapshot` 通知，包含当前活跃 Session ID、Agent 状态、当前模型配置及挂起的审批队列。 |
| **FR-02** | **生命周期状态机流转广播** | **P0** | 当 Agent 状态发生变更时，实时推送 `peripheral/stateChanged` 事件，驱动外设指示灯（如 RGB 颜色/呼吸频率）同步变化。 |
| **FR-03** | **关键边界审批挂起通知** | **P0** | 当 Agent 触发高风险工具调用（需人工介入防止越权）时，推送 `peripheral/approvalRequired` 事件，携带 `requestId`、工具名称、风险等级及简要参数摘要。 |
| **FR-04** | **推理预算/模型档位同步** | **P1** | 当用户通过 CLI、Web UI 或其他外设修改当前模型的推理深度（Brainpower / Model Preset）时，向所有已连接外设广播最新档位状态。 |

### 2.2 物理控制与边界干预（Peripheral -> Server）

| 需求编号 | 功能模块 | 优先级 | 详细需求描述 |
| --- | --- | --- | --- |
| **FR-05** | **HITL 物理按键审批决策** | **P0** | 外设在 `AWAITING_APPROVAL` 状态下发送 `peripheral/respondApproval`（`ACCEPT` / `REJECT`）。插件收到后立即解除对应 `tools/pre-execute` 的 Promise 挂起状态，放行或阻断工具执行。 |
| **FR-06** | **紧急物理熔断（Panic Abort）** | **P0** | 任何状态下，外设触发 `peripheral/abort` 请求，插件立即调用当前活跃 Session 的中断接口终止生成流与正在执行的子进程，防止失控操作继续蔓延。 |
| **FR-07** | **预设动作与 Skill 宏注入** | **P1** | 外设发送 `peripheral/injectAction`，支持将预设 Prompt 或 Skill（如 `/commit`、`/review`）直接推入目标 Agent 的 `next-step` 或 `next-turn` 消息队列（Inbox）。 |
| **FR-08** | **Brainpower 旋钮无级/档位调节** | **P1** | 外设通过旋转编码器发送 `peripheral/setBrainpower`，动态切换当前 Session 的推理模式（如 `low` / `medium` / `high` 或切换 `deepseek-chat` / `deepseek-reasoner`）。 |
| **FR-09** | **多 Session 焦点切换** | **P2** | 支持外设通过按键在多个并发 Agent Session 之间切换绑定焦点（Focus Session），使单组物理按键可分时复用控制多个后台任务。 |

---

## 3. 核心状态机与视觉映射规范

插件对外暴露的标准状态枚举（`AgentPeripheralStatus`）及推荐的物理灯光映射如下：

| 状态枚举值 | 触发条件 | 推荐 VIA/QMK RGB 视觉反馈 | 允许的物理交互动作 |
| --- | --- | --- | --- |
| `IDLE` | Session 空闲，等待用户输入 | 低亮度静态白光 / 默认背光 | 注入 Skill 宏、调节 Brainpower、切换 Session |
| `THINKING` | 模型正在进行 Token 流式推理（`llm/stream`） | 青蓝色慢速呼吸灯效 | Panic Abort（一键打断） |
| `EXECUTING_TOOL` | 已通过审批或免审批工具正在运行中 | 紫色常亮或跑马灯效 | Panic Abort（强制终止工具） |
| `AWAITING_APPROVAL` | **触碰权限边界，挂起等待人工确认** | **琥珀黄高频闪烁（Accept 键亮绿，Reject 键亮红）** | **Accept（放行）、Reject（拒绝并回传原因）、Abort** |
| `COMPLETED` | 当前 Turn 正常执行完毕 | 翠绿色常亮 3 秒后回落至 `IDLE` | 注入下一轮 Skill 宏 |
| `ERROR` | 模型调用失败、工具崩溃或越权被拒 | 红色双闪警告 | 确认清除错误状态（Acknowledge）、重试 |

---

## 4. 接口契约规范（JSON-RPC 2.0 Schema）

传输层默认绑定本地回环地址：`ws://127.0.0.1:45678/peripheral/v1`。所有报文遵循 JSON-RPC 2.0 规范。

### 4.1 Server -> Client Notifications（服务端广播）

#### `peripheral/stateChanged`

```json
{
  "jsonrpc": "2.0",
  "method": "peripheral/stateChanged",
  "params": {
    "timestamp": 1793545800000,
    "sessionId": "sess_01JBM8X9Z",
    "status": "AWAITING_APPROVAL",
    "brainpower": "high",
    "activeTool": {
      "name": "bash",
      "riskLevel": "CRITICAL"
    },
    "pendingApproval": {
      "requestId": "req_99812",
      "toolName": "bash",
      "summary": "rm -rf ./dist && git push --force",
      "riskReason": "Destructive file operation & force push"
    }
  }
}

```

### 4.2 Client -> Server Requests（外设控制指令）

#### 1. `peripheral/respondApproval`（边界审批）

* **Request**:
```json
{
  "jsonrpc": "2.0",
  "id": 101,
  "method": "peripheral/respondApproval",
  "params": {
    "requestId": "req_99812",
    "decision": "REJECT",
    "feedback": "Rejected via physical hardware key"
  }
}

```


* **Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 101,
  "result": {
    "acknowledged": true,
    "newStatus": "THINKING"
  }
}

```



#### 2. `peripheral/setBrainpower`（调节思考预算）

* **Request**:
```json
{
  "jsonrpc": "2.0",
  "id": 102,
  "method": "peripheral/setBrainpower",
  "params": {
    "sessionId": "sess_01JBM8X9Z",
    "level": "high"
  }
}

```



#### 3. `peripheral/injectAction`（注入预设动作/队列）

* **Request**:
```json
{
  "jsonrpc": "2.0",
  "id": 103,
  "method": "peripheral/injectAction",
  "params": {
    "sessionId": "sess_01JBM8X9Z",
    "queue": "next-step",
    "actionType": "SKILL",
    "payload": "/review --staged"
  }
}

```



---

## 5. VIA / QMK Raw HID 硬件参考协议（32-Byte Frame）

为方便客制化键盘直接接入，定义标准的 32 字节 Raw HID 通信帧格式（QMK 默认 `RAW_USAGE_PAGE 0xFF60`，`RAW_USAGE_ID 0x61`）。

### 5.1 下行报文（Daemon -> Keyboard，控制灯效与状态）

| Byte 偏移 | 字段名称 | 类型 | 说明 |
| --- | --- | --- | --- |
| `Byte 0` | `Magic Header` | `uint8` | 固定为 `0xD5`（标识 DeepSeek Peripheral 协议包，避免与 VIA 原生改键指令冲突） |
| `Byte 1` | `Command ID` | `uint8` | `0x01`: 状态更新；`0x02`: 审批告警；`0x03`: Brainpower 档位同步；`0xFF`: 释放控制恢复默认灯效 |
| `Byte 2` | `Agent Status` | `uint8` | `0x00`: IDLE, `0x01`: THINKING, `0x02`: TOOL, `0x03`: APPROVAL, `0x04`: DONE, `0x05`: ERROR |
| `Byte 3` | `Risk Level` | `uint8` | `0x00`: NONE, `0x01`: LOW, `0x02`: MEDIUM, `0x03`: HIGH/CRITICAL |
| `Byte 4` | `Brainpower` | `uint8` | `0x01` ~ `0x04`（对应 4 个推理强度档位，用于点亮键盘灯带进度） |
| `Byte 5` | `Active Slot` | `uint8` | 当前控制的 Session 槽位编号（`0x00` ~ `0x03`） |
| `Byte 6..21` | `Tool Name` | `char[16]` | ASCII 字符串（如 `"bash\0"`），供带 OLED 屏幕的键盘直接渲染显示 |
| `Byte 22..31` | `Reserved` | `uint8[10]` | 预留扩展，填充 `0x00` |

### 5.2 上行报文（Keyboard -> Daemon，物理按键触发）

| Byte 偏移 | 字段名称 | 类型 | 说明 |
| --- | --- | --- | --- |
| `Byte 0` | `Magic Header` | `uint8` | 固定为 `0xD5` |
| `Byte 1` | `Event Type` | `uint8` | `0x10`: 审批决策；`0x11`: 紧急中断；`0x12`: 旋钮事件；`0x13`: 宏按键触发；`0x14`: Session 切换 |
| `Byte 2` | `Event Value` | `uint8` | 当 `Event=0x10` 时：`0x01`=ACCEPT, `0x00`=REJECT；当 `Event=0x12` 时：`0x01`=顺时针, `0x02`=逆时针；当 `Event=0x13` 时：宏编号 `1..16` |
| `Byte 3..31` | `Padding` | `uint8[29]` | 填充 `0x00` |

---

## 6. 非功能性需求与异常安全边界

1. **端到端低延迟要求**：
* 从 Harness 内部触发状态变更到 WebSocket 广播发出的处理延迟须 **< 2ms**。
* 物理按键按下（HID 中断）到插件解除 `tools/pre-execute` 阻塞的全链路延迟须 **< 15ms**。


2. **安全与防误触机制（Safety & Anti-Misfire）**：
* **权限绑定**：WebSocket 服务默认仅监听 `127.0.0.1` 或本地 Unix Domain Socket，禁止暴露至局域网/公网网卡。
* **审批幂等与超时保护**：每个 `requestId` 仅允许消费一次。若外设在配置超时时间（默认 300s）内未响应，或外设在挂起期间意外断开连接，系统不得自动放行高危操作，必须保持终端 CLI 审批回退通道可用，确保双重可观测。


3. **Cordis 可逆生命周期（Reversible Disposables）**：
* 当插件被卸载或 `dsh` 进程退出（触发 `ctx.on('dispose')`）时，必须先向所有已连接客户端广播 `peripheral/serverShuttingDown` 通知（触发 Daemon 发送 `0xFF` 指令让键盘恢复默认 RGB 层），随后干净关闭 WebSocket 句柄与未决 Promise。
