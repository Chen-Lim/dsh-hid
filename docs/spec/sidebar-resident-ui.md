# 侧栏常驻改造方案：dsh-plugin-peripheral-server

> 目标：让 `dsh-plugin-peripheral-server` 在 DeepSeek Harness（DSH）Web / 桌面端的**左侧栏常驻**——页面加载即出现入口，侧栏收起后仍在图标栏，点击进入外设状态面板，且状态随 Host 实时更新。
>
> 本文只做**改动面分析**，不含实现代码。所有槽位名、props、服务方法均以当前运行实例的检查结果为准（`cordis_inspect_query` 的 `Slots` / `Service` / `Config`）。

---

## 0. 结论速览

| 改动面 | 必要性 | 现状 |
| --- | --- | --- |
| 客户端半（`dsh.client` + `client.js`） | **必须** | 完全没有，当前是纯 Host bundle |
| `sidebar.panellist` + `main` 槽位注册 | **必须** | 无任何 UI 注册 |
| 面板块的状态通道（Host → 浏览器） | **必须** | 只有给硬件 daemon 的 `:45678` WS，没有 UI 可读面 |
| 区分「硬件客户端」与「页面客户端」 | **必须** | `isPeripheralAvailable` 以 `getClientCount() > 0` 为判据 |
| Host 启动可靠性（幂等 / 端口占用 / 失败可观测） | **必须（前置）** | 双启动 + 未捕获 rejection，且失败无状态可展示 |
| 面板动作（切焦点 / 中止 / 重连） | 建议 | 已有 RPC handler，可复用 |
| i18n（`meta.title`/面板文案）+ 图标 | 必须（交付规范） | 缺失 |
| 打包白名单、安装脚本、双 profile 校验 | **必须** | `files` 只含 `dist` + patch |
| 配置项（`ui.enabled` / 顺序 / 路径） | 建议 | 只有 `host/port/path/totalSlots/autoBindSlots` |
| 测试与验收（含负向：审批不被面板劫持） | **必须** | 无 UI 用例 |

一句话：**这不是「加一个图标」的改动，而是把插件从「Host-only bundle」升级为「Host + Client bundle」，并先修掉会污染现有审批链路的通道设计。**

---

## 1. 现状与阻塞点

### 1.1 包形态：装出来的包不可能出现在侧栏

`packages/server/package.json`：

- `exports` 只有 `.`、`./cordis.patch.yml`、`./package.json`（[package.json:8](../../packages/server/package.json)）；
- `files` 只有 `dist` 与 `cordis.patch.yml`，客户端资源与 locale/icon 不会被 `pnpm pack` 带走；
- `dsh` 只有 `bundle.patch`，**没有 `dsh.client`**，所以 Web 端的 `clientModules` 不会为它生成任何浏览器模块。

结论：无论怎么在侧栏里点，都不会有这个插件的位置——浏览器侧根本不知道它存在。

### 1.2 状态面：面板没有可读的状态，而唯一通道带有语义副作用

- 可见状态（槽位、焦点、待审批问题）目前只通过 `PeripheralWsServer`（`ws://127.0.0.1:45678/peripheral/v1`）广播，`PeripheralServerService` 的 `isRunning()/getPort()/getClientCount()` 只是类方法，没有对外读取面（[ws-server.ts:356-378](../../packages/server/src/ws-server.ts)）。
- 这条 WS 同时是审批仲裁的**在线判据**：
  `isPeripheralAvailable: () => this.forceArbitration || this.wsServer.getClientCount() > 0`（[service.ts:182](../../packages/server/src/service.ts)）。
- 因此：**如果让侧栏面板直接连这个 WS，`clientCount` 会永久 ≥ 1**，`ApprovalArbiter` 会把每一次 `approval/request` 都转成硬件仲裁（广播 `NEEDS_INPUT` 并等待物理按键），而 Web UI 的审批卡会被降级甚至挂住。

这是本方案最重要的一条约束：**UI 不能以「硬件 daemon」的身份接入**。

### 1.3 生命周期：常驻组件需要「服务未启动」也是一个正常状态

