# NuPhy Air V3 (S4) 硬件通信协议白皮书 (Official S4 Protocol Whitepaper)

> **版本**：v1.0（基于 `Air75-V3-RGB-Lab` 官方驱动源码与固件逆向证据提炼）  
> **适用硬件**：NuPhy Air75 V3 ANSI (`19f5:1028`)、NuPhy Air65 V3 (`19f5:102b`)  
> **适用固件族**：NuPhy S4 协议族 `1.x.x.6`（重点覆盖量产版 `1.0.16.6` 与 `1.0.23.6`）

---

## 1. 概述与设计原则

本白皮书从官方开源项目 `Air75-V3-RGB-Lab`（`native/PROTOCOL.md`、`native/HIDBridge.swift`、`docs/FIRMWARE_COMPATIBILITY_20261015.md`）中提炼出 **NuPhy S4 用户态 USB HID 协议** 的完整字节级规范，作为 `dsh-hid` 原生 Swift 6 守护进程（以及后续跨平台驱动）的唯一硬件标准与测试基准（Gold Standard）。

### 核心安全准则
1. **无损只读会话推导（No `0xEE` Mutation）**：严禁发送 `0xEE` 覆写键盘 RAM 中的 SessionKey、严禁发送 `0xEF` 等固件刷写/IAP 指令。所有连接通过只读 `0xA1` 推导现有 SessionKey。
2. **先备份后修改（Journaled Mutation）**：在发送任何改变灯光（`0xD6` / `0xD8`）或键位（`0xB3`）的指令前，必须先通过只读探针（`0xA1` ➔ `0xA0` ➔ `0xD1` ➔ `0xD5` ➔ `0xD2`）完成全量状态读取，并以 `O_EXCL` 原子锁落盘备份文件。
3. **禁止盲目重发（No Blind Retry）**：当写操作发生超时或未知响应时，绝不盲目重发写指令，而是立即回读校验或触发状态恢复（Rollback）。
4. **禁止独立写 `address=1` 亮度**：必须使用完整的 17/22 字节 `0xD6` 状态写入（`address=0`），单独写 `address=1` 会导致固件内部重缩放 RGB 字节产生色彩失真。

---

## 2. 物理传输层与 64 字节通用帧结构

### 2.1 USB HID 接口匹配
- **Vendor ID (`VID`)**：`0x19f5` (6645)
- **Product ID (`PID`)**：
  - Air75 V3 ANSI：`0x1028` (4136)
  - Air65 V3：`0x102b` (4139)
- **Usage Page / Usage**：`PrimaryUsagePage = 0x0001` (Generic Desktop), `PrimaryUsage = 0x0000` (Undefined)
- **Report 尺寸**：`MaxInputReportSize = 64`, `MaxOutputReportSize = 64`, `ReportID = 0`
- **多实例互斥锁**：在 macOS/POSIX 下使用 `/tmp/air75-studio-hid-<uid>.lock` (`flock(LOCK_EX | LOCK_NB)`) 防止多进程并发抢占 USB 接口。
- **蓝牙枚举（只读/系统映射）**：蓝牙模式下 `VendorID = 2007 (0x07d7)`, `ProductID = 0`, `PrimaryUsagePage = 1, PrimaryUsage = 6`，仅暴露标准键盘/多媒体 HID 报表，不暴露 64 字节 S4 RGB 管道。

### 2.2 64 字节报文格式 (Frame Layout)

所有上下行报文均为固定 **64 字节**（索引 `0..63`）：

