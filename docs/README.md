# Project Micro-Bridge (`dsh-hid`) 文档中心

欢迎查阅 **DeepSeek Harness 外设协同生态（dsh-hid）** 项目文档。本项目旨在通过标准协议连接 DeepSeek Harness 与物理可编程硬件（如 VIA/QMK 机械键盘、Nuphy 键盘），实现多 Agent 状态实时监控与物理交互。

---

## 📚 文档目录与索引

| 模块类别 | 文档路径 | 核心内容概述 |
| --- | --- | --- |
| **战略与需求** | [`docs/mrd&prd.md`](./mrd&prd.md) | 市场需求分析 (MRD) 与产品需求规格书 (PRD)，背景与设计原则。 |
| **系统架构** | [`docs/spec/architecture.md`](./spec/architecture.md) | 三层解耦架构模型、进程间通信隔离、安全性与容错设计。 |
| **按键与灯效** | [`docs/spec/keymap-and-lighting.md`](./spec/keymap-and-lighting.md) | F1-F12 槽位分配、单键 RGB 状态矩阵、旋钮思考强度调节与快速响应键。 |
| **通讯协议** | [`docs/spec/protocol.md`](./spec/protocol.md) | WebSocket JSON-RPC 2.0 契约、VIA 32-Byte Raw HID 与 Nuphy 64-Byte 协议。 |
| **插件技术规范** | [`docs/spec/plugin-cordis.md`](./spec/plugin-cordis.md) | Cordis 服务端插件接口、DSH 核心事件监听、生命周期与侧边栏扩展规划。 |
| **排期与里程碑** | [`docs/timeline.md`](./timeline.md) | 研发排期时间线、Milestone 1~4 交付清单与 LTS 演进规划（Rust 核心重构）。 |

---

## 🎯 快速阅读指引

- **初次接入或了解方案**：请先阅读 [`docs/spec/architecture.md`](./spec/architecture.md) 了解系统分层边界。
- **键盘固件与驱动开发者**：请重点查阅 [`docs/spec/keymap-and-lighting.md`](./spec/keymap-and-lighting.md) 与 [`docs/spec/protocol.md`](./spec/protocol.md)。
- **Harness 插件开发者**：请重点查阅 [`docs/spec/plugin-cordis.md`](./spec/plugin-cordis.md)。
- **项目推进与版本计划**：请查阅 [`docs/timeline.md`](./timeline.md)。
