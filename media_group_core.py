"""DN 节点纯逻辑层：把资产卡（H3_MEDIA）适配成导演台分组（MMX_DIR_GROUP）。

这一层刻意不导入 ComfyUI，方便脱离 ComfyUI 单独跑测试。

编号对齐依据（来自 ComfyUI-H3-OpenNodes / ComfyUI_MiniMaxH3_Director 源码）：
- H3 Media Prompt：``picture_index`` 只在 media 带图时 +1，``audio_index`` 只在
  media 带音时 +1；两者都从 1 开始、各自独立计数、按出现顺序。
- 导演台 r2v 分组：``ref_images`` 的 dict key 是 0-based，``key + 1`` 就是提示词里的
  ``<Picture N>``；``ref_audios`` 同理映射 ``<Audio J>``。

=> 只要按出现顺序枚举，本模块产出的 ref_images[k] 就天然对应「第 k 张图 → <Picture k+1>」，
   与上游 H3 Media Prompt 的编号规则完全一致。

出处与授权：编号规则与槽位命名参考 ComfyUI-H3-OpenNodes（MIT，作者 sunnyboxs）；
分组字典结构对接 ComfyUI_MiniMaxH3_Director（Apache-2.0）。两处均未复制代码，
完整说明见仓库根目录 THIRD_PARTY_NOTICES.md。
"""

from __future__ import annotations

from typing import Any

import torch
from torch.nn import functional as F

# 与 ComfyUI_MiniMaxH3_Director/director/external_groups.py 保持同一类型串。
MMX_DIR_GROUP = "MMX_DIR_GROUP"

# 与导演台 lib/ref_images.py、lib/ref_audios.py 的上限保持一致。
MAX_REFERENCE_IMAGES = 9
MAX_REFERENCE_AUDIOS = 3

# 与 director/fl2v_timeline.py 的 DEFAULT_FL2V_DURATION_SEC 保持一致。
DEFAULT_DURATION_SEC = 5.0

# 「最长边」限制：只等比缩小，绝不放大。
# 节点 UI 上的 max 用 MAX_EDGE_LIMIT；默认 1440 = 超过 1440 就缩到 1440。
MAX_EDGE_LIMIT = 4096
DEFAULT_MAX_EDGE = 1440
MIN_MAX_EDGE = 32
# 缩放后把宽高吸附到 stride 的整数倍，避免出现奇数边长。
# 与导演台 lib/image_prep.fit_edge_limit(edge="long") 的默认 stride 一致。
RESIZE_STRIDE = 2

# 判定「这是一个 media 对象」的标记键，取自 H3MediaPrompt 的同名判断。
MEDIA_MARKER_KEYS = ("type", "image", "audio", "role_name", "prompt")

# 前端「单端口多连线」注入用的隐藏槽名字，与 H3MediaPrompt 的 media_1..media_9 同名同序。
# 后端声明这些槽是为了让注入进 prompt 的 media_N 成为合法输入名；UI 上看不见（前端会剔掉）。
MEDIA_SLOT_NAMES = tuple(f"media_{i}" for i in range(1, 10))


def is_media_object(value: Any) -> bool:
    """是否是 H3_MEDIA 形态的字典（而不是 media_1/media_2 这种容器）。"""
    return isinstance(value, dict) and any(k in value for k in MEDIA_MARKER_KEYS)


def _wrap_bare_image(tensor: torch.Tensor) -> dict[str, Any]:
    """把裸 IMAGE 张量包成 IMAGE 型 media，规则对齐 H3MediaPrompt。"""
    if len(tensor.shape) != 4 or tensor.shape[-1] not in (1, 3, 4):
        raise TypeError(
            "DN Media to Director Group: IMAGE 输入必须是 [B, H, W, C] 张量，"
            f"且通道数为 1/3/4，实际为 {tuple(tensor.shape)}"
        )
    return {"type": "IMAGE", "image": tensor, "audio": None, "role_name": None, "prompt": None}


