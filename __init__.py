"""ComfyUI-DNNodes — DN 自建节点包。

四个节点，都挂在「DN Nodes」分类下：

- 资产卡（节点 id 仍为 H3MediaLoader）
  后端 asset_card.py + 前端 web/js/asset_card.js。
  可选的图像 / 音频（波形预览与裁剪）/ 资产描述，另有「资产名」「最长边」。
  派生自 ComfyUI-H3-OpenNodes 的 H3 Media Loader（MIT，作者 sunnyboxs / juntaosun），
  上游仓库已删除；出处与授权见 LICENSE 与 THIRD_PARTY_NOTICES.md。

- 资产卡镜头打包（节点 id 仍为 DNMediaToDirectorGroup）
  把资产卡的 medias 适配成 ComfyUI_MiniMaxH3_Director 的 r2v 分组。

- 资产卡Group拆分（节点 id 为 DNGroupSplit）
  后端 group_split_core.py + nodes.py + 前端 web/js/dn_group_split.js。
  把「资产卡镜头打包」吐出的 MMX_DIR_GROUP 再拆回逐个素材口
  （image_1..9 / video_1..3 / audio_1..3），最下方一个 prompt 文本口，
  用于兼容 MiniMax H3 官方工作流的逐口接线方式。输出口数量随上游实际素材数
  动态增减（由前端重建），另有「固定 9+3+3 输出口」开关可一次接满不再改线。
  动态输出口的做法参考 ComfyUI-MiniMaxH3-Easy 的「媒体拆分」节点（MIT，作者 nkxx188），
  本包为独立实现，未复制其代码；出处与授权见 THIRD_PARTY_NOTICES.md。

- 资产卡任务台（节点 id 为 DNGroupDirector；2026-10-15 由「资产卡导演台」改名，id 不变）
  后端 director_core.py + nodes.py + 前端 web/js/dn_director.js。
  把 N 段「资产卡镜头打包」接到本节点，按「运行段」只把第 k 段的分组吐给下游，
  于是「拆分 → 参考生成 → 采样」只需要接一次线。顺序循环跑由节点的面板调度器
  按段构造 N 份任务依次提交（每份只换运行段），拖动排序不动任何连线；
  面板上逐段显示时长 / 参考图缩略图 / 一采缓存状态，可逐段勾「运行」、逐段开关二采。
  分段输入口的「不限段数」用 ComfyUI 官方 v3 的 accept_all_inputs + 前端动态加口
  （KJNodes 的 *Multi 系列同一套机制，未复制其代码）。
"""

from .asset_card import NODE_CLASS_MAPPINGS as _CARD_NODES
from .asset_card import NODE_DISPLAY_NAME_MAPPINGS as _CARD_NAMES
from .director_core import SLOT_PREFIX as _DIRECTOR_SLOT_PREFIX
from .nodes import NODE_CLASS_MAPPINGS as _GROUP_NODES
from .nodes import NODE_DISPLAY_NAME_MAPPINGS as _GROUP_NAMES

# SelfLift H3 缓存版（一采 / 二采分开跑，中间用缓存文件接上）。依赖同目录的
# comfyui-SelfLift 包（引擎）与可选的 H3 latent upscaler 权重。
try:
    from .selflift_cache import NODE_CLASS_MAPPINGS as _SELFLIFT_NODES
    from .selflift_cache import NODE_DISPLAY_NAME_MAPPINGS as _SELFLIFT_NAMES
except Exception as _sl_err:  # 缺依赖时静默降级，不影响其它 DN 节点
    import logging as _sl_log
    _sl_log.warning("DN Nodes: SelfLift 缓存节点加载失败（需 comfyui-SelfLift 包）：%s", _sl_err)
    _SELFLIFT_NODES = {}
    _SELFLIFT_NAMES = {}
    # 让降级原因在 ComfyUI 启动日志里一眼能看到（搜节点搜不到多半是这里失败）
    print("[DN Nodes] SelfLift 缓存节点未注册。原因：comfyui-SelfLift 引擎 import 失败。",
          "请到 ComfyUI 启动日志搜 'SelfLift' 看具体报错；确认 custom_nodes/comfyui-SelfLift "
          "目录存在且其 nodes.py / selflift.py / h3_upscaler.py 可正常 import。",
          f"详细异常：{_sl_err!r}")

NODE_CLASS_MAPPINGS = {**_CARD_NODES, **_GROUP_NODES, **_SELFLIFT_NODES}
NODE_DISPLAY_NAME_MAPPINGS = {**_CARD_NAMES, **_GROUP_NAMES, **_SELFLIFT_NAMES}

__version__ = "1.7.8"

# 前端扩展目录（ComfyUI 会把这里的每个 js 都加载一遍）：
#   asset_card.js           资产卡节点的自绘 UI
#   dn_media_multilink.js   「资产卡镜头打包」的 medias 单端口多连线
#   dn_upstream_highlight.js 双向高亮：选组→上游资产卡（琥珀金）；选资产卡→下游组（连线色）
#   dn_prompt_rich.js       该节点提示词的富文本编辑（chip / 缩略图 / @ 菜单）
#   dn_overlay.js           画布之上的 DOM 覆盖层（供上面几个把高亮画到节点之上）
#   dn_continuity_guard.js  修复导演台「引用上段」被静默重置
#   dn_group_split.js       「资产卡Group拆分」的输出口按素材数动态重建
#   dn_selflift_status.js   「SelfLift Sampler DN」的「高级选项」折叠 + seed 生成后控制默认 fixed +
#                           节点底部一采缓存状态条（onExecuted 接后端 ui 回传）
#   dn_director.js          「资产卡任务台」：分段口按连线自动增长（段数不限）+ 分段面板
#                           （排序 / 启停 / 逐段二采 / 缩略图 / 一采缓存状态）+ 队列调度器
#                            （v1.7.0 起为「流水线」：跑完一段自动提交下一段，同屏只 1 段在飞）
# 注意：新增/改动 WEB_DIRECTORY 需要重启一次 ComfyUI 才会被注册；之后改 js 只需刷新页面。
WEB_DIRECTORY = "./web/js"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
    "__version__",
]

# 分段口前缀（前端按连线动态加的口就叫 group_1 / group_2 …）；
# 供别的模块确认"导演台的口"时用同一个常量，别各写一份字符串。
DIRECTOR_SLOT_PREFIX = _DIRECTOR_SLOT_PREFIX
