"""DN 节点实现：资产卡（medias）→ MiniMax H3 Director 的 r2v 分组（group）；
以及反向的「资产卡Group拆分」——把一个分组按顺序拆回单个图片 / 视频 / 音频 + 提示词。

节点只做数据搬运与编号对齐，不生成 subject_definitions / retention_analysis 段落
（那部分由外部提示词生成环节负责）。

输出契约对齐 ComfyUI_MiniMaxH3_Director 的 pack_r2v_group（Apache-2.0，未复制其代码）；
「资产名过滤」与「<Picture N> / <Audio J> 编号」规则对齐 ComfyUI-H3-OpenNodes 的
H3MediaPrompt（MIT，作者 sunnyboxs）；「按数量重建输出口」的交互参考
ComfyUI-MiniMaxH3-Easy 的 Media Splitter（MIT，作者 nkxx188）。
完整出处与授权见仓库根目录 THIRD_PARTY_NOTICES.md。
"""

from __future__ import annotations

from .group_split_core import (
    AUDIO_OUTPUT_NAMES,
    DECLARED_OUTPUT_NAMES,
    IMAGE_OUTPUT_NAMES,
    MAX_SPLIT_AUDIOS,
    MAX_SPLIT_IMAGES,
    MAX_SPLIT_VIDEOS,
    VIDEO_OUTPUT_NAMES,
    as_group,
    split_group,
)
from .media_group_core import (
    DEFAULT_DURATION_SEC,
    DEFAULT_MAX_EDGE,
    MAX_EDGE_LIMIT,
    MEDIA_SLOT_NAMES,
    MIN_MAX_EDGE,
    MMX_DIR_GROUP,
    build_r2v_group,
)

try:  # 只在宿主里存在；脱离 ComfyUI 跑离线单测时用兜底类。
    from comfy_execution.graph_utils import ExecutionBlocker
except Exception:  # pragma: no cover - 离线导入路径

    class ExecutionBlocker:  # type: ignore[no-redef]
        """离线兜底：真跑时由 ComfyUI 提供（值为 None 的口会静默剪掉下游分支）。"""

        def __init__(self, value=None):
            self.value = value


_CATEGORY = "DN Nodes"

_NODE_ID = "DNMediaToDirectorGroup"
_DISPLAY_NAME = "资产卡 to Director Group"
_DESCRIPTION = (
    "把资产卡（Asset Card）输出的 medias（多张资产卡）适配成 MiniMax H3 Director 的 "
    "Reference to Video 分组：按出现顺序把每张卡的图 / 音分别拆进 ref_images / ref_audios，"
    "其编号与提示词里的 <Picture N> / <Audio J> 一一对应。"
    "资产名（role_name）非空、但未出现在提示词里的资产卡会被跳过（与上游同一规则）。"
    "「最长边」只限制参考图的尺寸：超过就等比缩小，没超过就保持原图（绝不放大）。"
    "medias 端口可接多条连线（最多 9 条），编号顺序就是你连线的顺序。"
    "输出可直接接 Director 的 r2v_groups，或先接 Groups Combine 再送 Director。"
)

# 键名（id）保持英文，界面上显示的中文标题走 display_name —— 这样既不影响界面观感，
# 也让下游（导演台按 duration_sec 读每组时长）不必再兼容中文键。
# 依据：ComfyUI 前端 addInputWidget() 里 widget.label = resolveLabel(s.label ?? i.display_name ?? name)。
INPUT_PROMPT = "prompt"
INPUT_DURATION = "duration_sec"
INPUT_MAX_EDGE = "max_edge"
INPUT_MEDIAS = "medias"
# 前端「单端口多连线」注入用的隐藏槽；名字与 H3MediaPrompt 的 media_1..media_9 一致。
INPUT_MEDIA_SLOTS = MEDIA_SLOT_NAMES
#: 段级音频开关：前端按**连线顺序**注入的掩码串（"101" = 第 2 条不带音）。
#: 与 media_1..N 同一套顺序；缺位按「保留」处理，所以老工作流行为不变。
INPUT_AUDIO_MASK = "link_audio_mask"

INPUT_PROMPT_DISPLAY = "提示词"
INPUT_DURATION_DISPLAY = "时长（秒）"
INPUT_MAX_EDGE_DISPLAY = "最长边"

