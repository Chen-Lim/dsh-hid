# dsh-plugin-peripheral-server

DeepSeek Harness (DSH) 官方 Cordis 服务端外设桥接插件。

运行于 DSH 宿主内部，将智能体生命周期、状态机翻转、槽位映射与交互决策通过轻量级本地 WebSocket 暴露给外部硬件守护进程（Daemon）。

---

## 核心特性

- **纯 TypeScript 实现**：不含任何原生 C++ 扩展，保障 DSH 宿主环境零崩溃传播风险与高稳定性。
- **F1-F12 物理按键槽位路由（SessionRouter）**：
  - 自动为新就绪的 Agent 实例分配 1~12 槽位。
  - 焦点跟踪与槽位保护：激活的焦点会话受保护，不被驱逐。
  - LRU 替换与溢出队列：超过 12 个并发会话时优雅下沉至溢出池，释放后自动递补。
- **DSH 核心生命周期与事件监听**：
  - 自动订阅 `agent/created`、`agent/disposed`、`agent/status`。
  - 深度集成 Human-In-The-Loop 审批交互（`interaction/user-questions`），将高危工具决策投射到外设物理键。
  - 实时工具执行跟踪（`agent/tool-start`, `agent/tool-end`）。
- **JSON-RPC 2.0 WebSocket 服务（PeripheralWsServer）**：
  - 强制绑定 `127.0.0.1:45678` 本地回环，隔绝外部网络风险。
  - 客户端握手即时推送全量快照（`peripheral/snapshot`）。
  - 支持增量状态广播（`peripheral/slotUpdated`、`peripheral/focusChanged`）。
  - 双向指令调度：支持客户端一键切会话（`switchFocus`）、旋钮无级调档（`setBrainpower`）、选项决策（`selectOption`）及紧急中止（`abort`）。

---

## 安装与配置

在 DSH 项目中通过 pnpm 安装：

```bash
pnpm add dsh-plugin-peripheral-server
```

在 `cordis.yml` 中配置启用：

```yaml
plugins:
  peripheral-server:
    host: 127.0.0.1
    port: 45678
    path: /peripheral/v1
    totalSlots: 12
    autoBindSlots: true
```

或者在 Cordis 上下文中以代码形式装载：

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

## 测试

```bash
pnpm test
```