| 字节偏移 | 字段名称 | 下行请求 (Host ➔ Device) | 上行响应 (Device ➔ Host) | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `Byte 0` | `marker` | `0x55` | `0xAA` | 固定帧头方向标识 |
| `Byte 1` | `command` | `opcode` | `opcode` | 指令码（见 2.3 允许列表） |
| `Byte 2` | `reserved` | `0x00` | `0x00` | 必须为 `0x00` |
| `Byte 3` | `checksum` | $\sum_{i=4}^{63} \text{Byte}[i] \bmod 256$ | $\sum_{i=4}^{63} \text{Byte}[i] \bmod 256$ | 8 位无符号累加溢出校验和 |
| `Byte 4` | `length` | `len ^ key` | `len ^ key` 或 `len` | 有效载荷字节数（`0..56`） |
| `Byte 5` | `addr_lo` | `(address & 0xFF) ^ key` | `(address & 0xFF) ^ key` 或 `addr_lo` | 16 位寄存器/偏移地址低字节 |
| `Byte 6` | `addr_hi` | `((address >> 8) & 0xFF) ^ key` | `((address >> 8) & 0xFF) ^ key` 或 `addr_hi` | 16 位寄存器/偏移地址高字节 |
| `Byte 7` | `handle` | `handle ^ key` | `handle ^ key` 或 `handle` | 路由句柄（`D5/D6/D8` 为 Mac `0` / Win `1`，其余为 `0`） |
| `Bytes 8..(8+len-1)` | `payload` | `payload[i] ^ key` | `payload[i] ^ key` | 经 `key` 按位异或编码的数据体 |
| `Bytes (8+len)..63` | `padding` | `0x00` | `0x00` | **未加密填充区**（固定为 `0x00`，不与 `key` 异或） |

> [!IMPORTANT]
> **响应路由双模式兼容**：在验证设备响应的 `Bytes 4..7`（`rawRoute`）时，部分固件版本返回明文 `[length, addr_lo, addr_hi, handle]`，部分返回与 `key` 异或后的字节。解码器必须同时接受 `rawRoute == route` 或 `rawRoute.map(^key) == route`。

### 2.3 指令白名单 (Allowed Opcodes)

| Opcode | 名称 | 方向 | `length` | `handle` | 用途 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `0xA1` | `Identify` | 读 | `8` | `0` | 读取 8 字节固件信息并无损推导当前 RAM `SessionKey` |
| `0xA0` | `Geometry` | 读 | `8` | `0` | 读取当前 Mac(`0`)/Win(`1`) 物理开关档位及矩阵几何参数 |
| `0xD1` | `LEDCount` | 读 | `1` | `0` | 读取总灯珠数量（Air75 V3 固定为 `104`） |
| `0xD5` | `ReadState` | 读 | `17` 或 `22` | `0` 或 `1` | 读取指定档位的完整背光与侧灯状态寄存器 |
| `0xD6` | `WriteState` | 写 | `17` 或 `22` | `0` 或 `1` | 写入指定档位的背光与侧灯状态（设备回显写入字节） |
| `0xD8` | `WriteRGB` | 写 | `4 × N` ($N \le 13$) | `0` 或 `1` | 按 `[ledIndex, R, G, B]` 刷写主键区自定义 RGB（索引 `0..83`） |
| `0xD2` | `ReadRGB` | 读 | $\le 54$ (共 `312`) | `0` | 分片读取 104 颗 LED 的当前已渲染 RGB 输出（312 字节） |
| `0xB1` | `ReadDefaultKeys` | 读 | $\le 56$ (每层 `196`) | `0` | 读取出厂默认键位表（Layer 0 为 Mac，Layer 4 为 Win） |
| `0xB2` | `ReadActiveKeys` | 读 | $\le 56$ (每层 `196`) | `0` | 读取用户当前生效键位表（Layer `mode * 4`） |
| `0xB3` | `WriteKey` | 写 | `2` | `0` | 仅限受控租用/恢复 Mac 基层 F4 键位（`0x7e07` $\leftrightarrow$ `0x003d`） |

---

## 3. 会话握手、固件识别与档位路由

### 3.1 `0xA1` 无损密钥推导与固件解析
1. Host 发送 `0xA1` 请求（`length = 8, address = 0, handle = 0, key = 0`）。
2. 校验响应满足 `raw[0] == 0xAA`、`raw[1] == 0xA1`、`raw[3] == checksum(raw)`。
3. **推导 `SessionKey`**：由于固件信息 Payload 的第 3 字节（即报文的 `raw[8 + 3] = raw[11]`）恒为常量标记 `0xAA`，因此当前键盘的 XOR 密钥为：
   $$\text{key} = \text{raw}[11] \oplus \text{0xAA}$$
