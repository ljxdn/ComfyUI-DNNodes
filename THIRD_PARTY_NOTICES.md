# 第三方组件与出处（THIRD PARTY NOTICES）

本包（**ComfyUI-DNNodes**）自身以 **MIT** 发布（见 `LICENSE`）。其中一部分文件派生自、
或明显参考了下列项目。按各自许可证的要求，在此逐项写明出处、授权与改动范围。

> 说明：本文件只声明事实与授权，不代表任何上游作者对本包的认可或背书。

---

## 1. ComfyUI-H3-OpenNodes —— 派生（MIT，含完整代码）

| 项 | 内容 |
|---|---|
| 仓库 | `https://github.com/juntaosun/ComfyUI-H3-OpenNodes` |
| 作者 | sunnyboxs（GitHub: [@juntaosun](https://github.com/juntaosun)） |
| 许可 | MIT License，`Copyright (c) 2026 sunnyboxs` |
| 状态 | **上游仓库已删除**（GitHub 返回 404，账号仍在）；本包因此成为该部分代码的唯一维护副本 |
| 本包派生文件 | `asset_card.py`（原 `H3MediaLoader.py`）<br>`web/js/asset_card.js`（原 `web/js/MediaLoader.js`） |
| 参考其设计的文件 | `web/js/dn_media_multilink.js` —— 「单个输入端口接多条连线」的机制与其 `web/js/MediaPrompt.js` 同源（虚拟连线存节点属性、执行前注入隐藏槽位）<br>`media_group_core.py` / `nodes.py` —— `<Picture N>` / `<Audio J>` 的编号规则、`media_1…9` 隐藏槽位命名、资产名过滤规则，均对齐其 `H3MediaPrompt.py` |

### 本包对其做过的改动（派生部分）

- 显示名与标签：`H3 Media Loader` / 「角色名」→ **资产卡** / 「资产名」
- 分类：`H3Nodes` → `DN Nodes`
- 新增「最长边」（只按比例缩小、绝不放大）参数；波形区高度减半
- 修复前端控件顺序导致的旧工作流取值错位；隐藏「控件转输入」残留槽位
- 上传接口新增本包路由 `/dn/asset_card/upload_image`（旧路径 `/h3/media_loader/upload_image` 保留兼容）
- **节点类名与节点 id 仍为 `H3MediaLoader`** —— 所有已保存的工作流无需改动

### MIT 许可原文（该部分适用）

```
MIT License

Copyright (c) 2026 sunnyboxs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. ComfyUI_MiniMaxH3_Director —— 数据契约对接（Apache-2.0，未复制代码）

| 项 | 内容 |
|---|---|
| 仓库 | `https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director` |
| 许可 | Apache License 2.0（`Copyright 2026 ComfyUI-Bernini Contributors`） |
| 关系 | 本包的 `资产卡 to Director Group` 节点**输出**导演台所需的分组字典（类型 `MMX_DIR_GROUP`），其字段结构对齐该项目的 `pack_r2v_group`；`web/js/dn_continuity_guard.js` 针对该项目 `web/js/minimax_timeline.js` 的重建逻辑做了前端补丁（不修改其源码） |
| 是否复制代码 | **未复制**。仅为数据格式兼容与互操作，属于接口对接。 |

该项目的完整许可证见其仓库根目录 `LICENSE`。

---

## 3. ComfyUI-PainterNodes —— 参考其前端实现（MIT，未复制代码）

| 项 | 内容 |
|---|---|
| 仓库 | `https://github.com/princepainter/ComfyUI-PainterNodes` |
| 作者 | [@princepainter](https://github.com/princepainter) |
| 许可 | MIT License |
| 关系 | 本包 `web/js/dn_prompt_rich.js`（提示词富文本编辑器）在**架构层面参考**了该项目的 `web/js/PainterMiniMaxRefToVideo2.js`：contenteditable 芯片化渲染、自建撤销栈、`@` 提及菜单、原文 ⇄ 美化切换的整体思路 |
| 是否复制代码 | **未复制**。本包为独立实现（自写的词法切分、光标换算、缩略图解析与样式），仅在思路上参考。 |

---

## 4. ComfyUI-MiniMaxH3-Easy —— 参考其编辑器做法（MIT，未复制代码）

| 项 | 内容 |
|---|---|
| 作者 | [@nkxx188](https://github.com/nkxx188) |
| 许可 | MIT License，`Copyright (c) 2026 nkxx188` |
| 关系 | 本包 `web/js/dn_prompt_rich.js` 参考了其 `web/minimax_h3_easy_ui.js` 里「原生控件隐藏但仍参与序列化 + contenteditable 芯片编辑器」的做法 |
| 是否复制代码 | **未复制**。 |

---

## 5. ComfyUI 本体

本包是 ComfyUI 的自定义节点扩展，运行依赖 ComfyUI 本体（`folder_paths`、`PromptServer`、
前端 `app` / `LiteGraph` API 等），但**不包含**任何 ComfyUI 源码。ComfyUI 采用 GPL-3.0，
其许可与本包无关；本包通过其公开扩展接口工作。
