"""DN 节点纯逻辑层：把导演台分组（MMX_DIR_GROUP）按顺序拆回单个图片 / 视频 / 音频。

这一层刻意不导入 ComfyUI，方便脱离 ComfyUI 单独跑测试。

**顺序口径与 media_group_core.build_r2v_group 完全一致**：分组里的 ``ref_images``
是 0-based、按资产卡出现顺序分配的字典（第 k 个 → 提示词里的 ``<Picture k+1>``），
``ref_videos`` → ``<Video K>``、``ref_audios`` → ``<Audio J>``。
本模块按 key 排序后依次吐出，所以「拆分出来的第 k 个图片口」永远等于提示词里的
``<Picture k>`` —— 与官方 ``MiniMaxH3ReferenceToVideo`` 的 ``ref_image_N`` 槽位号一一对应。

出处与授权：
- 分组字典结构对接 ComfyUI_MiniMaxH3_Director（Apache-2.0），未复制其代码；
- 「按数量重建输出口 / 固定最大输出口」的交互参考 ComfyUI-MiniMaxH3-Easy 的
  Media Splitter（MIT，作者 nkxx188），未复制其代码。
完整说明见仓库根目录 THIRD_PARTY_NOTICES.md。
"""

from __future__ import annotations

from typing import Any

# 与 ComfyUI_MiniMaxH3_Director/director/external_groups.py 保持同一类型串。
# 从 media_group_core 引入，保证「打包」与「拆分」两侧用的是同一个字符串。
from .media_group_core import MMX_DIR_GROUP

# MiniMax H3 的上限（与导演台 lib/ref_images.py、lib/ref_audios.py 一致）：
#   参考图 ≤ 9（<Picture 1..9>）、参考视频 ≤ 3（<Video 1..3>）、参考音频 ≤ 3（<Audio 1..3>）
MAX_SPLIT_IMAGES = 9
MAX_SPLIT_VIDEOS = 3
MAX_SPLIT_AUDIOS = 3

IMAGE_OUTPUT_NAMES = tuple(f"image_{i}" for i in range(1, MAX_SPLIT_IMAGES + 1))
VIDEO_OUTPUT_NAMES = tuple(f"video_{i}" for i in range(1, MAX_SPLIT_VIDEOS + 1))
AUDIO_OUTPUT_NAMES = tuple(f"audio_{i}" for i in range(1, MAX_SPLIT_AUDIOS + 1))

#: 由本节点动态生成的输出口（前端按数量增删的就是这些）。
MANAGED_OUTPUT_NAMES = IMAGE_OUTPUT_NAMES + VIDEO_OUTPUT_NAMES + AUDIO_OUTPUT_NAMES
#: 固定不动的输出口 —— 提示词放在**所有素材口之下**（前端重建时会保持它在最后）。
PROMPT_OUTPUT_NAME = "prompt"

#: 节点声明用的完整输出名（前端会把 managed 的那些从节点定义里剔掉再按数量重建）。
DECLARED_OUTPUT_NAMES = MANAGED_OUTPUT_NAMES + (PROMPT_OUTPUT_NAME,)

#: 三个数量控件的 key（顺序 = 界面顺序 = 输出口顺序）。
COUNT_KEYS = ("image_count", "video_count", "audio_count")
COUNT_LIMITS = {
    "image_count": MAX_SPLIT_IMAGES,
    "video_count": MAX_SPLIT_VIDEOS,
    "audio_count": MAX_SPLIT_AUDIOS,
}
#: 分组字典里的素材键，与三个数量控件一一对应。
GROUP_KEYS = {
    "image_count": "ref_images",
    "video_count": "ref_videos",
    "audio_count": "ref_audios",
}


def ordered_media(mapping: Any) -> list[Any]:
    """把 ``{0: a, 2: b}`` 这类「按顺序编号的字典」展开成有序列表。

    - 非 dict（``None`` / 空 / 别的类型）→ ``[]``
    - 值为 ``None`` 的条目跳过（与导演台 ``pack_r2v_group`` 的过滤口径一致）
    - key 不是整数也能兜住（排到末尾），不会因为脏数据整段炸掉
    """
    if not isinstance(mapping, dict):
        return []
    items: list[tuple[int, Any]] = []
    for key, value in mapping.items():
        if value is None:
            continue
        try:
            order = int(key)
        except (TypeError, ValueError):
            order = 10**9 + len(items)
        items.append((order, value))
    items.sort(key=lambda pair: pair[0])
    return [value for _order, value in items]


def as_group(value: Any) -> dict[str, Any]:
    """取出单个分组字典。

    - ``dict`` → 本身
    - ``list`` / ``tuple``（多半是接到了 Groups Combine 上）→ 取第一个字典，其余忽略
    - 其它 → 抛 ValueError（报错要说清接的是什么）
    """
    if isinstance(value, dict):
        return value
    if isinstance(value, (list, tuple)):
        for item in value:
            if isinstance(item, dict):
                return item
        raise ValueError(
            "资产卡Group拆分：group 收到了列表，但里面没有分组字典。"
            "请把「资产卡 to Director Group」的 group 输出直接接到本节点。"
        )
    raise ValueError(
        "资产卡Group拆分：group 必须是导演台分组（MMX_DIR_GROUP），"
        f"实际收到 {type(value)!r}。"
    )


def clamp_counts(
    image_count: Any, video_count: Any, audio_count: Any
) -> dict[str, int]:
    """把三个数量夹到 MiniMax H3 的上限内（非数字 → 0）。"""
    raw = {
        "image_count": image_count,
        "video_count": video_count,
        "audio_count": audio_count,
    }
    out: dict[str, int] = {}
    for key, value in raw.items():
        try:
            number = int(value)
        except (TypeError, ValueError):
            number = 0
        out[key] = max(0, min(COUNT_LIMITS[key], number))
    return out


def group_counts(group: dict[str, Any]) -> dict[str, int]:
    """分组里实际有多少图 / 视频 / 音频。"""
    return {
        key: len(ordered_media(group.get(GROUP_KEY)))
        for key, GROUP_KEY in GROUP_KEYS.items()
    }


def group_prompt(group: dict[str, Any]) -> str:
    """分组里的提示词（``None`` → 空串，便于直接接文本节点）。"""
    value = group.get("prompt")
    return "" if value is None else str(value)


def split_group(
    group: dict[str, Any],
    image_count: Any,
    video_count: Any,
    audio_count: Any,
) -> tuple[list[Any], str, dict[str, int]]:
    """按数量把分组拆成输出槽位。

    返回 ``(slots, prompt, counts)``：

    - ``slots``：顺序为 ``[image_1..image_count, video_1..video_count, audio_1..audio_count]``；
      **数量超出实际拥有**的位置给 ``None``（由节点层换成 ``ExecutionBlocker``，
      这样下游挂在这一口上的分支会被静默剪掉，而不是把整张图跑挂）。
    - ``prompt``：分组自带的提示词。
    - ``counts``：夹过上限的最终数量（前端重建输出口用的就是同一组数字）。
    """
    counts = clamp_counts(image_count, video_count, audio_count)
    slots: list[Any] = []
    for key in COUNT_KEYS:
        values = ordered_media(group.get(GROUP_KEYS[key]))
        for index in range(counts[key]):
            slots.append(values[index] if index < len(values) else None)
    return slots, group_prompt(group), counts
