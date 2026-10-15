"""DN 节点实现：资产卡（medias）→ MiniMax H3 Director 的 r2v 分组（group）；
反向的「资产卡Group拆分」——把一个分组按顺序拆回单个图片 / 视频 / 音频 + 提示词；
以及「资产卡任务台」——把 N 段打包汇到一起，按「运行段」只吐其中一段给下游，
让几十段共用同一条「拆分 → 生成 → 采样」链（纯逻辑在 director_core.py）。

节点只做数据搬运与编号对齐，不生成 subject_definitions / retention_analysis 段落
（那部分由外部提示词生成环节负责）。

输出契约对齐 ComfyUI_MiniMaxH3_Director 的 pack_r2v_group（Apache-2.0，未复制其代码）；
「资产名过滤」与「<Picture N> / <Audio J> 编号」规则对齐 ComfyUI-H3-OpenNodes 的
H3MediaPrompt（MIT，作者 sunnyboxs）；「按数量重建输出口」的交互参考
ComfyUI-MiniMaxH3-Easy 的 Media Splitter（MIT，作者 nkxx188）。
完整出处与授权见仓库根目录 THIRD_PARTY_NOTICES.md。
"""

from __future__ import annotations

import torch

from .director_core import (
    MAX_SEGMENT_INDEX,
    select_group,
    slot_name,
    tag_label,
)
from .group_split_core import (
    AUDIO_OUTPUT_NAMES,
    DECLARED_OUTPUT_NAMES,
    DURATION_OUTPUT_NAME,
    IMAGE_OUTPUT_NAMES,
    MAX_SPLIT_AUDIOS,
    MAX_SPLIT_IMAGES,
    MAX_SPLIT_VIDEOS,
    VIDEO_OUTPUT_NAMES,
    as_group,
    group_duration,
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
_DISPLAY_NAME = "资产卡镜头打包"
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
    "把一个「资产卡镜头打包」输出的分组，按顺序拆回单个素材口，"
    "用来对接 MiniMax H3 官方工作流（ref_image_1..9 / ref_video_1..3 / ref_audio_1..3）："
    "第 k 个图片口就是提示词里的 <Picture k>，音频/视频同理。"
    "输出口的数量由「图片/视频/音频数量」三个控件决定（前端会自动按上游分组的实际素材数填好）；"
    "打开「固定 9+3+3 输出口」后始终显示 15 个素材口，上游素材变少时多出来的口不会报错、"
    "只会把挂在上面的分支剪掉，省得每次上游变了还要手动改下游连线。"
    "最下面的 prompt 口把分组里的提示词原样输出。"
    "⚠️ 本节点只负责「拆」，不负责过滤：资产名没出现在提示词里的卡，"
    "上游「资产卡镜头打包」打包时就已经丢掉了，这里看到的就是最终会被送进模型的那些。"
)

_SPLIT_GROUP_INPUT = "group"
_SPLIT_FIX_INPUT = "fix_max"
_SPLIT_IMAGE_INPUT = "image_count"
_SPLIT_VIDEO_INPUT = "video_count"
_SPLIT_AUDIO_INPUT = "audio_count"

_SPLIT_GROUP_TOOLTIP = "接「资产卡镜头打包」的 group 输出（类型 MMX_DIR_GROUP）。"
_SPLIT_FIX_TOOLTIP = (
    "开启后始终显示 MiniMax H3 的最大素材口数（9 图 + 3 视频 + 3 音频），"
    "并把三个数量自动写成 9 / 3 / 3；上游素材不足的口会被剪掉，不会报错。"
)
_SPLIT_COUNT_TOOLTIP = (
    "输出口数量。上游是「资产卡镜头打包」时会按分组里实际的{kind}数自动填；"
    "手改后只在检测不到上游时才保留。"
)


