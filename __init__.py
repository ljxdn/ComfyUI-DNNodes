"""ComfyUI-DNNodes — DN 自建节点包。

两个节点，都挂在「DN Nodes」分类下：

- 资产卡（节点 id 仍为 H3MediaLoader）
  后端 asset_card.py + 前端 web/js/asset_card.js。
  可选的图像 / 音频（波形预览与裁剪）/ 资产描述，另有「资产名」「最长边」。
  派生自 ComfyUI-H3-OpenNodes 的 H3 Media Loader（MIT，作者 sunnyboxs / juntaosun），
  上游仓库已删除；出处与授权见 LICENSE 与 THIRD_PARTY_NOTICES.md。

- 资产卡 to Director Group（节点 id 仍为 DNMediaToDirectorGroup）
  把资产卡的 medias 适配成 ComfyUI_MiniMaxH3_Director 的 r2v 分组。
"""

from .asset_card import NODE_CLASS_MAPPINGS as _CARD_NODES
from .asset_card import NODE_DISPLAY_NAME_MAPPINGS as _CARD_NAMES
from .nodes import NODE_CLASS_MAPPINGS as _GROUP_NODES
from .nodes import NODE_DISPLAY_NAME_MAPPINGS as _GROUP_NAMES

NODE_CLASS_MAPPINGS = {**_CARD_NODES, **_GROUP_NODES}
NODE_DISPLAY_NAME_MAPPINGS = {**_CARD_NAMES, **_GROUP_NAMES}

__version__ = "1.2.0"

# 前端扩展目录（ComfyUI 会把这里的每个 js 都加载一遍）：
#   asset_card.js           资产卡节点的自绘 UI
#   dn_media_multilink.js   「资产卡 to Director Group」的 medias 单端口多连线
#   dn_upstream_highlight.js 选中该节点时高亮上游连线/节点
#   dn_prompt_rich.js       该节点提示词的富文本编辑（chip / 缩略图 / @ 菜单）
#   dn_overlay.js           画布之上的 DOM 覆盖层（供上面几个把高亮画到节点之上）
#   dn_continuity_guard.js  修复导演台「引用上段」被静默重置
# 注意：新增/改动 WEB_DIRECTORY 需要重启一次 ComfyUI 才会被注册；之后改 js 只需刷新页面。
WEB_DIRECTORY = "./web/js"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "__version__",
]