- 构造函数里 `void this.start()`（[service.ts:206](../../packages/server/src/service.ts)）与 `[Service.init]`（[service.ts:473](../../packages/server/src/service.ts)）都会启动；
- `PeripheralWsServer.start()` 只用 `started: boolean` 做幂等（[ws-server.ts:75](../../packages/server/src/ws-server.ts)），**在 `listening` 之前重复调用会创建两个 `WebSocketServer`**，第二个大概率 `EADDRINUSE`；
- 构造函数里的 `void start()` 没有 `.catch()`，端口被占用时是一次未捕获的 rejection；若走 `[Service.init]`，插件行可能直接激活失败。

常驻侧栏的意义是「一直看得见」，因此启动失败必须变成**面板上可见的状态 + 可重试**，而不是插件消失或宿主日志里的一条异常。

### 1.4 其他缺口

- 无 `main` 面板，无图标、无 `locale/meta.*`，Plugin Manager 里没有可辨识的标题/描述/图标（交付规范要求）。
- `scripts/install-to-dsh.sh` 打的是 `pnpm pack` 产物；即使加了客户端文件，只要 `files` 不更新，装进 profile 的 tgz 里仍然没有它们。
- 文档中「侧栏面板」目前只是规划（[plugin-cordis.md:76](./plugin-cordis.md)、[timeline.md:71](../timeline.md)），没有落到槽位与通道。

---

## 2. 「常驻」的可验收定义

先定义清楚，后续改动才有边界：

1. 打开或刷新 DSH 页面后，左上侧栏**首次渲染**即出现外设入口，不需要先打开面板、不需要先进入某个会话。
2. 侧栏折叠成图标栏后，入口**仍然存在**（图标 + tooltip/可访问名）。
3. 点击入口切到 `main` 的 `peripheral` 面板；再点会话不丢连接、不重置滚动位置之外的状态（状态在 root 作用域，随页面存活）。
4. 面板内容与硬件 daemon 看到的是**同一份**状态（同一 `SessionRouter` 快照），不各自折叠事件。
5. daemon 未连接 / 服务未启动 / 端口被占用时，入口不消失，而是显示降级态（灰点、错误文案、重试按钮）。
6. 该入口的存在**不改变**现有行为：无硬件时审批仍走 Web UI；有硬件时仲裁语义不变。
7. 会话、工作区切换不影响入口；跨刷新保持可用（选中态是否持久见 §7）。

---

## 3. 必须的改动

### 3.1 包清单：从 Host-only 升级为 Host + Client

`packages/server/package.json` 需要新增（示意，非最终代码）：

```json
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./client": "./dist/client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["dist", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": [] }
  }
}
```

要点：

- `dsh.client.platform` 必须是 `web`；`immediately: true` 让客户端半在启动时就加载，而不是等某个懒加载入口——这是「常驻」的前提。
- 客户端产物必须是 `window.__ModuleLoader__.load({ id: <包名>, factory(require) {...} })` 形式，且 **`id` 精确等于包名**；工厂内只能 `require('react')` 这类浏览器模块表内的依赖，不能 import `cordis` / Node 内置模块。
- `dsh.client.inject` 列的是**其它客户端包**（只影响激活次序），不是服务名。侧栏槽由外壳声明；不确定依赖哪个客户端包时留空即可，靠下面插件对象里的 `inject: ['slots']` 与 `ctx.slots.inject` 保证拿到槽位。
- `exports` / `files` 必须同步更新，否则 `pnpm pack` 后 `client.js` 与 `locale`、`icon.svg` 全部丢失（见 §3.8）。

### 3.2 客户端的两个槽位

当前实例的槽位契约（`Slots.listSubTree`）：

- `sidebar.panellist`（list，root 作用域，purpose = "Global panel icons"）
  - 注册参数：`id`（必填）、`order`、`label`（string 或 thunk，每次投影重新读取，便于跟随语言）；
  - 目录说明：**「Each list id addresses the matching main panel; the sidebar owns the button and resolves its label from list metadata」**；
  - 组件 props：`{ size: number; active: boolean }`（`SidebarPanelIconOwnerProps`）；
  - 现有占用者：`plugins`（order 0）、`schedules`（order 10），新 id 会作为新格子并排出现，复用别人的 id 会**替换**它。
