"""DN 节点纯逻辑层：资产卡任务台 —— 从 N 段「资产卡镜头打包」里挑出当前要跑的那一段。

这一层刻意不导入 ComfyUI，方便脱离 ComfyUI 单独跑测试。

为什么是「选段器」而不是「汇总器」（设计口径，改代码前先看这一段）：

- ComfyUI 的图是**静态**的：一个输出口只能接一个下游。要让 N 段共用同一条
  「资产卡Group拆分 → 参考生成 → 采样」链，唯一的办法是**把 N 段喂给同一个节点，
  由它按「当前跑第几段」挑一段原样吐出去** —— 下游链只接一次线，几十段也不用改线。
  （N 段各自串一条链的做法会把节点数乘以 N，用户明确否决过。）
- 「按顺序循环跑 N 段」**不是节点能做的事**：节点在一次执行里只被调用一次，
  没法让下游跟着循环。循环由**前端调度器**做：按面板顺序构造 N 份 prompt 依次提交，
  每份只把 ``current_index`` 换成第 k 段。ComfyUI 自己的队列本来就是串行的。
- 输入口数量**不设上限**：后端 Schema 里只声明 ``group_1``，另开
  ``accept_all_inputs=True``，前端按连线动态 ``addInput`` 出 ``group_2..group_N``
  （ComfyUI 官方 v3 机制；KJNodes 的 ``*Multi`` 系列用的就是这一套，
  见 ``ComfyUI-KJNodes/nodes/image_nodes.py`` 的 ``ImageConcatMulti``）。
  没有这个开关，前端加的口会被后端**静默忽略**（`execution.py` 只把声明过的输入名
  塞进 kwargs）—— 那就是"连了 5 段却只跑 1 段"的静默错位，绝不能发生。

段号口径：``current_index`` 是 **1 起**的**口序号**（``group_k`` 里的 k），
与面板里的显示顺序（运行先后）是两回事：面板排序只改**提交顺序**，不改接线，
所以"拖动排序"一根线都不用动。缓存命名同理按**打包节点 id** 认身份（见前端），
不按序号 —— 否则重排一次就会让某段吃到另一段的一采缓存。
"""

from __future__ import annotations

from typing import Any, Mapping

#: 分段输入口前缀：``group_1`` / ``group_2`` …（前端按连线动态增删的也是这些名字）。
SLOT_PREFIX = "group_"

#: ``current_index`` 控件允许的上限。前端不会让段号超过实际接线数，
#: 这里只是"别让人手填一个天文数字"。
MAX_SEGMENT_INDEX = 999


def slot_name(index: int) -> str:
    """段号 → 输入口名（1 起）。"""
    return f"{SLOT_PREFIX}{int(index)}"


def slot_index_of(name: Any) -> int | None:
    """输入口名 → 段号；不是 ``group_<正整数>`` 一律返回 ``None``。

    - ``group_1`` → 1，``group_12`` → 12
    - ``group_01`` → 1（容忍前导零：名字是前端生成的，写成 01 也认；反正不会同时出现）
    - ``group_0`` / ``groups`` / ``group_1_x`` / ``media_1`` → ``None``
      （老老实实报"没接"，好过把别人的口当成段）
    """
    text = str(name or "")
    if not text.startswith(SLOT_PREFIX):
        return None
    tail = text[len(SLOT_PREFIX):]
    if not tail.isdigit():
        return None
    index = int(tail)
    return index if index >= 1 else None


def collect_slots(inputs: Mapping[str, Any]) -> "dict[int, Any]":
    """把执行期输入摊成 ``{段号: 分组}``（只收匹配的、值不是 ``None`` 的）。

    ``inputs`` 就是节点 ``execute(**kwargs)`` 收到的那些 —— 前端动态加的
    ``group_2..group_N`` 也在里面（靠 Schema 的 ``accept_all_inputs=True``）。
    """
    slots: dict[int, Any] = {}
    if not inputs:
        return slots
    for key, value in inputs.items():
        index = slot_index_of(key)
        if index is None or value is None:
            continue
        slots[index] = value
    return slots


def connected_indexes(inputs: Mapping[str, Any]) -> "list[int]":
    """实际接了线的段号（升序）。"""
    return sorted(collect_slots(inputs))


def _human_list(indexes: "list[int]") -> str:
    return "、".join(f"第 {i} 段" for i in indexes)


def select_group(inputs: Mapping[str, Any], current_index: Any) -> "tuple[int, Any]":
    """挑出当前要跑的那一段，返回 ``(段号, 分组)``。

    取不到一律**抛 ValueError 并说清怎么办** —— 这是"环环相扣"的节点，
    静默回退（比如"挑不到就挑第一段"）会让成片莫名其妙地变成别的内容。
    """
    slots = collect_slots(inputs)
    if not slots:
        raise ValueError(
            "资产卡任务台：一个分段都没接。把每个「资产卡镜头打包」的 group 输出"
            f"接到本节点的 {slot_name(1)} / {slot_name(2)} … 上"
            "（接满最后一个空口会自动多出一个空口，段数不限）。"
        )

    indexes = sorted(slots)
    try:
        index = int(current_index)
    except (TypeError, ValueError):
        index = 0

    if index not in slots:
        raise ValueError(
            f"资产卡任务台：第 {index} 段（{slot_name(index)}）没有接「资产卡镜头打包」。"
            f"当前接了：{_human_list(indexes)}。"
            "（面板会按实际接线自动排段号；「运行段」控件也要落在这几个段号里。）"
        )
    return index, slots[index]


def tag_label(injected: Any, current_index: Any) -> str:
    """导演台 ``tag`` 输出口的最终文本。

    优先用**前端调度器按段塞进 prompt 快照**的那个标签（形如 ``段2_二采``）：
    调度器每提交一段都会按该段的二采开关算好它，所以标签随段自动变。
    没有注入时（比如用 ComfyUI 原生「队列」按钮跑整图）退回 ``段k_二采``。

    这样导演台**不需要任何新输入口**：未声明的键靠节点的 ``accept_all_inputs``
    原样送进 ``execute(**kwargs)``，画布上一个口都不多。
    """
    text = str(injected or "").strip()
    if text:
        return text
    return tag_text(current_index)


def tag_text(index: Any, run_refine: Any = True) -> str:
    """没拿到前端注入的标签时的兜底：``段k_一采`` / ``段k_二采``。"""
    try:
        k = int(index)
    except (TypeError, ValueError):
        k = 0
    label = "二采" if _is_refine(run_refine) else "一采"
    return f"段{k}_{label}"


def _is_refine(value: Any) -> bool:
    """把二采开关的各种写法归一成布尔（面板里存 0/1、"true"/"false"、bool 都有）。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        text = value.strip().lower()
        if text in ("", "0", "false", "off", "no"):
            return False
        if text in ("1", "true", "on", "yes"):
            return True
        return bool(text)
    return bool(value)
