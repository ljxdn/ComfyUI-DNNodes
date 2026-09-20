# ComfyUI-DNNodes

给 **MiniMax H3** 视频工作流用的两个 ComfyUI 自定义节点：把「一张资产卡（图 / 音 / 描述）」
直接喂给导演台的分段（r2v 分组），并附带一整套顺手的编辑体验
（单端口多连线、选中高亮上游、提示词富文本编辑器）。

![DN 节点效果展示](<assets/DNnodes效果展示.jpg>)


---

## 节点

| 节点 | 节点 id | 作用 |
|---|---|---|
| **资产卡** | `H3MediaLoader` | 一张资产：图像（可粘贴截图 / 拖放 / 输入目录下拉）+ 音频（波形、播放、裁剪、静音）+ 资产描述；另有「资产名」「最长边」。输出 `media / image / audio / prompt` |
| **资产卡 to Director Group** | `DNMediaToDirectorGroup` | 把若干张资产卡打包成 **MiniMax H3 Director** 的 Reference-to-Video 分组（`MMX_DIR_GROUP`），可直接接导演台或 `Groups Combine` |

`medias` 端口可**接多条连线**（最多 9 条），编号顺序 = 连线顺序 = 提示词里
`<Picture N>` / `<Audio J>` 的编号。

---

## 安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/ljxdn/ComfyUI-DNNodes.git
```

重启 ComfyUI。依赖：ComfyUI 本体自带的 `torch` / `numpy` / `Pillow`，**无需额外 pip 包**。

想用第二个节点的输出，需要另外安装
[ComfyUI_MiniMaxH3_Director](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director)（Apache-2.0）。

---

## 示例工作流

[`example_workflows/海螺H3_资产卡&导演台DN.json`](<example_workflows/海螺H3_资产卡&导演台DN.json>)
—— 「资产卡 → 导演台」的完整链路：**8 张资产卡**整理角色素材 → 两个
「资产卡 to Director Group」分组 → `Groups Combine` → 导演台出片。

![示例工作流](<example_workflows/海螺H3_资产卡&导演台DN.png>)

**除本包外还需要**（工作流里那个 `所需节点:` 便签也写了同样的清单）：

| 用途 | 仓库 |
|---|---|
| 导演台（必需） | [AIMixer/ComfyUI_MiniMaxH3_Director](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director) |
| 补帧 | [GACLove/ComfyUI-VFI](https://github.com/GACLove/ComfyUI-VFI) |
| 杂项 / 预览 | [kijai/ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) |

⚠️ **工作流里引用到的图片与音频不在本仓库**（那是示例作者的本地素材，打开时会提示缺失）。
把它们换成你自己的即可；两个 `Note` 便签里还留了二采降噪、采样步数的调参建议。

---

## 功能

### 资产卡

- **图像**：输入目录下拉 / 拖放 / 截屏后**一键粘贴**（图片区右上角剪贴板按钮，或鼠标停在图片区按 `Ctrl+V`）；
  同内容重复上传按 MD5 去重，不会堆文件。
- **音频**：波形上拖选区间 → `裁剪` 写回 `trim_start` / `trim_end` / `还原`；`静音` 时输出 `audio = None`。
- **最长边**：参考图最长边超过该值即等比缩小（只缩不放），默认 1440。
- **资产名**：参与「提示词里没提到的资产会被跳过」这一过滤规则。

### 资产卡 to Director Group

- **单端口多连线**：往 `medias` 拖第 2 条线时，自动把你原本那条也收编进来，一张都不丢；
  点一下线中点的圆点即可「序号提前 / 序号退后 / 删除这条连线 / **替换这张卡…**」，
  节点右键菜单可「清空全部连线 / 连线顺序反转」。
- **圆点数字 = 实际编号**：显示的是这张卡在后端真正占的 `<Picture N>` / `<Audio J>`；
  被跳过的卡（资产名没写进提示词）**不吃号、也不画数字** —— 圆点上的数字永远等于喂进模型的编号。
- **被跳过的卡会显形**：后端只收「资产名出现在提示词里」的卡（与上游同一规则）；
  这些卡在画布上画成**灰色虚线 + 灰点**，选中时它们的金圈也变灰圈，
  同时编辑框上方出现一条琥珀色提示条列出是哪几张 —— 不再有"连了却没生效"的黑盒。
- **选中即高亮上游**：选中该节点时，它这一段真正吃进去的卡与中间节点会亮起琥珀金，
  一眼看清「这条用了哪几张卡」。
- **提示词富文本编辑器**：`<Picture N>` 显示成带缩略图的芯片（鼠标悬停出大图）、
  `<d>[Chinese] …</d>` 显示成对话块（按说话人着色）、`[Shot N]` 显示成镜头徽章、
  六段式标题高亮；`@` 唤起上游素材菜单；「原文 ⇄ 美化」一键切回纯文本。
- **高亮画在节点之上**：ComfyUI 里节点自绘 UI 是真 DOM 元素，canvas 上画的线永远在它下面；
  本包额外挂了一层 DOM 覆盖层，所以高亮不会被资产卡挡住。

### 替换这张卡

连线圆点菜单 →「**替换这张卡…**」：搜索栏 + 卡列表（缩略图 / 资产名 / 图·音组成 / 文件名），
列出工作流里**除本组已连之外**的所有资产卡；鼠标悬停看大图，点一下就换。

![替换这张卡](<assets/替换这张卡.png>)

- **同名换源**（重截图、换更好的参考图）：只换连线，提示词一个字不动。
- **换角色**（资产名也变）：先弹确认框，逐条列出「提示词将替换 N 处『旧名 → 新名』」的上下文、
  编号变化（`<Audio 2>` → `<Audio 1>` 这类）、以及警告（如新卡没有音频、
  旧卡的 `<Audio 2>` 将失去对应物）。三个出口：**替换并改提示词** / **只换连线** / 取消。
- **多组联动**：同一张卡还连在别的组里时，确认框多一个复选框
  「同时替换其它组里的同一张卡（N 处，各自改提示词）」—— 每个组的提示词各自重写；
  已经连着新卡的组自动跳过（否则会被去重逻辑静默丢线）。
- **可撤销**：换完的提示条带「撤销」，连线与提示词作为**同一个快照**一起还原。
- 编号重映射按「引用还是那个角色的素材」算，并且是对着**改名后的最终状态**算 ——
  换了角色后新卡会被计入编号，不会把不该动的 token 也改掉。

### 顺手修的一个导演台问题

`dn_continuity_guard.js`：导演台在重建外接组片段时会丢掉每段的 `continuityFromPrev`
（导致「引用上段」被静默改回开启、并连带二采缓存失效）。本扩展只在前端补回该字段，
**不修改导演台源码**。相关分析见
[AIMixer/ComfyUI_MiniMaxH3_Director#198](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director/issues/198)。

---

## 目录结构

```
ComfyUI-DNNodes/
├── __init__.py                    节点注册 + WEB_DIRECTORY
├── nodes.py                       资产卡 to Director Group
├── media_group_core.py            分组打包 / 编号 / 最长边缩放
├── asset_card.py                  资产卡后端（含上传路由）
├── assets/
│   ├── DNnodes效果展示.jpg         效果展示图
│   └── 替换这张卡.png              「替换这张卡」截图
├── example_workflows/
│   ├── 海螺H3_资产卡&导演台DN.json   示例工作流（资产卡 × 导演台）
│   └── 海螺H3_资产卡&导演台DN.png    预览图
└── web/js/
    ├── asset_card.js              资产卡自绘 UI
    ├── dn_media_multilink.js      单端口多连线 + 连线右键菜单
    ├── dn_upstream_highlight.js   选中时高亮上游
    ├── dn_prompt_rich.js          提示词富文本编辑器
    ├── dn_overlay.js              画布之上的 DOM 覆盖层
    └── dn_continuity_guard.js     导演台「引用上段」守卫
