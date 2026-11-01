# 项目排期与实施时间线 (Timeline & Milestones)

## 1. 阶段演进总览

项目分为四个开发阶段，采取“MVP 先行、同构验证、渐进下沉”的技术路径：

```text
  [ Milestone 1 ]             [ Milestone 2 ]             [ Milestone 3 ]             [ Milestone 4 ]
协议包与 Monorepo 基建  ──►  Cordis 插件核心功能  ──►  硬件守护进程与驱动适配  ──►  自动化测试与发布打包
     (Day 1 ~ 2)                  (Day 3 ~ 4)                  (Day 5 ~ 7)                  (Day 8 ~ 9)
                                                                                                 │
                                                                                                 ▼
                                                                                      [ LTS 阶段: Rust 核心重构 ]
```

---

## 2. 里程碑阶段规划与交付清单

### Milestone 1：协议规范与 Monorepo 脚手架 (v0.1.0-alpha)
- **目标**：搭建规范的 TypeScript 开发工程，完成共享协议定义与全链路数据类型约束。
- **任务清单**：
  - [x] 配置 `pnpm-workspace.yaml` 与统一 `tsconfig.json`。
  - [x] 实现 `@dsh-hid/protocol` 协议库：
    - [x] 导出 `AgentPeripheralStatus`、`SlotInfo`、`BrainpowerDirection` 等核心数据模型。
    - [x] 实现 JSON-RPC 2.0 请求、响应与通知的编解码工具函数。
    - [x] 编写协议往返序列化单元测试。
- **交付物**：可编译发布的 `@dsh-hid/protocol` 包与单元测试套件。

---

### Milestone 2：Cordis 服务端插件 (`dsh-plugin-peripheral-server`) (v0.1.0)
- **目标**：完成 Harness 内部插件开发，跑通事件监听、槽位路由与 WebSocket 广播。
- **任务清单**：
  - [x] 实现 `SessionRouter`：F1-F12 槽位分配、会话释放与焦点跟踪逻辑。
  - [x] 实现 `PeripheralServerService`：基于 Cordis 微内核架构的插件类。
  - [x] 接入 DSH 事件源：订阅 `agent/status`、`agent/created`、`agent/disposed`、`interaction/user-questions`。
  - [x] 启动本地 WebSocket Server（`127.0.0.1:45678`），实现 JSON-RPC 指令分发（切换焦点、调节思考预算）。
  - [x] 编写集成测试：模拟 Agent 生命周期，验证 WebSocket 能够精准收到状态广播。
- **交付物**：符合 DSH 加载规范的独立 Cordis 插件。

---

### Milestone 3：Hardware Daemon 与多硬件适配器 (v0.5.0)
- **目标**：实现独立运行的守护进程，接入 Mock 模拟器、VIA 键盘与 Nuphy Air V3 键盘。
- **任务清单**：
  - [ ] 实现 `@dsh-hid/daemon` 核心客户端框架与自动重连机制。
  - [ ] 实现 `MockAdapter`：终端彩色 ASCII 模拟 12 键灯效与旋钮旋转。
  - [ ] 实现 `NuphyV3Adapter`（移植 `Keyphore` 逆向成果）：
    - [ ] 64 字节报文封装与 SessionKey XOR 加密。
    - [ ] 主背光与侧边指示灯状态写入。
  - [ ] 实现 `ViaRawhidAdapter`：32 字节 Raw HID 帧读写，支持 F 键与旋钮上报。
- **交付物**：包含 CLI 的硬件守护进程，支持 `--adapter=mock|nuphy|via` 参数。

---

### Milestone 4：全链路集成测试与发布打包 (v1.0.0 MVP)
- **目标**：完成端到端自动化联调，输出完整用户文档与安装包。
- **任务清单**：
  - [ ] 编写 E2E 测试套件：模拟并发多 Agent 任务，验证物理按键切换会话与状态灯联动。
  - [ ] 完善独立安装指南（`README.md` 与配置说明）。
  - [ ] 打包发布独立 npm 安装包与预构建 CLI 工具。
- **交付物**：可独立装载的正式发布版与全套工程文档。

---

## 3. 后续演进路线（Post-MVP / LTS Roadmap）

1. **LTS 阶段：硬件驱动下沉为 Rust**：
   - 将 `@dsh-hid/daemon` 的底层 USB/HID 通信部分重写为 Rust 单文件二进制，直接复用 `Keyphore` 的成熟 `hidapi` 逻辑，提供极致的内存与系统资源效率。
2. **DSH 侧边栏 UI 扩展**：
   - 在 DeepSeek Harness 桌面端或 Web 界面侧边栏挂载外设管理仪表盘，实现槽位重命名、灯光色彩微调与设备状态实时检视。
