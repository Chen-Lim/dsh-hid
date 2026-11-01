# AGENTS.md - DeepSeek Harness (DSH) HID 插件开发指南

本指南为参与 `dsh-hid` 项目的 AI 代理与开发者提供核心上下文、架构设计、技术约束和开发规范。

---

## 1. 项目定位与背景 (Project Overview)

`dsh-hid` 是为 **DeepSeek Harness (DSH)** 构建的 **Cordis 插件**。
其目标是将 DSH 的智能体运行状态（如思考中、需要输入、执行中、完成、报错等）实时流式传输至外部物理 **HID 设备**（机械键盘、宏键盘、状态屏等），实现类似 **Work Louder × OpenAI "Codex Micro"** 的物理硬件状态指示与硬件交互体验。

### 核心灵感：Codex Micro 交互范式
- **状态感知指示**：通过硬件按键 RGB 灯光颜色/动效（或微型 OLED/LCD 屏幕）即时反馈 Agent 状态：
  - `Idle` (空闲/待机) - 静态常亮或微光呼吸
  - `Thinking / Working` (推理/调用工具中) - 循环动态灯效（如蓝色/流光）
  - `Input Needed` (等待用户反馈/授权确认) - 醒目提示（如琥珀色/橙色脉冲）
  - `Completed / Success` (执行成功/待审阅) - 成功反馈（如绿色常量或闪烁）
  - `Error / Blocked` (执行异常/受限) - 警告提示（如红色快闪）
- **双向交互**：支持通过物理按键将输入反馈回传给 DSH（如一键确认 Proceed、中断运行 Cancel、切换会话等）。

---

## 2. 技术栈与架构 (Tech Stack & Architecture)

### 2.1 基础技术栈
- **宿主与插件系统**：[Cordis](https://cordis.sh/) 微内核架构（依赖注入、服务生命周期、事件总线）
- **开发语言**：TypeScript / Node.js
- **设备通信层**：Node HID（如 `node-hid`）或基于 WebHID / Raw HID 的传输抽象
- **运行环境**：macOS (Apple Silicon M-series) / Linux / Windows 跨平台兼容

### 2.2 核心模块分层
```text
┌────────────────────────────────────────────────────────┐
│               DeepSeek Harness (DSH)                   │
└───────────────────────────┬────────────────────────────┘
                            │ (Events & States)
┌───────────────────────────▼────────────────────────────┐
│                    dsh-hid Plugin                      │
│                                                        │
│  ┌────────────────────┐      ┌──────────────────────┐  │
│  │    DshListener     │ ───► │  State & Color Map   │  │
│  │ (DSH 状态事件监听)  │      │  (Codex Micro 映射层) │  │
│  └────────────────────┘      └──────────┬───────────┘  │
│                                         │              │
│  ┌────────────────────┐      ┌──────────▼───────────┐  │
│  │    InputHandler    │ ◄─── │     HidTransport     │  │
│  │ (按键回传 DSH 交互) │      │  (数据封包与设备驱动) │  │
│  └────────────────────┘      └──────────┬───────────┘  │
└─────────────────────────────────────────┼──────────────┘
                                          │ USB HID Report
                               ┌──────────▼───────────┐
                               │     HID Device       │
                               │ (Codex Micro / Keypad)│
                               └──────────────────────┘
```

1. **Cordis Service (`service.ts`)**：作为 Cordis 插件入口，管理插件配置、生命周期启动与注销。
2. **DSH State Listener (`listener.ts`)**：对接 DSH 的 Agent 生命周期事件，维护当前 Agent 状态机。
3. **State Mapper & Protocol (`protocol.ts`)**：将 Agent 抽象状态转化为 HID Report 字节序列（包含 RGB 调色、亮度、呼吸速度或屏幕帧数据）。
4. **HID Transport (`transport.ts`)**：负责设备的热插拔检测、连接保持、非阻塞写入与错误重连；**必须提供 Mock HID 模拟层**以便在脱机/无物理设备时进行自动化测试。
5. **Key Event Dispatcher (`input.ts`)**：监听 HID 设备的 Input Report，解析物理按键事件并分发至 DSH。

---

## 3. 开发规范与实施准则 (Agent Rules & Guidelines)

### 3.1 严格类型与异步安全
- 所有公共接口与函数必须具备明确的 TypeScript 类型注解。
- **避免阻塞主事件循环**：USB HID 枚举和热插拔检测必须异步处理，不可导致宿主 Harness 发生主线程掉帧或无响应（参考 Windows 上同步 `hid.dll` 枚举可能导致的 UI 冻结前车之鉴）。
- **设备容错与热插拔**：设备断开或通信异常时需优雅降级（Graceful Degradation），自动重试重连，绝不可抛出未捕获异常导致宿主进程崩溃。

### 3.2 模块化与可测试性
- **Mock 优先**：必须实现 `MockHidTransport`，支持通过环境变量（如 `DSH_HID_MOCK=1`）或配置启用。单元测试中一律使用 Mock 传输层。
- **协议抽象**：将具体硬件的 HID Report 格式抽象为适配器（Adapter Pattern），便于未来扩展不同形态的硬件（RGB 灯效设备、单色 OLED 屏、墨水屏设备等）。

### 3.3 交互逻辑（对齐 Codex Micro 体验）
- **防抖与节流**：状态高频变化时对 HID 发送做节流（Throttle）处理，防止过度刷写 USB 缓冲区。
- **状态记忆与恢复**：当设备拔出并重新插入后，能够自动重新同步当前 DSH 的最新状态。

---

## 4. 目录结构预期 (Expected Directory Structure)

```text
dsh-hid/
├── AGENTS.md                  # 本规范说明
├── README.md                  # 项目介绍与使用文档
├── package.json               # 项目依赖与 Cordis 插件配置
├── tsconfig.json              # TypeScript 编译配置
├── src/
│   ├── index.ts               # 插件入口与 Cordis 注册导出
│   ├── types.ts               # 状态模型与协议类型定义
│   ├── listener.ts            # DSH 状态事件监听
│   ├── mapper.ts              # 状态到硬件协议映射
│   ├── transport/
│   │   ├── base.ts            # 传输层抽象基类
│   │   ├── node-hid.ts        # 实体 USB HID 实现
│   │   └── mock.ts            # 离线模拟传输层
│   └── profiles/
│       ├── codex-micro.ts     # 针对 Codex Micro 格式的配置与协议描述
│       └── generic-rgb.ts     # 通用 RGB/HID 设备适配器
└── test/                      # 单元与集成测试
```

---

## 5. Agent 行为边界 (Operational Boundaries)

- 当构建功能或重构代码时，必须保持与 Cordis 插件生态标准一致。
- 遵循项目的平衡模式：基础类型、工具函数可自主构建；涉及底层 HID 协议定义或核心接口变更时应与开发者对齐。
- 代码注释保持精炼，优先使用自解释的类型与函数命名。

## 6. 项目目录可访问性

**可修改**:
- `~/dsh-hid`

**只读**:
- `~/deepseek-harness`
- `~/Keyphore`