```

---

## 兼容性

- 节点 id、控件 key、工作流保存格式**全部保持向后兼容**。
- 后端同时支持新式 `comfy_api.latest.io` 与旧式 `INPUT_TYPES`（缺 `comfy_api` 的宿主自动回退）。
- 前端扩展均为可插拔：删掉对应的 `web/js/*.js` 即可单独关闭某项功能。
- 新增/改动 `WEB_DIRECTORY` 需要重启一次 ComfyUI；之后只改 js 刷新页面即可。

---

## 致谢与许可

本包以 **MIT** 发布（见 `LICENSE`）。其中：

- **资产卡** 派生自 [ComfyUI-H3-OpenNodes](https://github.com/juntaosun/ComfyUI-H3-OpenNodes)
  （作者 **sunnyboxs**，MIT）—— 该仓库**已被作者删除**，本包包含其部分副本。
- `medias` 多连线机制、`<Picture N>` 编号规则与隐藏槽位设计，同样源自上述项目。
- 输出格式对接 [ComfyUI_MiniMaxH3_Director](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director)（Apache-2.0，未复制代码）。
- 富文本编辑器的整体思路参考 [ComfyUI-PainterNodes](https://github.com/princepainter/ComfyUI-PainterNodes)（MIT）
  与 [ComfyUI-MiniMaxH3-Easy](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy)（MIT，@nkxx188）。

完整的出处、授权与改动范围见 **[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)**。

---

## 更新日志

- **v1.3.0**（2026-09-20）
  - 富文本编辑器的编号**对齐后端过滤规则**：资产名没写进提示词的卡在编辑器里也不计入编号，
    编辑框上方新增提示条列出被跳过的卡（以前编辑器不过滤，显示的编号可能与实际喂进模型的错位）
  - 画布上被跳过的卡**显形**：连线变灰色虚线、圆点压灰且不画数字，选中时它们的金圈变灰圈
  - 圆点数字改用**后端实际编号**（不再是连线序号）
  - 新增「**替换这张卡**」：圆点菜单里搜索换卡，可选择只换连线、或同时重写提示词
    （资产名替换 + `<Picture N>` / `<Audio J>` 编号重映射），支持多组联动与一键撤销
- **v1.2.0**（2026-09-18）
  - 资产卡并入本包（原 `H3 Media Loader`），显示名改为「资产卡」，分类并入 `DN Nodes`
  - `DN H3 Media to Director Group (R2V)` → 「资产卡 to Director Group」
  - 新增 DOM 覆盖层：选中的高亮连线现在会画在资产卡这类自绘 UI 节点**之上**
  - 资产卡不再残留「控件转输入」的空槽位（原来都叠在节点左上角）
  - 新增 [`example_workflows/`](example_workflows)：资产卡 × 导演台的整合示例工作流
- **v1.1.0**（2026-09-16）
  - `medias` 单端口多连线、选中高亮上游、提示词富文本编辑器（芯片 / 缩略图 / `@` 菜单）
  - 导演台「引用上段」守卫
- **v1.0.0**（2026-09-15）
  - 首个节点：DN H3 Media to Director Group (R2V)