_DURATION_TOOLTIP = "本段时长（秒），最终会吸附到 MiniMax 的 17k+5 帧。"
_MAX_EDGE_TOOLTIP = (
    "参考图最长边上限（像素）。图片最长边超过该值 → 保持比例等比缩小到该值；"
    "没超过 → 原样使用，绝不放大。"
)
_MEDIAS_TOOLTIP = (
    "接资产卡的 media 输出；该端口可接多条连线（最多 9 条），按连接先后顺序编号。"
)
# 隐藏槽的 tooltip：UI 上看不到（前端会把这些槽从节点定义里剔掉），仅作后端说明。
_MEDIA_SLOT_TOOLTIP = "隐藏槽：由前端「单端口多连线」按连接顺序注入，正常无需手工接线。"
_AUDIO_MASK_TOOLTIP = (
    "隐藏输入：段级音频开关，由前端「单端口多连线」按连线顺序注入"
    "（如 \"101\" = 第 2 条连线本段不带音）。留空 = 全部带音。"
)

# 旧键名 → 兼容曾经用过中文键名的工作流（尤其是按名存输入的 API 格式），避免升级后取值落空。
_LEGACY_INPUT_NAMES = {INPUT_DURATION: "时长_秒", INPUT_MAX_EDGE: "最长边"}


def _pick(inputs: dict, name: str, default):
    """按英文键（现行 id）取值；取不到再回退旧中文键，最后回退默认值。"""
    if inputs.get(name) is not None:
        return inputs[name]
    legacy = _LEGACY_INPUT_NAMES.get(name)
    if legacy and inputs.get(legacy) is not None:
        return inputs[legacy]
    return default


try:
    from comfy_api.latest import io as comfy_io
except ImportError:  # pragma: no cover — 只在宿主缺 comfy_api 时走到
    comfy_io = None


if comfy_io is not None:

    class DNMediaToDirectorGroup(comfy_io.ComfyNode):
        """H3 角色卡 medias → 导演台 r2v 分组。"""

        @classmethod
        def define_schema(cls):
            return comfy_io.Schema(
                node_id=_NODE_ID,
                display_name=_DISPLAY_NAME,
                category=_CATEGORY,
                description=_DESCRIPTION,
                inputs=[
                    comfy_io.String.Input(
                        INPUT_PROMPT,
                        display_name=INPUT_PROMPT_DISPLAY,
                        multiline=True,
                        default="",
                        dynamic_prompts=True,
                        tooltip="本段视频的提示词；用 <Picture N> / <Audio J> 引用角色卡素材。",
                    ),
                    comfy_io.Float.Input(
                        INPUT_DURATION,
                        display_name=INPUT_DURATION_DISPLAY,
                        default=DEFAULT_DURATION_SEC,
                        min=0.2,
                        max=120.0,
                        step=0.1,
                        tooltip=_DURATION_TOOLTIP,
                    ),
                    comfy_io.Int.Input(
                        INPUT_MAX_EDGE,
                        display_name=INPUT_MAX_EDGE_DISPLAY,
                        default=DEFAULT_MAX_EDGE,
                        min=MIN_MAX_EDGE,
                        max=MAX_EDGE_LIMIT,
                        step=1,
                        tooltip=_MAX_EDGE_TOOLTIP,
                    ),
                    comfy_io.Custom("H3_MEDIA,IMAGE").Input(
                        INPUT_MEDIAS,
                        optional=True,
                        tooltip=_MEDIAS_TOOLTIP,
                    ),
                    *[
                        comfy_io.Custom("H3_MEDIA,IMAGE").Input(
                            name,
                            optional=True,
                            extra_dict={"hidden": True},
                            tooltip=_MEDIA_SLOT_TOOLTIP,
                        )
                        for name in INPUT_MEDIA_SLOTS
                    ],
                    # 段级音频开关：与 media_1..N 同一套顺序的掩码串（"101" = 第 2 条不带音）。
                    # 同样标 hidden —— 前端还会把这个名字从节点定义里再剔一次（见
                    # dn_media_multilink.js 的 trimNodeDefinition），确保它一个字都不露在界面上。
                    comfy_io.String.Input(
                        INPUT_AUDIO_MASK,
                        optional=True,
                        default="",
                        extra_dict={"hidden": True},
                        tooltip=_AUDIO_MASK_TOOLTIP,
                    ),
                ],
                outputs=[
                    comfy_io.Custom(MMX_DIR_GROUP).Output("group"),
                ],
            )

        @classmethod
        def execute(cls, **kwargs) -> "comfy_io.NodeOutput":
            group = build_r2v_group(
                kwargs.get(INPUT_MEDIAS),
                kwargs.get(INPUT_PROMPT) or "",
                _pick(kwargs, INPUT_DURATION, DEFAULT_DURATION_SEC),
                _pick(kwargs, INPUT_MAX_EDGE, DEFAULT_MAX_EDGE),
                media_slots=[kwargs.get(name) for name in INPUT_MEDIA_SLOTS],
                audio_mask=kwargs.get(INPUT_AUDIO_MASK),
            )
            return comfy_io.NodeOutput(group)