- `main`（keyed，root 作用域，purpose = "Central panel selected by sidebar entry id"）
  - 注册参数：`key`（必填），`conversation` 为保留键，其它 key 不绑定 Session；
  - 现有占用者：`plugins`、`conversation`、`schedules`。

因此需要：

1. 在 `sidebar.panellist` 注册 `id: 'peripheral'`（建议 order 20，排在 `schedules` 之后），第二个参数是**图标组件**（16px 级别的方形图标，随 `size` 缩放，用 `active` 做选中态）。按钮本身、折叠态、tooltip、可访问名都由侧栏外壳负责，图标里**不要再放可交互元素**（否则出现嵌套按钮与焦点错乱）。
2. 在 `main` 注册 `key: 'peripheral'`，渲染完整面板。两者 id/key 必须一致，否则点击入口后主区空白。
3. 用 `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(...))`，不要直接 `register`：槽位声明坍缩/回归时注册会被正确销毁与重装。
4. 面板组件要按 `main` 的定位来设计：**它会占据中央整列，且没有 Session 绑定**。需要自己处理无会话、无 daemon、服务未启动三种空态，自己管理滚动容器与内边距，样式对齐 Plugins 页的管理列表（行高、分段标题、卡片边界）。
   另外：组件抛错会让**整个槽位条目变空**（控制台 `slot entry crashed in '<slot>'`），所以面板要自带错误边界（降级为一行错误提示 + 重试），图标组件更是只能依赖已校验过的快照数据。
5. 可选增强：
   - `sidebar.panellist.actions`（list）：在面板列表的 More 菜单里加「重连外设服务」「复制端口」等行；
   - `sidebar.footer.action`（list）：如果更希望它像 Settings 一样贴在侧栏底部（但这不是「条目常驻」，只是入口常驻，按需求取舍）。
6. 状态徽标：图标组件应自带聚合指示（`NEEDS_INPUT` → 琥珀点、`ERROR` → 红点、未连接 → 灰点）。这要求连接与状态 store 在 `apply(ctx)` 里创建（root 作用域），而不是挂在面板组件的 `useEffect` 里——否则面板没打开就没有徽标。

### 3.3 状态通道：三种方案与取舍

| 方案 | 做法 | 优点 | 代价 / 风险 |
| --- | --- | --- | --- |
| **A. 浏览器直连 `:45678`** | 面板作为 WS 客户端接现有 JSON-RPC | 零 Host 改动，协议现成 | ① 页面的 `clientCount` 会污染审批判据（§1.2）；② `127.0.0.1` 在远程访问/隧道场景指向用户机器，面板直接失效；③ UI 与 daemon 同权，写接口暴露面变大 |
| **B. Host 同源只读通道（推荐）** | 用 Host 的 `webServer.register(route)` / `registerUpgrade(route)` 暴露 `GET /peripheral/ui/snapshot` 与 `WS /peripheral/ui/stream` | 与页面同源（远程访问也成立）、鉴权沿用 DSH 的连接准入、和 daemon 通道彻底分离、不参与 `isPeripheralAvailable` | 需要新增 Host 路由与生命周期管理；`webServer` 需声明为可选依赖 |
| **C. Typert Remote（`@Remote`）** | 在 Host 服务方法上加 Remote 装饰器，客户端经 `ctx.remote.*` 调用 | 与 DSH 官方 RPC 面一致；「面板动作 = Agent 工具动作」可共用同一入口 | 需要 typert 注册/生成链路，纯本地插件成本偏高；不适合高频状态流（流式订阅要额外形态） |

**建议**：P0 用 B（只读快照 + 流），把 A 仅作为本地调试兜底，C 留作后续把「面板动作」与「Agent 工具」统一时的演进路径。

如果最终仍要做 A（例如想少写 Host 代码），则必须先改协议与判据：

