# ComfyUI-DNNodes

给 **MiniMax H3** 视频工作流用的两个 ComfyUI 自定义节点：把「一张资产卡（图 / 音 / 描述）」
直接喂给导演台的分段（r2v 分组），并附带一整套顺手的编辑体验
（单端口多连线、选中高亮上游、提示词富文本编辑器）。

> 节点 id 全部保持原样（`H3MediaLoader` / `DNMediaToDirectorGroup`），
> **已保存的工作流升级后无需任何改动**。

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

## 功能

### 资产卡

- **图像**：输入目录下拉 / 拖放 / 截屏后**一键粘贴**（图片区右上角剪贴板按钮，或鼠标停在图片区按 `Ctrl+V`）；
  同内容重复上传按 MD5 去重，不会堆文件。
- **音频**：波形上拖选区间 → `裁剪` 写回 `trim_start` / `trim_end` / `还原`；`静音` 时输出 `audio = None`。
- **最长边**：参考图最长边超过该值即等比缩小（只缩不放），默认 1440。
- **资产名**：参与「提示词里没提到的资产会被跳过」这一过滤规则。

### 资产卡 to Director Group

- **单端口多连线**：往 `medias` 拖第 2 条线时，自动把你原本那条也收编进来，一张都不丢；
  线中点的绿色数字就是编号，**右键** 可「序号提前 / 序号退后 / 删除这条连线」，节点右键菜单可「清空全部连线 / 连线顺序反转」。
- **选中即高亮上游**：选中该节点时，它这一段真正吃进去的卡与中间节点会亮起琥珀金，
  一眼看清「这条用了哪几张卡」。
- **提示词富文本编辑器**：`<Picture N>` 显示成带缩略图的芯片（鼠标悬停出大图）、
  `<d>[Chinese] …</d>` 显示成对话块（按说话人着色）、`[Shot N]` 显示成镜头徽章、
  六段式标题高亮；`@` 唤起上游素材菜单；「原文 ⇄ 美化」一键切回纯文本。
- **高亮画在节点之上**：ComfyUI 里节点自绘 UI 是真 DOM 元素，canvas 上画的线永远在它下面；
  本包额外挂了一层 DOM 覆盖层，所以高亮不会被资产卡挡住。

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
  （作者 **sunnyboxs**，MIT）—— 该仓库**已被作者删除**，本包是其唯一维护副本。
- `medias` 多连线机制、`<Picture N>` 编号规则与隐藏槽位设计，同样源自上述项目。
- 输出格式对接 [ComfyUI_MiniMaxH3_Director](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director)（Apache-2.0，未复制代码）。
- 富文本编辑器的整体思路参考 [ComfyUI-PainterNodes](https://github.com/princepainter/ComfyUI-PainterNodes)（MIT）
  与 ComfyUI-MiniMaxH3-Easy（MIT，@nkxx188）。

完整的出处、授权与改动范围见 **[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)**。

---

## 更新日志

- **v1.2.0**（2026-09-18）
  - 资产卡并入本包（原 `H3 Media Loader`），显示名改为「资产卡」，分类并入 `DN Nodes`
  - `DN H3 Media to Director Group (R2V)` → 「资产卡 to Director Group」
  - 新增 DOM 覆盖层：选中的高亮连线现在会画在资产卡这类自绘 UI 节点**之上**
  - 资产卡不再残留「控件转输入」的空槽位（原来都叠在节点左上角）
- **v1.1.0**（2026-09-16）
  - `medias` 单端口多连线、选中高亮上游、提示词富文本编辑器（芯片 / 缩略图 / `@` 菜单）
  - 导演台「引用上段」守卫
- **v1.0.0**（2026-09-15）
  - 首个节点：DN H3 Media to Director Group (R2V)
