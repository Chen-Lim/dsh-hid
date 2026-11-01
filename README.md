# DeepSeek Harness (DSH) HID 外设协同生态 (`dsh-hid`)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](https://github.com/chen-lim/dsh-hid)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

**`dsh-hid`** 是为 **DeepSeek Harness (DSH)** 构建的物理外设硬件协同系统与 Cordis 插件生态。  
其核心设计灵感源于 **Work Louder × OpenAI "Codex Micro"** 交互范式，将 AI Agent 的实时运行状态（思考中、工具执行、等待用户授权确认、任务完成、报错异常）实时下沉至外部物理硬件（如客制化机械键盘、Nuphy 矮轴键盘、状态指示屏），并通过物理按键与旋钮实现免切换会话聚焦、思考预算调节与一键审批回传。

---

## 1. 核心特性 (Key Features)

- **物理状态感知 (Status Streaming)**：
  - 将多 Agent 并发运行状态映射至键盘单键 RGB 与侧边指示灯：
    - 🟢 **IDLE** (待机空闲) - 静态常亮或低亮度微光
    - 🔵 **RUNNING** (推理与工具执行) - 动态蓝色呼吸灯效，高亮当前活跃工具（如 `bash`, `read_file`）
    - 🟠 **NEEDS_INPUT** (等待确认 / HITL) - 醒目琥珀色脉冲闪烁，提示人工审阅介入
    - 🟣 **COMPLETED** (任务顺利达成) - 柔和蓝绿呼吸，反馈执行成功
    - 🔴 **ERROR / BLOCKED** (报错或受限) - 醒目红色快闪，提示异常中断
- **免切屏物理双向交互 (Physical Bidirectional Feedback)**：
  - **F1-F12 槽位切换**：物理单击 F1-F12 直跳对应 Agent 会话，无须离开全屏代码编辑器。
  - **旋转编码器调节思考预算**：旋转旋钮步进切换 Agent 思考算力等级（`low` ⇄ `medium` ⇄ `high` ⇄ `max`）。
  - **一键快速审批**：物理确认按键快速响应交互提示（如 Proceed / Confirm Deploy），解除阻塞继续执行。
  - **紧急安全熔断**：长按按键触发全局紧急 Abort，强制终止当前高危任务。
- **全链路高可用与容错 (Resilience & Auto-Reconnect)**：
  - WebSocket 断线指数退避重连，重连后自动拉取全量 `snapshot` 恢复硬件状态无损同步。
  - 设备热插拔安全无阻塞，非阻塞 I/O 杜绝影响 Harness 主事件循环。

---

## 2. 架构拓扑 (Architecture Overview)

项目采用三层解耦的 Monorepo 架构设计：

```text
┌─────────────────────────────────────────────────────────────┐
│                    DeepSeek Harness (DSH)                   │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │     dsh-plugin-peripheral-server (Cordis 插件)        │  │
│  │   • SessionRouter (F1-F12 槽位与焦点状态机)           │  │
│  │   • DSH Agent 生命周期与交互事件监听 (agent/*)        │  │
│  │   • WebSocket JSON-RPC 服务端 (:45678)                │  │
│  └──────────────────────────┬────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────┘
                              │ WebSocket (JSON-RPC 2.0)
┌─────────────────────────────▼───────────────────────────────┐
│              @dsh-hid/daemon (独立硬件守护进程)              │
│                                                             │
│   • 自动重连管理与 Snapshot 全量状态同步                     │
│   • 硬件输入事件调度器 (按键/旋钮 -> RPC 指令)              │
│   • 多硬件适配层 (HardwareAdapter):                         │
│     ├─ MockAdapter      (终端 ANSI 12 键彩显模拟器)         │
│     ├─ NuphyV3Adapter   (Keyphore 逆向协议 / 64B XOR 握手)  │
│     └─ ViaRawhidAdapter (标准 QMK/VIA 32B Raw HID 通信)     │
└─────────────────────────────┬───────────────────────────────┘
                              │ USB HID Report
                   ┌──────────▼───────────┐
                   │    物理硬件 / 键盘    │
                   └──────────────────────┘
```

---

## 3. Monorepo 模块清单 (Monorepo Packages)

