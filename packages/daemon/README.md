# @dsh-hid/daemon

DeepSeek Harness (DSH) 独立硬件守护进程。负责连接 Harness 内的 `dsh-plugin-peripheral-server`，并将实时状态流式传输至物理或模拟外设，同时将物理按键/旋钮操作转化为标准 JSON-RPC 2.0 请求回传。

## 特性

- **自动重连机制**：具备指数退避（Exponential Backoff）重连能力，网络波动或服务重启无缝恢复。
- **多硬件适配器架构**：
  - `MockAdapter`：终端 ANSI 彩色 ASCII 模拟器，可视化 12 槽位灯效、当前会话、活跃工具与待审批提示。
  - `NuphyV3Adapter`：移植自 `Keyphore` 逆向成果，支持 64 字节动态 SessionKey XOR 加密握手与主灯/侧灯状态写入。
  - `ViaRawhidAdapter`：支持标准 QMK/VIA 32 字节 Raw HID 报文读写，处理 F1-F12 槽位切换与旋转编码器事件。

## 安装与使用

```bash
# 使用 Mock 终端模拟器启动
pnpm --filter @dsh-hid/daemon run build
node dist/cli.js --adapter=mock

# 连接自定义服务端口
node dist/cli.js --adapter=mock --url=ws://127.0.0.1:45678/peripheral/v1

# 指定物理硬件适配器
node dist/cli.js --adapter=nuphy
node dist/cli.js --adapter=via
```
