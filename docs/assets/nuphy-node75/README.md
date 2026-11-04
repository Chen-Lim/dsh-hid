# NuPhy Node75 键盘图纸与可视化资源库

本目录存放从 NuPhy Web 驱动应用（[drive.nuphyio.com](https://drive.nuphyio.com/#/pressKey)）中逆向分析并提取的 **NuPhy Node75（矮轴 75% 机械键盘）** 完整图纸与矢量组件资产，可直接用于 `dsh-hid` 插件的智能体硬件状态可视化开发。

---

## 1. 核心导出成果

| 文件名 | 格式 | 说明 |
| :--- | :--- | :--- |
| **`nuphy-node75-drawing.svg`** | SVG | **完整独立矢量图纸**，包含高精度键盘外壳底图、84 个矮轴按键双线倒角线框、Mac 字符与多媒体图标、右上角金属旋钮。开箱即用，支持自由缩放与 CSS 样式注入。 |
| **`node75-layout.json`** | JSON | **全按键精确几何坐标表**。包含按键键码（`keyCode`）、原始网格坐标、物理像素坐标（`left_px`, `top_px`, `width_px`, `height_px`）、符号标识与旋钮参数。 |
| **`viewer.html`** | HTML5 | **DSH HID 智能体状态可视化交互画板**。已预置 Codex Micro 的 5 种 Agent 状态（`Idle`, `Thinking`, `Input Needed`, `Success`, `Error`）物理灯效与交互模拟。 |
| **`nuphy-node75-drawing.png`** | PNG | 高清渲染预览图（1200px 宽）。 |
| **`Node75_frame_light.png`** | PNG | 浅色键盘外壳高精度母版（2300 × 990 px，300 DPI 无损转码）。 |
| **`Node75_frame_dark.png`** | PNG | 深色键盘外壳高精度母版（2300 × 990 px，300 DPI 无损转码）。 |

---

## 2. 原始矢量线框切片 (Vector Slices)

NuPhyIO 采用三段式矢量切片（9-Slice / 3-Slice）对按键进行动态尺寸拼接：

- `Vector_dwarfAxisNode_left.15c524c7d263aa038988.svg`：按键左侧切片（含双线倒角曲线）
- `Vector_dwarfAxisNode_middle.a37170be0f7106fd082b.svg`：按键中部横向拉伸切片（`preserveAspectRatio="none"`）
- `Vector_dwarfAxisNode_right.ee071f91fbaa96e72de4.svg`：按键右侧切片
- `Vector_dwarfAxisNode_top.dc9aa77a0dbd7c47e1a7.svg` / `Vector_dwarfAxisNode_bottom.4078780f9ca7a57e2e11.svg`：纵向按键切片
- `dwarfAxisNode_enter.d83d7b39742d7deae934.svg`：特异形 Enter 键切片

---

## 3. 在 DSH HID 插件中的使用方式

### 3.1 引入按键坐标进行状态映射
在 `packages/core` 或 `packages/visualizer` 中：
```typescript
import node75Layout from './docs/assets/nuphy-node75/node75-layout.json';

// 获取对应键位的物理屏幕坐标并绑定 RGB 动画
const spaceKey = node75Layout.keys.find(k => k.name === 'SPACE');
console.log(spaceKey.calc);
// { left_px: 247.74, top_px: 336.17, width_px: 315.19, height_px: 55.2 }
```

### 3.2 动态着色与状态反馈
在 Web / Electron / Canvas 界面中直接操作 `nuphy-node75-drawing.svg` 的 DOM：
```javascript
// 当 DSH 触发 'Thinking' 状态时高亮呼吸灯
const keyCap = svgDoc.getElementById('key-SPACE');
keyCap.querySelector('rect').setAttribute('fill', '#38bdf8');
```