- 握手时增加客户端角色（`hello { role: 'daemon' | 'ui' }`），服务端分别计数；
- `isPeripheralAvailable` 改成 `hardwareClientCount > 0`（[service.ts:182](../../packages/server/src/service.ts)），并补一条「UI 连接不得触发仲裁」的测试；
- UI 角色只允许只读方法与受控写方法（见 §3.6）。

### 3.4 Host 侧新增的可观测面

面板要显示的东西，Host 必须能一次给出，且与 daemon 同源：

```ts
interface PeripheralUiSnapshot {
  server: {
    state: 'starting' | 'listening' | 'error' | 'stopped'
    host: string; port: number; path: string
    error?: { code: string; message: string }
    retryCount: number
  }
  hardwareClientCount: number        // 只统计 daemon，不统计 UI
  focusedSlot: number
  slots: SlotInfo[]                  // 直接来自 SessionRouter
  pendingApprovals: number           // 供面板提示，不提供决策
  protocolVersion: string
  updatedAt: number
}
```

- 数据来源：`router.getSnapshot()` / `onSlotUpdate` / `onFocusChange`（已有），加上 WS 服务端新增的 `listening` / `error` / `close` / `hardwareClientCount` 变化事件（需在 `PeripheralWsServer` 里补事件回调）。
- 推送策略：首帧全量快照 + 增量帧；服务端合并高频更新并节流（建议 ≤ 10Hz），断线重连后重新下发全量。
- 只读原则：通道只暴露状态；所有写操作走 §3.6 的白名单方法，不在通道层实现业务逻辑。

### 3.5 启动与容错的改造（前置条件）

- `start()` 做真正的幂等：缓存 in-flight promise（`starting?: Promise<void>`），避免构造函数与 `[Service.init]` 双启动。
- 端口占用等错误：捕获后置 `server.state = 'error'`，按退避策略重试（如 1s / 2s / 5s / 10s，上限后停止并等待手动重试），**不得 reject 插件加载**。
- 去掉裸的 `void this.start()`，或至少 `.catch()` 后落到状态机。
- `dispose` 时：广播 `peripheral/serverShuttingDown`、关闭 UI 通道、清理重试定时器（现有 `stop()` 已覆盖大部分）。
- 面板提供「重试」按钮，调用同一个 `start()`；失败原因直接展示（`EADDRINUSE` 比「未连接」有用得多）。

### 3.6 面板动作与审批边界

| 动作 | 是否允许从面板发起 | 约束 |
| --- | --- | --- |
| 切换焦点（`switchFocus`） | 允许 | 复用 service 的 `onSwitchFocus`，不要复制分支逻辑；UI 侧通过 layout/会话服务完成真正的跳转 |
| 调整 brainpower（`setBrainpower`） | 允许 | 纯状态，复用现有 handler |
| 中止（`abort`） | 谨慎 | 需二次确认，且要说明「只中止该槽位」 |
| 重连 / 复制端口 / 查看日志 | 允许 | 属于运维动作 |
| **审批决策（ACCEPT/REJECT）** | **不允许走仲裁旁路** | 面板若提供审批，必须复用 DSH 自己的审批回答路径（`approval/request` 的 answerer），**不能调用 `arbiter.resolveBySlotOption`**，否则会出现 UI 与硬件双决议、派生 signal 被提前 abort 的竞态 |

同时：UI 通道的连接不得计入 `hardwareClientCount`，也不得让 `ApprovalArbiter` 认为「硬件在线」。

### 3.7 配置

建议在现有 `PeripheralServerConfig` 上增加一组 UI 配置（默认开启，否则不叫常驻）：

```ts
ui?: {
  enabled?: boolean          // 默认 true；false 时不注册槽位、不开路由
  sidebarOrder?: number      // 默认 20
  streamPath?: string        // 默认 '/peripheral/ui'
  pushIntervalMs?: number    // 默认 100（≤10Hz）
}
```