else:

    class DNMediaToDirectorGroup:
        """旧式 API 回退实现：宿主缺 comfy_api 时才会用到。"""

        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    "prompt": (
                        "STRING",
                        {"multiline": True, "default": "", "dynamicPrompts": True},
                    ),
                    INPUT_DURATION: (
                        "FLOAT",
                        {
                            "default": DEFAULT_DURATION_SEC,
                            "min": 0.2,
                            "max": 120.0,
                            "step": 0.1,
                        },
                    ),
                    INPUT_MAX_EDGE: (
                        "INT",
                        {
                            "default": DEFAULT_MAX_EDGE,
                            "min": MIN_MAX_EDGE,
                            "max": MAX_EDGE_LIMIT,
                            "step": 1,
                        },
                    ),
                },
                "optional": {
                    # ComfyUI 的 validation 会按逗号拆分类型串，故可声明多类型。
                    INPUT_MEDIAS: ("H3_MEDIA,IMAGE",),
                    # 隐藏槽：由前端「单端口多连线」注入 media_1..media_9（UI 不显示）。
                    **{name: ("H3_MEDIA,IMAGE",) for name in INPUT_MEDIA_SLOTS},
                    # 段级音频开关（隐藏输入，由前端按连线顺序注入）。
                    INPUT_AUDIO_MASK: ("STRING", {"default": ""}),
                },
            }

        RETURN_TYPES = (MMX_DIR_GROUP,)
        RETURN_NAMES = ("group",)
        FUNCTION = "build"
        CATEGORY = _CATEGORY
        DESCRIPTION = _DESCRIPTION

        def build(self, **kwargs):
            group = build_r2v_group(
                kwargs.get(INPUT_MEDIAS),
                kwargs.get(INPUT_PROMPT) or "",
                _pick(kwargs, INPUT_DURATION, DEFAULT_DURATION_SEC),
                _pick(kwargs, INPUT_MAX_EDGE, DEFAULT_MAX_EDGE),
                media_slots=[kwargs.get(name) for name in INPUT_MEDIA_SLOTS],
                audio_mask=kwargs.get(INPUT_AUDIO_MASK),
            )
            return (group,)


# ======================================================================
# 资产卡Group拆分：导演台分组 → 单个图片 / 视频 / 音频（+ 提示词）
# ======================================================================

_SPLIT_NODE_ID = "DNGroupSplit"
_SPLIT_DISPLAY_NAME = "资产卡Group拆分"
_SPLIT_DESCRIPTION = (
    "把一个「资产卡 to Director Group」输出的分组，按顺序拆回单个素材口，"
    "用来对接 MiniMax H3 官方工作流（ref_image_1..9 / ref_video_1..3 / ref_audio_1..3）："
    "第 k 个图片口就是提示词里的 <Picture k>，音频/视频同理。"
    "输出口的数量由「图片/视频/音频数量」三个控件决定（前端会自动按上游分组的实际素材数填好）；"
    "打开「固定 9+3+3 输出口」后始终显示 15 个素材口，上游素材变少时多出来的口不会报错、"
    "只会把挂在上面的分支剪掉，省得每次上游变了还要手动改下游连线。"
    "最下面的 prompt 口把分组里的提示词原样输出。"
    "⚠️ 本节点只负责「拆」，不负责过滤：资产名没出现在提示词里的卡，"
    "上游「资产卡 to Director Group」打包时就已经丢掉了，这里看到的就是最终会被送进模型的那些。"
)

_SPLIT_GROUP_INPUT = "group"
_SPLIT_FIX_INPUT = "fix_max"
_SPLIT_IMAGE_INPUT = "image_count"
_SPLIT_VIDEO_INPUT = "video_count"
_SPLIT_AUDIO_INPUT = "audio_count"