def flatten_medias(value: Any) -> list[dict[str, Any]]:
    """把 medias 展开成一个有序的 media 列表。

    支持的形态（与 H3MediaPrompt 的透传输出一致）：
    - ``None`` / 空 → ``[]``
    - 单个 media dict → ``[media]``
    - ``{"media_1": ..., "media_2": ...}`` 容器 → 按值顺序展开
    - 嵌套的 dict / list / tuple → 递归展开
    - 裸 IMAGE 张量 → 包成 IMAGE 型 media

    排序规则对齐 H3MediaPrompt：media 字典在前，裸 IMAGE 包装后排在末尾。
    """
    dict_medias: list[dict[str, Any]] = []
    bare_images: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if node is None:
            return
        if is_media_object(node):
            dict_medias.append(node)
            return
        if isinstance(node, dict):
            for nested in node.values():
                walk(nested)
            return
        if isinstance(node, (list, tuple)):
            for nested in node:
                walk(nested)
            return
        if isinstance(node, torch.Tensor):
            bare_images.append(_wrap_bare_image(node))
            return
        raise TypeError(
            "DN Media to Director Group: medias 只接受 H3_MEDIA 对象或 IMAGE 张量，"
            f"实际收到 {type(node)!r}"
        )

    walk(value)
    return dict_medias + bare_images


def collate_media_inputs(medias: Any = None, media_slots: Any = None) -> list[Any]:
    """把可见端口的 ``medias`` 与前端注入的隐藏槽 ``media_1..media_9`` 合成一个有序列表。

    顺序约定与 ``H3MediaPrompt._build_medias_passthrough`` 完全一致：**先 medias，再 media_1..9 按序**；
    合并结果交给 :func:`flatten_medias` 统一展开（media 字典在前、裸 IMAGE 后置），
    所以「第 k 个带图的卡 → ``<Picture k>``」的编号关系与上游节点保持一致。

    ``media_slots`` 支持三种形态：

    - ``None`` → 没有槽，只有 ``medias``
    - ``dict`` → ``{"media_1": v, ...}``，按 :data:`MEDIA_SLOT_NAMES` 的名字顺序取值（空槽跳过）
    - ``list`` / ``tuple`` → 按给定顺序取值（前端注入路径就是这种）
    """
    ordered: list[Any] = [medias]
    if media_slots is None:
        return ordered
    if isinstance(media_slots, dict):
        for name in MEDIA_SLOT_NAMES:
            value = media_slots.get(name)
            if value is not None:
                ordered.append(value)
    elif isinstance(media_slots, (list, tuple)):
        ordered.extend(media_slots)
    else:
        ordered.append(media_slots)
    return ordered


def filter_unused_role_medias(
    medias: list[dict[str, Any]], prompt: str
) -> list[dict[str, Any]]:
    """复刻 H3MediaPrompt._filter_unused_role_medias 的角色卡去留规则。

    - ``type == "IMAGE"``（裸图）不过滤
    - ``role_name`` 为空 / 纯空白 不过滤
    - 其余：``role_name`` 必须出现在 prompt 文本里才保留

    与 H3 Media Prompt 用同一规则，才能保证 ``<Picture N>`` / ``<Audio J>`` 编号不错位。
    """
    prompt_text = "" if prompt is None else str(prompt)
    kept: list[dict[str, Any]] = []
    for item in medias:
        if item.get("type") != "IMAGE":
            role_name = item.get("role_name")
            if role_name is not None:
                role_name = str(role_name).strip()
                if role_name and role_name not in prompt_text:
                    continue
        kept.append(item)
    return kept


def as_image_batch(image: Any) -> torch.Tensor | None:
    """归一化为 [B, H, W, C] 张量；规则对齐导演台 external_groups._as_image_batch。"""
    if image is None:
        return None
    if isinstance(image, (list, tuple)):
        if not image:
            return None
        image = image[0]
        if image is None:
            return None
    if not isinstance(image, torch.Tensor) or image.numel() <= 0:
        return None
    tensor = image
    if tensor.ndim == 3:
        tensor = tensor.unsqueeze(0)
    if tensor.ndim != 4:
        raise ValueError(f"期望 IMAGE 张量 [B, H, W, C]，实际 {tuple(tensor.shape)}")
    return tensor.contiguous().float()


def as_audio(audio: Any) -> dict | None:
    """判定是否为可用的 ComfyUI AUDIO 字典；规则对齐导演台 external_groups._as_audio。"""
    if audio is None or not isinstance(audio, dict):
        return None
    if audio.get("waveform") is None:
        return None
    return audio