- 通过 `Config`（`$defs` / JSON Schema）声明，用户在 profile 的 `cordis.patch.yml` 里可覆盖；
- 改完用 `Config.listConfigs`（`name: dsh-plugin-peripheral-server`）核对投影后的 schema 与默认值；
- `cordis.patch.yml` 里那一行 `insert: peripheral-server` **不需要新增行**：客户端半由 `dsh.client` 声明，搭同一条插件行加载；只有默认值需要改时才动 `config`。

### 3.8 打包、安装与升级

- `files` 必须包含 `dist`（含 `client.js`）、`cordis.patch.yml`、`locale/*.json`、`icon.svg`；
- `scripts/install-to-dsh.sh` 打完包后应加一步 `tar -tzf` 断言这些文件确实在包里（现在只改 `package.json` 依赖，不校验内容清单）；
- 安装仍需覆盖 **desktop 与 web 两个 profile**（脚本已有）；
- 升级语义：**替换已安装包需要重启 DSH 才能加载新的浏览器模块代**；`dsh.client` 的 HMR 重建只在 `pnpm run dev:web` 同时运行时生效，普通安装后必须刷新/重启页面；
- 安装结果以 `plugin_manager` 返回的 `application` 与 `warnings` 为准，不要用日志或进程判断。

### 3.9 测试与验收

单元 / 集成：

- `start()` 幂等：并发两次只创建一个 server；
- 端口占用：状态变 `error`、有 `retryCount`、插件加载不 reject；
- UI 通道：未启用时 404；启用时快照字段完整、断线重连拿到全量；
- 负向（关键）：**面板连接中，无 daemon 时 `approval/request` 仍走 UI**（`isPeripheralAvailable === false`）；
- 负向：UI 角色连接不改变 `hardwareClientCount`；
- 节流：1 秒内 200 次 `slotUpdated` → 推送帧数受限且最后一帧是终态。

人工 / 页面验收（按 §2 逐条）：

1. 打开页面 → 侧栏出现 `peripheral` 图标；`cordis_inspect_query` 查 `Slots.listSubTree(root: 'sidebar.panellist')`，`occupants` 里应有 `id: peripheral`；
2. 查 `main`，`occupants` 里应有 `key: peripheral`；
3. 点击 → 中央切到面板；再点会话 → 回到 Conversation，图标徽标仍在更新；
4. 折叠侧栏 → 图标仍在，tooltip 有可读名称；
5. 杀掉 daemon → 面板与图标降级；重启 daemon → 自动恢复，无需刷新；
6. 占用 45678 后重启插件 → 面板显示端口错误与重试；
7. 中英文切换 → 面板与 `meta.title` 跟随（`ctx.locale`）；
8. 浅色/深色切换 → 只用 `--dsw-alias-*` token，无硬编码颜色。

---

## 4. 文件级改动清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `packages/server/package.json` | 改 | `exports`（`./client`、`./locale/*.json`、`./icon`）、`files`、`dsh.client`、`Config` 依赖 |
| `packages/server/cordis.patch.yml` | 一般不改 | 客户端半随同一行加载；仅默认配置变更时动 `config` |
| `packages/server/src/index.ts` | 改 | 导出 UI 快照类型等公共面 |
| `packages/server/src/service.ts` | 改 | 幂等启动、错误状态、`getUiSnapshot()`、UI 通道生命周期挂载 |
| `packages/server/src/ws-server.ts` | 改 | 状态事件（listening/error/close）、硬件客户端计数（若走方案 A 则含角色握手） |
| `packages/server/src/ui/snapshot.ts` | 新增 | 快照聚合与节流（纯函数，便于单测） |
| `packages/server/src/ui/route.ts` | 新增 | `webServer.register` / `registerUpgrade` 路由与准入 |
| `packages/server/client/*.js`（产物 `dist/client.js`） | 新增 | 图标、面板、状态 store、WS 客户端；`__ModuleLoader__` 格式，id = 包名 |
| `packages/server/locale/en.json`、`locale/zh.json` | 新增 | `meta.title`/`meta.description` + 面板文案命名空间 |
| `packages/server/icon.svg` | 新增 | 原创或许可证允许的图标（≤256 KiB） |
| `packages/server/tsconfig.json` / 构建脚本 | 改 | 若客户端用 esbuild/tsup 产出单文件，需要新增一步；纯 JS 则只需拷贝 |
| `scripts/install-to-dsh.sh` | 改 | 打包后校验文件清单（`tar -tzf`） |
| `packages/server/test/*` | 新增 | §3.9 的单元/集成用例 |
| `docs/spec/plugin-cordis.md`、`docs/README.md` | 改 | 把「Future UI Extension」指向本文 |