_SPLIT_GROUP_TOOLTIP = "接「资产卡 to Director Group」的 group 输出（类型 MMX_DIR_GROUP）。"
_SPLIT_FIX_TOOLTIP = (
    "开启后始终显示 MiniMax H3 的最大素材口数（9 图 + 3 视频 + 3 音频），"
    "并把三个数量自动写成 9 / 3 / 3；上游素材不足的口会被剪掉，不会报错。"
)
_SPLIT_COUNT_TOOLTIP = (
    "输出口数量。上游是「资产卡 to Director Group」时会按分组里实际的{kind}数自动填；"
    "手改后只在检测不到上游时才保留。"
)


def _as_bool(value) -> bool:
    """控件值可能是 True / "true" / "True" / 1，统一成 bool。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value or "").strip().lower() in {"1", "true", "yes", "on", "开"}


class DNGroupSplit:
    """导演台分组 → 单个图片 / 视频 / 音频 + 提示词。

    输出口的**声明**是 9+3+3+1 共 16 个（前端会把素材口从节点定义里剔掉，
    再按数量重建 —— 与 ComfyUI-MiniMaxH3-Easy 的 Media Splitter 同一套做法）。
    所以这里声明的顺序必须与前端重建后的顺序一致：图片 → 视频 → 音频 → 提示词。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                _SPLIT_GROUP_INPUT: (
                    MMX_DIR_GROUP,
                    {"tooltip": _SPLIT_GROUP_TOOLTIP},
                ),
                _SPLIT_FIX_INPUT: (
                    "BOOLEAN",
                    {
                        "default": False,
                        "display_name": "固定 9+3+3 输出口",
                        "tooltip": _SPLIT_FIX_TOOLTIP,
                    },
                ),
                _SPLIT_IMAGE_INPUT: (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": MAX_SPLIT_IMAGES,
                        "step": 1,
                        "display_name": "图片数量",
                        "tooltip": _SPLIT_COUNT_TOOLTIP.format(kind="图片"),
                    },
                ),
                _SPLIT_VIDEO_INPUT: (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": MAX_SPLIT_VIDEOS,
                        "step": 1,
                        "display_name": "视频数量",
                        "tooltip": _SPLIT_COUNT_TOOLTIP.format(kind="参考视频"),
                    },
                ),
                _SPLIT_AUDIO_INPUT: (
                    "INT",
                    {
                        "default": 1,
                        "min": 0,
                        "max": MAX_SPLIT_AUDIOS,
                        "step": 1,
                        "display_name": "音频数量",
                        "tooltip": _SPLIT_COUNT_TOOLTIP.format(kind="音频"),
                    },
                ),
            },
        }

    # 素材口用 "*"：前端会把它们从节点定义里剔掉、按数量重建并写上真实类型
    # （IMAGE / IMAGE / AUDIO）。用 "*" 才能让「重建出来的口」连到任何下游输入。
    RETURN_TYPES = ("*",) * (len(IMAGE_OUTPUT_NAMES) + len(VIDEO_OUTPUT_NAMES) + len(AUDIO_OUTPUT_NAMES)) + (
        "STRING",
    )
    RETURN_NAMES = DECLARED_OUTPUT_NAMES
    FUNCTION = "split"
    CATEGORY = _CATEGORY
    OUTPUT_NODE = False
    DESCRIPTION = _SPLIT_DESCRIPTION

    def split(
        self,
        group=None,
        fix_max=False,
        image_count=1,
        video_count=0,
        audio_count=1,
    ):
        if _as_bool(fix_max):
            image_count, video_count, audio_count = (
                MAX_SPLIT_IMAGES,
                MAX_SPLIT_VIDEOS,
                MAX_SPLIT_AUDIOS,
            )

        slots, prompt, _counts = split_group(
            as_group(group), image_count, video_count, audio_count
        )
        # 数量超出实际拥有的口给 ExecutionBlocker：挂在这一口上的下游分支会被剪掉，
        # 既不会报错，也不会把 None 喂给普通节点（与上游 Media Splitter 的默认行为一致）。
        outputs = [
            ExecutionBlocker(None) if value is None else value for value in slots
        ]
        outputs.append(prompt)
        return tuple(outputs)


NODE_CLASS_MAPPINGS = {
    _NODE_ID: DNMediaToDirectorGroup,
    _SPLIT_NODE_ID: DNGroupSplit,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    _NODE_ID: _DISPLAY_NAME,
    _SPLIT_NODE_ID: _SPLIT_DISPLAY_NAME,
}