4. 使用推导出的 `key` 解码 `raw[8..<16]` 得到 8 字节 `info`：
   - 校验 `info[3] == 0xAA`。
   - **固件版本号公式**：`"\(info[2]).\(info[1]).\(info[0]).\(Int(info[4]) | (Int(info[5]) << 8))"`
     - 示例：`[16, 0, 1, 0xAA, 6, 0, 0, 0]` ➔ `"1.0.16.6"`
     - 示例：`[23, 0, 1, 0xAA, 6, 0, 0, 0]` ➔ `"1.0.23.6"`
   - `info[6..7]` 为保留/会话数据，判断固件是否跨版本变更时仅比较前缀 `info[0..<6]`。

### 3.2 `0xA0` 物理档位与几何特征校验
1. Host 发送 `0xA0` 请求（`length = 8, address = 0, handle = 0, key = key`）。
2. 返回 8 字节 `geometry` 必须满足：
   - `geometry[0] <= 1`：`0` 表示物理开关处于 **Mac 档位**，`1` 表示处于 **Win 档位**。该值即为当前激活的 `lightingProfile`，后续所有 `0xD5`、`0xD6`、`0xD8` 必须将 `handle` 设为 `lightingProfile`。
   - `geometry[1...4] == [8, 4, 6, 16]`（Air75 V3 ANSI 标准矩阵特征）。
   - `(geometry[5] & 0x80) == 0 || (geometry[5] & 0x7f) == 2`。

### 3.3 `0xD1` 灯珠数量校验
- **单字节规则**：Air75 V3 的 `0xD1` 仅加密返回 **1 个字节**（请求 `length = 1`），解码 `payload[0]` 必须等于 **`104`**（`84` 颗主键灯 + `20` 颗侧灯）。
- *历史缺陷警示*：若请求 `length = 2`，固件对第 2 字节不加密直接填 `0x00`；当 `key = 0x80` 时，误将第 2 字节异或解码会把 `104 (0x68)` 算成 `32872 (0x8068)`。

---

## 4. 灯效状态寄存器 (`0xD5` / `0xD6`) 与双固件兼容

### 4.1 17 字节与 22 字节状态 Schema
在 S4 协议族（`info[2] == 1 && info[3] == 0xAA && info[4] == 6 && info[5] == 0`）中，当 `info[1] > 0 || info[0] >= 16` 时支持逐键 RGB（Effect 21）：
- **17 字节 Schema**（`info[1] == 0 && info[0] == 16`，即 `1.0.16.6`）
- **22 字节 Schema**（`info[1] > 0 || info[0] >= 17`，即 `1.0.17.6+` / `1.0.23.6`）

| 偏移 | 字段含义 | 合法取值范围 (`validState`) | 备注 |
| :--- | :--- | :--- | :--- |
| `0` | 主灯效模式 (`mainMode`) | `0..21` (17B) / `0..22` (22B) | `21` 为自定义逐键模式 (Custom Per-Key)，`2` 为静态常亮，`0` 为硬件主控关闭态 |
| `1` | 主灯亮度 (`mainBrightness`) | `0..100` | 逐键模式下固定设为 `100`，通过软件缩放 RGB 控制视觉亮度 |
| `2` | 主灯速度 (`mainSpeed`) | `0..4` | 动效速度档位 |
| `3` | 主灯方向 (`mainDirection`) | `0..3` | 动效方向 |
| `4` | 主灯色彩模式 (`mainRgbMode`) | `0..1` | 逐键模式下固定设为 `1` |
| `5` | 主调色板槽位 / 镜像形状 | 任意 `UInt8` | `1.0.16.6` 未实现（比较时跳过）；`1.0.23.6` 镜像 offset `17`（严格比较） |
| `6..8` | 主灯颜色 `[R, G, B]` | `0..255` × 3 | 22B 固件在逐键模式下需设为 `[255, 255, 255]` |
| `9` | 侧灯模式 (`sideMode`) | `0..4` | `2` 为静态单色模式（拒接超出 `0..4` 的私有模式 `5`） |
| `10` | 侧灯亮度 (`sideBrightness`) | `0..100` | 侧灯整体亮度 |
| `11` | 侧灯速度 (`sideSpeed`) | `0..4` | 侧灯速度 |
| `12` | 侧灯色彩模式 (`sideRgbMode`) | `0..1` | 静态自定义颜色时设为 `0` |
| `13` | 侧灯调色板槽位 | 任意 `UInt8` | `1.0.16.6` 与 `1.0.23.6` 的 `D6` 分发表均跳过此字节（比较时豁免） |
| `14..16` | 侧灯颜色 `[R, G, B]` | `0..255` × 3 | 左右侧灯带整区静态 RGB |
| `17` | 预设形状 (`presetShape`, 仅 22B) | `0..7` | `1.0.17.6+` 扩展字段 |
| `18..20` | 预设 RGB (`presetRgb`, 仅 22B) | `0..255` × 3 | `1.0.17.6+` 扩展字段 |
| `21` | 预设速度 (`presetSpeed`, 仅 22B) | 写 `0..4` / 读 `0..255` | 部分 `1.0.23.6` 键盘会读出 `94`，备份原样保留；若 `17..21` 未变，`D6` 仅写前 `17` 字节前缀 |

