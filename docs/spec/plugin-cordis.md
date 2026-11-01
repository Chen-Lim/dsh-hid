# Cordis 插件技术规范 (Cordis Plugin Specification)

## 1. 插件定位与交付方式

- **包名称**：`dsh-plugin-peripheral-server`
- **形态**：独立的 npm 包与 Cordis 插件模块，可通过 DSH 插件机制或 `cordis.yml` 独立装载。
- **环境要求**：Node.js >= 20，运行于 DeepSeek Harness 进程上下文内，不依赖任何原生 C++ 二进制扩展。

---

## 2. Cordis 服务注入与生命周期管理

### 2.1 服务注册
插件继承 Cordis 微内核的 `Service` 类，以确保状态独立性与依赖注入支持：

```typescript
import { Context, Service } from 'cordis'

export interface PeripheralServerConfig {
  port?: number        // 默认 45678
  host?: string        // 默认 '127.0.0.1'
  maxSlots?: number    // 默认 12 (对应 F1-F12)
  autoBindSlots?: boolean // 默认 true (自动为新建会话分配槽位)
}

export class PeripheralServerService extends Service {
  static inject = ['agentLoop', 'session']

  constructor(ctx: Context, config: PeripheralServerConfig) {
    super(ctx, 'peripheralServer', true)
    // 初始化槽位路由管理器与 WebSocket Server
  }
}
```

### 2.2 生命周期与安全释放 (Reversible Disposables)
当 DSH 执行热重载（HMR）或插件被卸载时，必须干净释放所有句柄：
- 在 `ctx.on('dispose')` 触发时：
  1. 向所有已连接的 Daemon 发送 `peripheral/serverShuttingDown` 广播通知。
  2. 干净关闭 WebSocket 监听套接字与现有 Client 连接。
  3. 清除全部待处理的超时定时器。

---

## 3. DSH 核心事件监听与状态聚合

插件通过 Cordis 上下文监听以下生命周期事件：

### 3.1 会话与槽位生命周期
- **`agent/created`**：
  - 当新 Agent 实例进入就绪状态时，`SessionRouter` 查找首个空闲槽位（1~12），建立 `slotIndex <-> agent.id` 映射。
  - 触发广播 `peripheral/slotUpdated`。
- **`agent/disposed`**：
  - 当 Agent 被销毁或会话结束，释放对应槽位，置状态为 `INACTIVE` 并广播。

### 3.2 运行与交互状态流转
- **`agent/status`**：
  - 监听状态翻转：`idle` ⇄ `running`。
  - 映射为 `IDLE` 或 `RUNNING` 状态并推送。
- **用户问答与选项交互 (`interaction/user-questions`)**：
  - 当 Agent 抛出结构化选项列表时，更新该槽位状态为 `NEEDS_INPUT`，并将选项数据（Options 1..3）挂入槽位快照。
- **工具调用与结果 (`tools/result`)**：
  - 若调用抛错或被中断，将槽位状态短暂置为 `ERROR`。

---

## 4. 槽位路由算法 (Slot Router Logic)

1. **槽位固定与保护**：
   - 用户当前在界面中激活操作的会话强制标记为 `focusedSlot`。
2. **LRU 替换策略**：
   - 当并发会话超过 12 个时，仅活跃（Running 或最近触发事件）的前 12 个会话保留在 F1-F12 物理按键槽位，多余会话进入溢出池，可通过界面手动调配。

---

## 5. 侧边栏面板扩展接口 (Future UI Extension)

在 MVP 达成后，插件将支持在 DSH Web / 桌面端侧边栏注册配置面板：
- **设备连接状态指示灯**：展示当前连接的 Daemon 数量与硬件型号（VIA / Nuphy）。
- **槽位可视化映射表**：直观查看 F1~F12 绑定的 Session 名称、Token 消耗与当前状态。
- **物理按键行为自定义**：支持用户在 UI 上微调 F 键的长按/短按行为与旋钮灵敏度。
