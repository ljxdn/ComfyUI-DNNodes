"""DN 节点实现：资产卡（medias）→ MiniMax H3 Director 的 r2v 分组（group）。

节点只做数据搬运与编号对齐，不生成 subject_definitions / retention_analysis 段落
（那部分由外部提示词生成环节负责）。

输出契约对齐 ComfyUI_MiniMaxH3_Director 的 pack_r2v_group（Apache-2.0，未复制其代码）；
「资产名过滤」与「<Picture N> / <Audio J> 编号」规则对齐 ComfyUI-H3-OpenNodes 的
H3MediaPrompt（MIT，作者 sunnyboxs）。完整出处与授权见仓库根目录 THIRD_PARTY_NOTICES.md。
"""

from __future__ import annotations

from .media_group_core import (
    DEFAULT_DURATION_SEC,
    DEFAULT_MAX_EDGE,
    MAX_EDGE_LIMIT,
    MEDIA_SLOT_NAMES,
    MIN_MAX_EDGE,
    MMX_DIR_GROUP,
    build_r2v_group,
)

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
            )
            return (group,)


NODE_CLASS_MAPPINGS = {
    _NODE_ID: DNMediaToDirectorGroup,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    _NODE_ID: _DISPLAY_NAME,
}