### 4.2 `1.0.23.6` 主色 HSV 量化与精确逆映射
在固件 `1.0.23.6` (`[23, 0, 1, 0xAA, 6, 0]`) 中，`0xD6` 将主色 `state[6..8]` 转换为字节型 HSV 存储（V 缩放至 200），而 `0xD5` 读取时再转换回 RGB（导致直接将读出的 `[64, 0, 14]` 写回会变成 `[64, 0, 17]`）。
- **正向仿真函数 `mainColorReadback([r, g, b])`**：
  1. $hi = \max(r, g, b),\ lo = \min(r, g, b),\ \Delta = hi - lo$
  2. $\text{value} = \lfloor (\lfloor hi \times 200 / 255 \rfloor \times 255 + 100) / 200 \rfloor$；若 $\Delta == 0$ 则返回 `[value, value, value]`。
  3. $\text{saturation} = \lfloor \frac{\Delta}{hi} \times 255 + 0.5 \rfloor$
  4. 计算色相 $h \in [0, 255]$（步长因子 `43`），$\text{region} = \lfloor h / 43 \rfloor,\ \text{remainder} = (h - \text{region} \times 43) \times 6$。
  5. 由 $p, q, t$ 还原出 3 字节 RGB。
- **逆向搜索 `exactMainColorInput(target)`**：
  若 `mainColorReadback(target) == target` 直接返回 `target`；否则在半径 `radius = 4, 8, 16` 的邻域内搜索满足 `mainColorReadback(input) == target` 的精确输入 `[r, g, b]`。

---

## 5. 84 键逐键 RGB 流式控制 (`0xD8`) 与渲染回读 (`0xD2`)

### 5.1 激活逐键控制 (`Arm`)
1. 确保当前 Profile 的原始状态与 312 字节 RGB 已落盘备份。
2. 读取当前状态 `next = readState()`，修改：
   - `next[0] = 21` (Custom Per-Key Mode)
   - `next[1] = 100` (Brightness 100%)
   - `next[4] = 1` (RGB Mode)
   - 若 `next.count == 22`，设置 `next[6..8] = [255, 255, 255]`。
3. 发送 `0xD6` 并验证回显等于发送载荷；等待 `120ms` 后最多轮询 5 次 `0xD5`（间隔 `120ms`）确认状态匹配。
   - 若期望开灯但读回 `observed[0] == 0 && observed[1] == 0 && observed[10] == 0`，判定为键盘物理总开关关闭（错误码 `LIGHTING_DISABLED`，需提示用户按 `Fn + ↑`）。
4. 在 22 字节固件上，由于固件会在空闲约 1 秒后将 `0xD8` 调色板持久化到 Flash，在首次发送 `0xD8` 之前必须先读取一次 Custom Mode 下的 `0xD2` 前 252 字节，通过 `paletteFromRendered` 反解出原始 `customColors` 并追加持久化至备份文件。

### 5.2 流式增量刷写 (`0xD8`)
- 输入为 84 颗主键的 RGB 数组（共 `252` 字节，索引 `0..83`；**严禁向侧灯索引 `84..103` 发送 `0xD8`**）。
- **增量 Diff 计算**：
  - 首帧（`!firstPaintVerified`）、显式校验（`verify == true`）或恢复调色板时，发送全部 84 个键（`changed = 0..83`）。
  - 常规动画帧仅筛选出与上一帧 `lastPaint` 颜色不同的键位索引 `changed`。
