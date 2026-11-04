# NuPhy Air75 V3 键盘图纸与可视化资源库

本目录存放从 NuPhy Web 驱动应用（[drive.nuphyio.com](https://drive.nuphyio.com/#/pressKey)）的 `airV3Series.ts` 模块中逆向提取的 **NuPhy Air75 V3（矮轴超薄 75% 机械键盘）** 完整图纸与矢量组件资产。

---

## 1. 核心导出成果

| 文件名 | 格式 | 说明 |
| :--- | :--- | :--- |
| **`nuphy-air75-v3-drawing.svg`** | SVG | **完整独立矢量图纸**，包含 Air75 V3 超薄外壳、84 颗矮轴按键倒角线框、Mac 字符与多媒体图标、右上角金属滚轮（Roller Lever）。 |
| **`air75-v3-layout.json`** | JSON | **全按键精确几何坐标表**。包含按键键码（`keyCode`）、原始网格坐标、物理像素坐标（`left_px`, `top_px`, `width_px`, `height_px`）、符号标识与滚轮参数。 |
| **`viewer.html`** | HTML5 | **DSH HID 智能体状态可视化交互画板**。已预置 Codex Micro 的 5 种 Agent 状态（`Idle`, `Thinking`, `Input Needed`, `Success`, `Error`）物理灯效与交互模拟。 |
| **`nuphy-air75-v3-drawing.png`** | PNG | 高清渲染预览图（1200px 宽）。 |
| **`Air75_V3_frame_light.png`** | PNG | 浅色超薄键盘外壳高精度母版（3465 × 1389 px，300 DPI 无损转码）。 |
| **`Air75_V3_frame_dark.png`** | PNG | 深色键盘外壳高精度母版（3465 × 1389 px，300 DPI 无损转码）。 |
| **`Air75_V3_lever_light.png`** | PNG | 右上角金属音量滚轮切片（浅色）。 |
| **`Air75_V3_lever_dark.png`** | PNG | 右上角金属音量滚轮切片（深色）。 |

---

## 2. 原始矢量线框切片 (DwarfAxis Slices)

Air75 V3 采用 `DwarfAxis` 矢量切片：

- `Vector_dwarf_left.288f17f5e948b6215b8e.svg`：按键左侧切片
- `Vector_dwarf_middle.44b7cc1f6b6a04cdf373.svg`：按键中部横向拉伸切片
- `Vector_dwarf_right.1ba25231110122664132.svg`：按键右侧切片
- `Vector_dwarf_top.560d91c5190893c59a04.svg` / `Vector_dwarf_bottom.322829fc9aaa87d5f13b.svg`：纵向按键切片
