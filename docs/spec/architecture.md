# 系统架构规范 (System Architecture Specification)

## 1. 架构愿景与设计哲学

`dsh-hid`（Project Micro-Bridge）是为 **DeepSeek Harness (DSH)** 构建的物理外设协同子系统。其核心目标是将 DSH 的智能体运行时状态流式投射到客制化键盘、宏小键盘等物理外设上，并通过实体按键与旋钮实现直觉化、低认知负荷的边缘控制。

### 核心设计原则
1. **解耦优先（Process Decoupling）**：
   - DSH 宿主进程内**严禁包含任何原生 C++ USB/HID 扩展**。
   - Harness 仅运行轻量级 Cordis 插件，对外暴露标准的本地 JSON-RPC 2.0 接口；硬件枚举、USB 报文打包及热插拔管理完全由独立的守护进程（Hardware Daemon）负责。
2. **高容错与零崩溃传播（Zero Crash Propagation）**：
   - 外部硬件的拔插、通信丢包或驱动崩溃绝不扩散至 Agent 运行时环境。
3. **分层协议标准化（Protocol Neutrality）**：
   - 将“Agent 状态语义”与“物理按键灯光硬件”解耦，支持未来横向接入 VIA/QMK 键盘、Nuphy 键盘、Stream Deck 或墨水屏副屏。

---

## 2. 总体三层架构模型

```text
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 1: DeepSeek Harness Core Runtime (Node.js / Cordis)               │
│                                                                        │
│   [ctx.agentLoop]      [ctx.session]      [ctx.tools]                  │
│          │                   │                 │                       │
│          └───────────────────┼─────────────────┘                       │
│                              ▼                                         │
│             +─────────────────────────────────+                        │
│             │  dsh-plugin-peripheral-server  │                        │
│             │  - F1-F12 Session Router        │                        │
│             │  - State Machine Watcher        │                        │
│             │  - JSON-RPC 2.0 Server          │                        │
│             +────────────────+────────────────+                        │
└──────────────────────────────┼─────────────────────────────────────────┘
                               │
                               │ Local WebSocket (Loopback)
                               │ ws://127.0.0.1:45678/peripheral/v1
                               │ JSON-RPC 2.0 Schema
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 2: Peripheral Hardware Daemon (@dsh-hid/daemon)                  │
│                                                                        │
│  ┌──────────────────┐   ┌──────────────────┐   ┌─────────────────────┐ │
│  │ JSON-RPC Client  │──►│ Adapter Manager  │──►│ Device Driver Layer │ │
│  └──────────────────┘   └────────┬─────────┘   └──────────┬──────────┘ │
│                                  │                        │            │
│                 ┌────────────────┴────────────────┐       │            │
│                 ▼                                 ▼       ▼            │
│        [ViaRawhidAdapter]                 [NuphyV3Adapter]             │
│        (32-Byte Raw HID)                  (64-Byte Encrypted)          │
└─────────────────┬─────────────────────────────────┬────────────────────┘
                  │ USB HID Report                  │ USB HID Report
                  ▼                                 ▼
┌───────────────────────────────────┐ ┌──────────────────────────────────┐
│  VIA / QMK Programmable Keyboard  │ │      Nuphy Air V3 Keyboard       │
│  - F1-F12 Per-Key RGB Matrix      │ │  - RGB Backlight & Sidelight     │
│  - Rotary Encoder (Knob)          │ │  - Status Light Strip            │
└───────────────────────────────────┘ └──────────────────────────────────┘
```

---

## 3. 模块职责定义

### 3.1 `dsh-plugin-peripheral-server` (Cordis 插件)
- **运行宿主**：DeepSeek Harness 内部进程。
- **核心职责**：
  - 维护最多 12 个并发 Session 槽位（Slots 1~12）与真实 `sessionId` 的动态映射。
  - 监听 DSH 事件（`agent/status`, `agent/created`, `agent/disposed`, `user-questions` 等），聚合并推导当前每个槽位及全局聚焦 Session 的运行状态。
  - 承载 WebSocket Server，负责向连接的 Daemon 广播 `stateChanged`、`slotChanged` 等通知。
  - 接收来自 Daemon 的控制指令（如切换焦点 Session、通过旋钮修改 Brainpower 档位、选项决策），并调用 DSH 相应服务完成调度。

### 3.2 `@dsh-hid/protocol` (共享协议库)
- 纯 TypeScript 编写，无第三方原生依赖。
- 定义状态枚举（`AgentPeripheralStatus`）、按键与旋钮事件模型、JSON-RPC 2.0 报文请求与响应接口类型，供 Server 与 Daemon 共同引用。

### 3.3 `@dsh-hid/daemon` (硬件通信守护进程)
- **运行宿主**：独立后台进程（支持 CLI 单独启动或随系统自启）。
- **核心职责**：
  - 维护与 Cordis 插件的 WebSocket 长连接，支持指数退避自动重连。
  - 接收槽位与状态广播，通过匹配的硬件适配器将状态字节推送到键盘 LED。
  - 监听键盘的 Raw HID 输入（按键、旋钮旋转），封装为 JSON-RPC 请求发往服务端。

---

## 4. 故障隔离与安全设计 (Failure Containment & Safety)

1. **本地回环网络隔离**：
   - WebSocket 服务强制绑定 `127.0.0.1`，拒绝一切外部公网或局域网连接。
2. **连接断开与状态复位**：
   - 当 Daemon 进程退出或异常中断时，键盘适配器须在退出钩子中触发复位指令（如发送关闭报文恢复键盘默认灯光层）。
   - 若 Harness 进程退出，WebSocket 会在 `ctx.on('dispose')` 触发前广播 `serverShuttingDown` 信号，告知硬件退出托管模式。
3. **USB 枚举异步化**：
   - 遵循规范，HID 枚举与 I/O 必须在异步上下文中执行，避免阻塞事件循环。