| 包名 | 职责与功能 | 核心交付物 |
| :--- | :--- | :--- |
| [`@dsh-hid/protocol`](./packages/protocol) | 跨端共享数据类型、状态枚举、JSON-RPC 2.0 编解码、NuPhy/VIA 帧格式 | 纯类型与工具库 |
| [`dsh-plugin-peripheral-server`](./packages/server) | Cordis 服务端插件，承接 DSH 核心事件，管理 F1-F12 槽位，广播状态 | Cordis 插件 |
| [`@dsh-hid/daemon`](./packages/daemon) | 硬件守护进程与驱动适配器，提供命令行工具 `dsh-daemon` | 独立 CLI & 守护程序 |

---

## 4. 快速安装与使用指引 (Quick Start)

### 4.1 环境准备

- Node.js >= 20.0.0
- pnpm >= 9.0.0

```bash
git clone https://github.com/chen-lim/dsh-hid.git
cd dsh-hid
pnpm install
pnpm build
```

### 4.2 运行测试套件

```bash
# 执行全部单元测试与 E2E 端到端集成测试
pnpm test

# 执行严格 TypeScript 类型检查
pnpm typecheck
```

### 4.3 方式一：加载 Cordis 服务端插件 (Harness 内)

在 DeepSeek Harness 的 Cordis 配置文件中声明或直接以代码方式装载：

```typescript
import { Context } from 'cordis';
import PeripheralServerService from 'dsh-plugin-peripheral-server';

const ctx = new Context();
ctx.plugin(PeripheralServerService, {
  port: 45678,
  autoBindSlots: true,
});
await ctx.start();
```

### 4.4 方式二：启动硬件守护进程 (Daemon CLI)

独立终端中启动硬件守护进程，支持三种模式：

```bash
# 1. 终端 ASCII 矩阵模拟器（免物理硬件，强烈推荐测试与体验）
pnpm daemon:mock
# 或直接通过构建产物运行：
node packages/daemon/dist/cli.js --adapter=mock

# 2. Nuphy Air75/Air96 V3 键盘模式（Keyphore 协议）
pnpm daemon:nuphy

# 3. 标准 VIA/QMK 客制化键盘模式（Raw HID）
pnpm daemon:via

# 自定义服务地址
node packages/daemon/dist/cli.js --adapter=mock --url=ws://127.0.0.1:45678/peripheral/v1
```

---

## 5. 硬件模拟器效果预览 (Mock Preview)

启动 `MockAdapter` 后，终端将实时渲染双行 12 键 ASCII 状态矩阵及当前聚焦会话信息：

```text
╔══════════════════════════════════════════════════════════════════════════╗
║             DSH HID Peripheral Hardware Simulator (MockAdapter)          ║
╠══════════════════════════════════════════════════════════════════════════╣
║  ►[F1:RUN]   [F2:ASK]   [F3:ERR]   [F4:DON]   [F5:IDL]   [F6:OFF]        ║
║   [F7:OFF]   [F8:OFF]   [F9:OFF]   [F10:OFF]  [F11:OFF]  [F12:OFF]       ║
╠══════════════════════════════════════════════════════════════════════════╣
║ Focus: Slot F1 (RUNNING)                           Brainpower: medium    ║
║ [Tool: bash]                                                             ║
╚══════════════════════════════════════════════════════════════════════════╝
```

---

## 6. 文档中心索引 (Documentation Index)

- 需求与市场分析：[`docs/mrd&prd.md`](./docs/mrd&prd.md)
- 系统架构与安全隔离：[`docs/spec/architecture.md`](./docs/spec/architecture.md)
- 按键映射与灯效规范：[`docs/spec/keymap-and-lighting.md`](./docs/spec/keymap-and-lighting.md)
- 协议契约规范：[`docs/spec/protocol.md`](./docs/spec/protocol.md)
- Cordis 插件开发契约：[`docs/spec/plugin-cordis.md`](./docs/spec/plugin-cordis.md)
- 项目研发排期时间线：[`docs/timeline.md`](./docs/timeline.md)

---

## 7. 许可证 (License)

本项目基于 [MIT License](./LICENSE) 协议开源。