- **分包规则**：
  - 按每包最多 **13 个键位**（即 `13 × 4 = 52` 字节 Payload）切分 `changed` 列表。
  - 每个键位编码为 4 字节：`[UInt8(ledIndex), R, G, B]`。
  - 发送 `0xD8`（`handle = lightingProfile, address = 0`），并严格校验设备返回的回显与发送的 `records` 完全一致。
  - 记录最后一次 `0xD8` 完成时间戳 `lastRGBWriteAt`。

### 5.3 渲染输出回读与缩放校准 (`0xD2`)
- **45ms 渲染边界等待**：距离 `lastRGBWriteAt` 不足 `45ms` 时，必须等待补齐 `45ms` 后再发起 `0xD2` 读取（防止固件在 `1.0.16.6` 上前 18 颗灯珠仍返回上一帧数据）。
- **分片读取**：总长 `312` 字节（104 颗 LED × 3），每次请求 `count = min(54, 312 - offset)`，`address = offset, handle = 0`，包间间隔 `8ms`。
- **22 字节固件缩放公式 (`renderedCustomByte`)**：
  - 17 字节固件：`D2` 读回值等于 `D8` 写入值。
  - 22 字节固件（如 `1.0.23.6`）：固件渲染器按上限 200 的 HSV Value 缩放通道，且第 84 颗灯位（字节偏移 `250, 251` 的 G/B 通道）额外乘以 `150/255`：
    $$\text{scaled} = \lfloor \text{value} \times 200 / 255 \rfloor$$
    $$\text{rendered}(i) = \begin{cases} \lfloor \text{scaled} \times 150 / 255 \rfloor & \text{if } i \ge 250 \\ \text{scaled} & \text{otherwise} \end{cases}$$

---

## 6. 物理按键坐标表与 Codex Micro 视觉规范

### 6.1 Air75 V3 ANSI 84 键 LED 索引映射表
来自 `shared/air75-v3-ansi.json`，`0xD8` 的 `ledIndex` (`0..83`) 与物理按键一一对应（注：索引 `83` 为无对应实体键的保留槽位，始终保持 `[0, 0, 0]`）：

| 行号 | 按键与对应 `ledIndex` |
| :--- | :--- |
| **Row 0 (功能键行)** | `Esc (0)`, **`F1 (1)`**, **`F2 (2)`**, **`F3 (3)`**, **`F4 (4)`**, **`F5 (5)`**, **`F6 (6)`**, **`F7 (7)`**, **`F8 (8)`**, **`F9 (9)`**, **`F10 (10)`**, **`F11 (11)`**, **`F12 (12)`**, `Scr (13)`, `Ins (14)` |
| **Row 1 (数字键行)** | `` ` (15) ``, **`1 (16)`**, **`2 (17)`**, **`3 (18)`**, **`4 (19)`**, `5 (20)`, `6 (21)`, `7 (22)`, `8 (23)`, `9 (24)`, `0 (25)`, `- (26)`, `= (27)`, `Backspace (28)`, `PgUp (29)` |
| **Row 2 (QWERTY 行)** | `Tab (30)`, `Q (31)`, `W (32)`, `E (33)`, `R (34)`, `T (35)`, `Y (36)`, `U (37)`, `I (38)`, `O (39)`, `P (40)`, `[ (41)`, `] (42)`, `\ (43)`, `PgDn (44)` |
| **Row 3 (ASDF 行)** | `Caps (45)`, `A (46)`, `S (47)`, `D (48)`, `F (49)`, `G (50)`, `H (51)`, `J (52)`, `K (53)`, `L (54)`, `; (55)`, `' (56)`, **`Enter (57)`**, `Home (58)` |
| **Row 4 (ZXCV 行)** | `LShift (59)`, **`Z (60)`**, **`X (61)`**, **`C (62)`**, `V (63)`, `B (64)`, **`N (65)`**, `M (66)`, `, (67)`, `. (68)`, `/ (69)`, `RShift (70)`, `↑ (71)`, `End (72)` |
| **Row 5 (底行)** | `LCtrl (73)`, `LAlt (74)`, `LCmd (75)`, `Space (76)`, `RCmd (77)`, `Fn (78)`, `RCtrl (79)`, `← (80)`, `↓ (81)`, `→ (82)`, `Reserved (83)` |