def _as_bool(value) -> bool:
    """控件值可能是 True / "true" / "True" / 1，统一成 bool。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value or "").strip().lower() in {"1", "true", "yes", "on", "开"}


def _placeholder_image():
    """缺素材时的中性占位图：1×1 黑图，下游接上照常采样，不会被 ExecutionBlocker 剪掉。"""
    return torch.zeros((1, 1, 1, 3), dtype=torch.float32)


def _placeholder_video():
    """缺素材时的中性占位视频：1 帧黑画面。"""
    return {"frames": torch.zeros((1, 1, 1, 3), dtype=torch.float32),
            "fps": 1, "format": "video/h264-mp4"}


def _placeholder_audio():
    """缺素材时的中性占位音频：0.1 秒静音。"""
    return {"waveform": torch.zeros((1, 1, 1600), dtype=torch.float32),
            "sample_rate": 16000}


_PLACEHOLDERS = {
    "image": _placeholder_image,
    "video": _placeholder_video,
    "audio": _placeholder_audio,
}


def _placeholder_for(name: str):
    """按输出口名返回对应类型的中性占位（缺素材时下游接上仍能正常采样）。"""
    for prefix, factory in _PLACEHOLDERS.items():
        if name.startswith(prefix):
            return factory()
    return None


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
    # prompt（提示词）与 duration（时长，秒）是**固定口**（不参与前端动态增删，
    # 永远在、排在最下边），类型分别写 STRING / FLOAT。
    RETURN_TYPES = (
        ("*",) * (len(IMAGE_OUTPUT_NAMES) + len(VIDEO_OUTPUT_NAMES) + len(AUDIO_OUTPUT_NAMES))
        + ("STRING", "FLOAT")
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

        group_dict = as_group(group)
        slots, prompt, _counts = split_group(
            group_dict, image_count, video_count, audio_count
        )
        # 缺素材的口不再发 ExecutionBlocker（那会让挂在它上面的下游分支被剪掉、
        # 直接跳过采样结束）。改发中性占位：缺图→1×1 黑图、缺视频→1 帧黑画面、
        # 缺音频→0.1s 静音。下游接上这些口照常采样，上游素材增减都兼容。
        outputs = [
            (_placeholder_for(name) if value is None else value)
            for name, value in zip(DECLARED_OUTPUT_NAMES[:-2], slots)
        ]
        outputs.append(prompt)
        outputs.append(group_duration(group_dict))
        return tuple(outputs)


# ======================================================================
# 资产卡任务台：N 段「资产卡镜头打包」→ 按「运行段」挑一段吐给下游
# ======================================================================

_DIRECTOR_NODE_ID = "DNGroupDirector"          # 节点 id 必须保持不变，否则已存的工作流会掉节点
_DIRECTOR_DISPLAY_NAME = "资产卡任务台"          # 只改界面显示名（2026-10-15 由「资产卡导演台」改名）
_DIRECTOR_DESCRIPTION = (
    "把多个「资产卡镜头打包」接到本节点（接满最后一个空口会自动多出一个空口，段数不限），"
    "本节点按「运行段」只把第 k 段的分组原样吐给下游 —— "
    "下游「资产卡Group拆分 → 参考生成 → 采样」只接一次线，几十段共用同一条链。"
    "「一段段按顺序循环跑」由节点的面板调度器完成：按面板顺序构造 N 份任务依次提交、"
    "每份只换「运行段」，所以拖动排序不会动任何一根连线。"
    "面板上可以逐段勾「运行」、逐段开关二采、拖动排序，并显示每段的时长 / "
    "参考图缩略图 / 一采缓存状态；缓存按段隔离（基础名 + 打包节点号），"
    "不会出现第 2 段命中第 1 段一采缓存那种串味。"
    "⚠️ 下游的「资产卡Group拆分」请打开「固定 9+3+3」—— 各段素材数不一样，"
    "口数固定住上下游才不会错位。"
)
#: 段号（1 起）：本节点只吐这一段的 group；调度器每提交一份任务换一个值。
_DIRECTOR_INDEX_INPUT = "current_index"
_DIRECTOR_INDEX_DISPLAY = "运行段"
_DIRECTOR_INDEX_TOOLTIP = (
    "本节点这次只吐出第几段（1 起的口序号，对应 group_1 / group_2 …）。"
    "面板上的「运行」会自动按段依次改写这个值；"
    "用 ComfyUI 原生「队列」按钮时，跑的就是这里填的那一段。"
)
_DIRECTOR_SLOT_TOOLTIP = (
    "接一个「资产卡镜头打包」的 group 输出。"
    "接满最后一个空口会自动多出一个空口 —— 段数不限，不用提前开够接口。"
)
_DIRECTOR_OUTPUT_TOOLTIP = (
    "当前「运行段」那一段的分组，原样输出；下游接「资产卡Group拆分」。"
)
#: 段标签输出口（形如「段2_二采」）：下游接「保存视频」的文件名前缀即可。
_DIRECTOR_TAG_OUTPUT = "tag"
_DIRECTOR_TAG_DISPLAY = "段标签"
_DIRECTOR_TAG_TOOLTIP = (
    "当前段的文件名标签（形如「段2_二采」：段号 + 该段跑一采还是二采）。"
    "接「保存视频」的文件名前缀（可先过「文本拼接」加你的子目录/日期），"
    "每段成片就自动带段号 + 一采/二采。"
)
#: 前端调度器把该段标签**塞进 prompt 快照**用的隐藏键（画布上不出现任何输入口）：
#: 本节点开了 accept_all_inputs，未声明的键也会原样送进 execute(**kwargs)，
#: 所以前端只改提交快照、不改画布，就能让 tag 随段变 —— 不新增任何可见端口。
_DIRECTOR_TAG_KEY = "tag_text"

#:: v3 之外的回退实现里声明多少个分段口（真机上走 v3 + accept_all_inputs，段数不限；
#: 这条分支只在宿主缺 comfy_api 时才会用到，前端同样会按连线把多余的尾部空口收掉）。
_LEGACY_DIRECTOR_SLOTS = 32


if comfy_io is not None:

    class DNGroupDirector(comfy_io.ComfyNode):
        """N 段打包 → 按运行段选一段。"""

        @classmethod
        def define_schema(cls):
            return comfy_io.Schema(
                node_id=_DIRECTOR_NODE_ID,
                display_name=_DIRECTOR_DISPLAY_NAME,
                category=_CATEGORY,
                description=_DIRECTOR_DESCRIPTION,
                # ⚠️ 这一行是本节点"段数不限"的关键：前端按连线动态加出来的
                # group_2..group_N 不在 Schema 里，只有开了这个开关，
                # execution.get_input_data 才会把它们塞进 kwargs
                # （否则**静默丢掉**，症状是"接了 5 段只跑第 1 段"）。
                accept_all_inputs=True,
                inputs=[
                    comfy_io.Int.Input(
                        _DIRECTOR_INDEX_INPUT,
                        display_name=_DIRECTOR_INDEX_DISPLAY,
                        default=1,
                        min=1,
                        max=MAX_SEGMENT_INDEX,
                        step=1,
                        tooltip=_DIRECTOR_INDEX_TOOLTIP,
                    ),
                    # 只声明第 1 个分段口：其余由前端按连线动态加（UI 上"接一个长一个"）。
                    comfy_io.Custom(MMX_DIR_GROUP).Input(
                        slot_name(1),
                        optional=True,
                        tooltip=_DIRECTOR_SLOT_TOOLTIP,
                    ),
                ],
                outputs=[
                    comfy_io.Custom(MMX_DIR_GROUP).Output(
                        "group", tooltip=_DIRECTOR_OUTPUT_TOOLTIP
                    ),
                    # 「段标签」：段号（随 current_index 变），下游接「保存视频」文件名前缀
                    comfy_io.String.Output(
                        _DIRECTOR_TAG_OUTPUT,
                        display_name=_DIRECTOR_TAG_DISPLAY,
                        tooltip=_DIRECTOR_TAG_TOOLTIP,
                    ),
                ],
            )

        @classmethod
        def execute(cls, current_index=1, **kwargs) -> "comfy_io.NodeOutput":
            # group_1..group_N 全在 kwargs 里（含前端动态加的）；
            # tag_text 是前端调度器按段塞进快照的段标签（未声明，靠 accept_all_inputs 传进来）
            _index, group = select_group(kwargs, current_index)
            tag = tag_label(kwargs.get(_DIRECTOR_TAG_KEY), current_index)
            return comfy_io.NodeOutput(
                as_group(group, who=_DIRECTOR_DISPLAY_NAME),
                tag,
            )

else:

    class DNGroupDirector:
        """旧式 API 回退实现：宿主缺 comfy_api 时才会用到（分段口是固定的 32 个）。"""

        @classmethod
        def INPUT_TYPES(cls):
            return {
                "required": {
                    _DIRECTOR_INDEX_INPUT: (
                        "INT",
                        {
                            "default": 1,
                            "min": 1,
                            "max": MAX_SEGMENT_INDEX,
                            "step": 1,
                            "display_name": _DIRECTOR_INDEX_DISPLAY,
                            "tooltip": _DIRECTOR_INDEX_TOOLTIP,
                        },
                    ),
                },
                "optional": {
                    **{
                        slot_name(i): (MMX_DIR_GROUP, {"tooltip": _DIRECTOR_SLOT_TOOLTIP})
                        for i in range(1, _LEGACY_DIRECTOR_SLOTS + 1)
                    },
                },
            }

        RETURN_TYPES = (MMX_DIR_GROUP, "STRING")
        RETURN_NAMES = ("group", _DIRECTOR_TAG_OUTPUT)
        FUNCTION = "direct"
        CATEGORY = _CATEGORY
        DESCRIPTION = _DIRECTOR_DESCRIPTION

        def direct(self, current_index=1, **kwargs):
            _index, group = select_group(kwargs, current_index)
            return (as_group(group, who=_DIRECTOR_DISPLAY_NAME),
                    tag_label(kwargs.get(_DIRECTOR_TAG_KEY), current_index))


NODE_CLASS_MAPPINGS = {
    _NODE_ID: DNMediaToDirectorGroup,
    _SPLIT_NODE_ID: DNGroupSplit,
    _DIRECTOR_NODE_ID: DNGroupDirector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    _NODE_ID: _DISPLAY_NAME,
    _SPLIT_NODE_ID: _SPLIT_DISPLAY_NAME,
    _DIRECTOR_NODE_ID: _DIRECTOR_DISPLAY_NAME,
}