建议构建别引入重工具链：客户端半写成浏览器可直接执行的脚本（`__ModuleLoader__` 包装，不是独立 ESM 入口），用一个拷贝步骤放进 `dist/`，比给整个包引入打包器更稳；若坚持用 TS 写，用 esbuild 单文件输出再套包装，别让 `tsc` 直接吐 `import` 语句。

---

## 5. 分阶段落地

**P0（最小可常驻，1 个 PR）**
1. 修启动幂等与错误状态（§3.5）——否则面板只能展示「加载失败」；
2. Host 同源只读通道 + `PeripheralUiSnapshot`（§3.3 B、§3.4）；
3. `package.json` 清单 + `client.js`：`sidebar.panellist` 图标 + `main` 面板只读展示槽位/焦点/连接状态；
4. 安装进 desktop profile，按 §3.9 的 1–5 条验收。

**P1（可用面板）**
5. 面板动作（focus / reconnect / abort 二次确认），复用 service handler（§3.6）；
6. i18n + 图标 + `meta.*`，Plugin Manager 卡片可辨识；
7. 节流、空态、错误态、单测与 E2E 补齐。

**P2（可选演进）**
8. 若要把面板动作与 Agent 工具统一，迁到 Typert Remote（§3.3 C）；
9. 如果确实需要浏览器直连硬件通道，再补 daemon/UI 角色握手与协议版本演进（`PROTOCOL_VERSION` 已是 `0.1.0-alpha`，改动成本可控）。

---

## 6. 风险与待确认

| 项 | 影响 | 处理 |
| --- | --- | --- |
| 面板选中态是否跨刷新保持 | 影响「常驻」体感 | 由外壳 layout 管理，插件不要自己持久化；先实测，再决定是否读/写布局状态 |
| 远程访问（隧道 / 局域网打开 GUI） | 方案 A 直接失效 | 选方案 B；A 仅限本机调试 |
| `sidebar.panellist` 在折叠态的可读名 | 无障碍与可发现性 | `label` 用 thunk 走 `ctx.locale`，不要写死中文 |
| 常驻连接的空转开销 | 10Hz × 12 槽位很轻，但别做全量重渲染 | 快照浅比较 + 只订阅用到的切片 |
| 两个 patch 层都存在 `peripheral-server` 行 | 重复 insert 行为需实测 | 保持包内 patch 与 profile patch 只改 `config`，不重复声明插件 |
| 打包后客户端资源缺失 | 页面静默无入口 | `tar -tzf` 断言 + 安装后查 `clientModules.graph()` 是否含该包 |
| 替换已安装包的模块代 | 新的 client 代码不生效 | 明确要求重启 DSH，不承诺 HMR 自动生效 |

---

## 7. 验收标准（DoD）

- [ ] 页面首屏即出现侧栏入口，折叠态仍可见；
- [ ] `Slots.listSubTree` 中 `sidebar.panellist` 有 `id: peripheral`，`main` 有 `key: peripheral`；
- [ ] 面板状态与 daemon 一致，daemon 起停能自动恢复；
- [ ] 端口占用时面板显示具体错误并可重试，插件行不失败、宿主无未捕获 rejection；
- [ ] 面板开启时，无硬件场景的审批仍由 Web UI 完成（回归用例）；
- [ ] 中英文、浅色/深色、无会话、无 daemon 四种组合下均无布局崩坏；
- [ ] 打包产物包含 `client.js`、`locale/*.json`、`icon.svg`，desktop 与 web profile 安装成功。