### 6.2 官方状态色与呼吸动效数学规范
对齐 `shared/codex-lighting.mjs` 与 `shared/claude-lighting.mjs`：

| Agent 状态 (`AgentPeripheralStatus`) | 标准 Hex 颜色 | RGB 字节 `[R, G, B]` | 视觉语义与动效 |
| :--- | :--- | :--- | :--- |
| `INACTIVE` | `#000000` | `[0x00, 0x00, 0x00]` | 槽位未绑定会话（灭灯） |
| `IDLE` | `#FFFFFF` | `[0xFF, 0xFF, 0xFF]` | 空闲待命（白色常亮，非焦点可按比例调暗） |
| `RUNNING` | `#304FFE` | `[0x30, 0x4F, 0xFE]` | 思考/工具执行中（电光蓝） |
| `NEEDS_INPUT` | `#FF6D00` | `[0xFF, 0x6D, 0x00]` | 等待用户审批/提问回答（琥珀橙脉冲 + 交互键高亮） |
| `COMPLETED` | `#00FF4C` | `[0x00, 0xFF, 0x4C]` | 本轮完成/待审阅结果（荧光翠绿） |
| `ERROR` | `#FF0033` | `[0xFF, 0x00, 0x33]` | 执行异常/中断（警示绯红） |

- **聚焦槽位呼吸脉冲公式（Period = `1800ms`）**：
  $$\text{pulse}(t) = 0.28 + 0.72 \times \left(0.5 + 0.5 \times \cos\left(\frac{2\pi (t - t_0)}{1800}\right)\right)$$
- **交互审批键辅助高亮（当聚焦槽位处于 `NEEDS_INPUT` 时）**：
  - 数字键 `1 (16)`, `2 (17)`, `3 (18)`：显示琥珀色 `#FF6D00`（指示多选项 `1/2/3`）。
  - `Enter (57)` / `Y (36)`：显示翠绿色 `#00FF4C`（指示一键同意 `ACCEPT`）。
  - `Esc (0)` / `N (65)`：显示绯红色 `#FF0033`（指示一键拒绝 `REJECT`）。

---

## 7. 键位读取 (`0xB1` / `0xB2`)、F4 窄租约 (`0xB3`) 与 macOS 键位适配

1. **键位层读取**：
   - 每个键位层共 `98` 个键位（`196` 字节，每个键位为 2 字节大端序 `UInt16`），通过 `length = min(56, 196 - offset)` 分 4 包读取，`address = layer * 196 + offset`。
   - `0xB1` 读取出厂默认层：Layer `0` 为 Mac 出厂层，Layer `4` 为 Win 出厂层（其中 Win 出厂层的 F1..F12 恒为标准 HID 键码 `58..69`，用于定位 F1..F12 在 98 键矩阵中的物理槽位索引 `1..12`）。
   - `0xB2` 读取当前生效层：Layer `lightingProfile * 4`。
2. **Mac 出厂 F4 窄租约 (`0xB3`)**：
   - Mac 出厂层 F4 的键值为 `0x7e07`（`32263`，固件内部直接合成 `Command+Space`，无法通过 macOS `IOHIDServiceClient` 单独重映射）。
   - 当確認键盘处于 Mac 模式且 F4 为原厂 `0x7e07` 时，先将完整 98 键原数组落盘至 `function-key-backup.json`，然后发送 `0xB3`（`address = position * 2, length = 2, payload = [0x00, 0x3d]`）将其临时改为标准 F4（`61`），并通过 `0xB2` 回读确认；退出或重连时恢复为 `[0x7e, 0x07]`。
3. **macOS `IOHIDServiceClient` 临时键位映射 (`UserKeyMapping`)**：
   - 针对其余 Mac 出厂媒体键（`F1=105/F14`, `F2=106/F15`, `F3=32262/0xc0000029f`, `F5=32264/0xc000000cf`, `F6=32278/0x10000009b`, `F7..F12 = 172,174,171,168,170,169`）或扩展层 `F13..F24 (104..115)`，在对应 USB / 蓝牙 `IOHIDServiceClient` 上设置 `UserKeyMapping` 映射为标准 `F1..F12 (0x70000003a..0x700000045)`，备份至 `key-mapping-backup.json` 并在退出时无损还原。