def resize_long_edge(
    image: torch.Tensor | None,
    max_edge: int | None,
    stride: int = RESIZE_STRIDE,
) -> torch.Tensor | None:
    """等比缩小图片，使最长边不超过 ``max_edge``；本来就够小就原样返回（绝不放大）。

    - ``max_edge`` 为 ``None`` / <= 0 → 视为不限制，直接返回原张量
    - 最长边 <= ``max_edge`` → 返回**原张量本身**（不复制、不吸附、像素零改动）
    - 最长边 > ``max_edge`` → 按 ``max_edge / 最长边`` 等比缩小，宽高吸附到 ``stride`` 的整数倍
      （与导演台 ``lib/image_prep.fit_edge_limit(edge="long")`` 同一套算法）
    - 通道数原样保留（导演台内部只取前 3 通道，这里不替它做裁剪）
    """
    if image is None or not isinstance(image, torch.Tensor) or image.numel() <= 0:
        return image
    if max_edge is None:
        return image
    try:
        limit = int(max_edge)
    except (TypeError, ValueError):
        return image
    if limit <= 0:
        return image
    limit = max(int(stride), limit)

    height, width = int(image.shape[-3]), int(image.shape[-2])
    current = max(height, width)
    if current <= limit:
        return image

    scale = limit / float(current)
    new_h = max(stride, int(round(height * scale / stride) * stride))
    new_w = max(stride, int(round(width * scale / stride) * stride))
    if new_h == height and new_w == width:
        return image

    resized = F.interpolate(image.movedim(-1, 1), size=(new_h, new_w), mode="area").movedim(1, -1)
    return resized


def extract_reference_slots(
    medias: list[dict[str, Any]],
    max_edge: int | None = None,
) -> tuple[dict[int, torch.Tensor], dict[int, dict]]:
    """按出现顺序抽取参考图与参考音频，生成 0-based 的索引字典。

    计数器语义与 H3MediaPrompt 完全一致：只有「带图」的 media 才占用下一个图片编号，
    只有「带音」的 media 才占用下一个音频编号；两者互不影响。

    ``max_edge`` 会对每张参考图做等比缩小（只缩不放），编号顺序不受影响。
    """
    ref_images: dict[int, torch.Tensor] = {}
    ref_audios: dict[int, dict] = {}

    for item in medias:
        image = as_image_batch(item.get("image"))
        if image is not None:
            if len(ref_images) >= MAX_REFERENCE_IMAGES:
                raise ValueError(
                    f"DN Media to Director Group: 参考图超过 {MAX_REFERENCE_IMAGES} 张上限"
                    "（MiniMax H3 只支持 <Picture 1>…<Picture 9>）。"
                )
            ref_images[len(ref_images)] = resize_long_edge(image[:1].clone(), max_edge)

        audio = as_audio(item.get("audio"))
        if audio is not None:
            if len(ref_audios) >= MAX_REFERENCE_AUDIOS:
                raise ValueError(
                    f"DN Media to Director Group: 参考音频超过 {MAX_REFERENCE_AUDIOS} 条上限"
                    "（MiniMax H3 只支持 <Audio 1>…<Audio 3>）。"
                )
            ref_audios[len(ref_audios)] = audio

    return ref_images, ref_audios


def build_r2v_group(
    medias: Any = None,
    prompt: str = "",
    duration_sec: float = DEFAULT_DURATION_SEC,
    max_edge: int | None = DEFAULT_MAX_EDGE,
    media_slots: Any = None,
) -> dict[str, Any]:
    """把角色卡 + 提示词 + 时长 打包成一个导演台 r2v 分组字典。

    结构与 ComfyUI_MiniMaxH3_Director 的 ``pack_r2v_group`` 输出逐字段对齐，
    可直接接到 ``MiniMax H3 Director Group (Reference to Video)`` 的同类输出口
    （Director.r2v_groups / Groups Combine）。

    ``media_slots`` 是前端「单端口多连线」注入的隐藏槽（``media_1..media_9``），
    按 :func:`collate_media_inputs` 的约定排在 ``medias`` 之后 —— 即**连接顺序就是编号顺序**。

    ``max_edge`` 只作用于参考图张量本身（等比缩小），**不写进分组字典**，
    因此不影响与导演台的数据兼容性。
    """
    prompt_text = "" if prompt is None else str(prompt).strip()

    kept = filter_unused_role_medias(
        flatten_medias(collate_media_inputs(medias, media_slots)), prompt_text
    )
    ref_images, ref_audios = extract_reference_slots(kept, max_edge)

    if not prompt_text and not ref_images and not ref_audios:
        raise ValueError(
            "DN Media to Director Group: 至少需要一段提示词，或一组参考图 / 参考音频。"
        )

    return {
        "version": 1,
        "family": "r2v",
        "kind": "r2v",
        "prompt": prompt_text,
        "duration_sec": (
            float(duration_sec) if duration_sec is not None else DEFAULT_DURATION_SEC
        ),
        "first_frame": None,
        "last_frame": None,
        "ref_images": ref_images,
        "ref_videos": {},
        "ref_video_audios": {},
        "ref_audios": ref_audios,
    }
