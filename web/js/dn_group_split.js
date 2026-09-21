/**
 * 资产卡Group拆分（DNGroupSplit）前端 —— 输出口按「上游分组的素材数」重建
 * ---------------------------------------------------------------------------
 * 后端把这个节点的输出口声明成 9 图 + 3 视频 + 3 音频 + prompt 共 16 个（素材口类型是通配 "*"）。
 * 本扩展负责把「声明」变成「实际口数」：
 *   1. `beforeRegisterNodeDef` 时把素材口**从节点定义里剔掉** ——
 *      否则节点一拖出来就是 16 个空口，而实际只有 2 图 1 音。
 *   2. 按三个数量控件重建 `node.outputs`（顺序：图片 → 视频 → 音频），
 *      并把 `prompt` 口**固定在最后**（它不参与增删，连线不会掉）。
 *      没接上游时数量收敛成 0 —— 只有一个 prompt 口，不摆没有素材可拆的图片/音频口。
 *      已经**连出线**的口任何情况下都不删（删口会连带断掉用户下游的分支）。
 *   3. 上游是「资产卡 to Director Group」时，用 dn_prompt_rich 里**与后端同一条过滤规则**
 *      数出实际会进模型的图片 / 音频数量，自动写进数量控件。
 *
 * 自动更新靠什么触发（三条路，任意一条先到就先算）：
 *   - 本节点自己的 `onConnectionsChange`（往它身上接线）
 *   - **画布 pointerup**（拖完一条线松手；上游那侧的连线变化不会通知本节点，靠这个兜）
 *   - 600ms 的轻扫描（上游换卡 / 改资产名 / 改提示词这类"不碰本节点"的变化）
 *   再加上一条明路：节点上的「**按上游刷新**」按钮 + 标题栏右侧的状态字。
 *
 * 状态字（标题栏右侧，随手就能看见）只写"上游现在给几个素材"：
 *   `3图 1音` = 自动探测；`固定 9+3+3`；`0 素材` = 上游此刻给不出素材；
 *   `⚠ 未识别上游` = 探测失灵，需要你手动定数量。
 *   （**没接上游时什么都不写** —— 那是"还没开始"，不是故障，别把正常状态说成故障。）
 * 探测失败**不静默**：点刷新按钮会把来龙去脉打到控制台（上游是哪个节点、卡在哪一步）。
 * 界面保持安静：状态字只有短的一截，**按钮上不背状态** —— 曾经把整串状态拼在按钮上，
 * 一长串糊在节点下边，比状态本身还显眼。
 *
 * 为什么数量一定要走「控件」而不是前端自己存一份：
 *   数量控件是**前后端唯一的契约** —— 前端按它建口、后端按它切片。
 *   只要两边不一致，`[origin_id, slot]` 就会指到别的数据上（静默错位，不报错）。
 *   所以「固定 9+3+3」开关的做法是：把三个数量锁成 9/3/3，前端按 9/3/3 建口，
 *   后端按 9/3/3 切片、素材不够的口发 `ExecutionBlocker` → 挂在上面的分支被静默剪掉。
 *   这样下游只接一次线，上游素材增减都不用再动。
 *
 * 出处与授权：
 *   - 「按数量重建输出口」的机制参考 ComfyUI-MiniMaxH3-Easy 的 Media Splitter
 *     （MIT，作者 nkxx188）—— 同一套做法（剔定义 → 按数量重建 → 重排后修 origin_slot），
 *     本文件为独立实现，未复制其代码；
 *   - 上游卡片解析复用本包 dn_prompt_rich.js 的 flattenCards / cardInfo（同一条编号与过滤规则）。
 *   完整出处与授权见仓库根目录 THIRD_PARTY_NOTICES.md。
 */

import { app } from "../../../scripts/app.js";
import { resolveMediaCounts } from "./dn_prompt_rich.js";

const NODE_CLASS = "DNGroupSplit";
const GROUP_INPUT = "group";
const FIX_WIDGET = "fix_max";

const COUNT_GROUPS = Object.freeze([
    { type: "image", widget: "image_count", max: 9, label: "图片" },
    { type: "video", widget: "video_count", max: 3, label: "视频" },
    { type: "audio", widget: "audio_count", max: 3, label: "音频" },
]);

// 视频口给 IMAGE：分组里的 ref_videos 存的就是帧张量，官方 ref_video_N 收的也是 IMAGE。
const OUTPUT_TYPES = Object.freeze({ image: "IMAGE", video: "IMAGE", audio: "AUDIO" });

/** 本扩展负责增删的口（其余一律不动，且永远排在最后）。 */
const MANAGED_OUTPUT_RE = /^(?:image|video|audio)_\d+$/;
/** 上游「导演台 Group」这类打包节点的 ref_* 输入（用已连线条数当数量）。 */
const PACKED_INPUT_RE = /^(?:ref_)?(image|video|audio)_\d+$/;
/** 上游「Groups Combine」这类分组拼接节点的输入名：`groups` / `group_0` / `groups.group_0`。 */
const GROUP_INPUT_RE = /^(?:groups|group_\d+|groups\.group_\d+)$/;

/** 手动刷新按钮（不参与序列化，只是给"自动更新没跟上"留一条明路）。 */
const REFRESH_WIDGET = "dn_refresh_upstream";
const REFRESH_LABEL = "按上游刷新";

const FIXED_COUNTS = Object.freeze({ image: 9, video: 3, audio: 3 });
const SCAN_INTERVAL_MS = 600;

/* ================================================================
 * 1. 小工具
 * ================================================================ */

function getWidget(node, name) {
    return (node?.widgets || []).find((w) => w && w.name === name) || null;
}

function clampCount(value, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(max, Math.floor(number)));
}

function setWidgetValue(node, name, value) {
    const widget = getWidget(node, name);
    if (!widget) return false;
    if (Number(widget.value) === Number(value)) return false;
    widget.value = value;
    return true;
}

function isFixMax(node) {
    const value = getWidget(node, FIX_WIDGET)?.value;
    if (typeof value === "boolean") return value;
    return ["true", "1", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

/** 强刷 Vue 那层的控件显示（直接改 widget.value 不一定重绘）。
 *
 *  这里**故意用原地 splice 而不是 `node.widgets = [...]` 重新赋值**：
 *  重新赋值若在第二次写入时抛异常（有些前端把 widgets 包成只读 / 只写一次），
 *  控件数组就会被留在空状态 —— 那是不可恢复的 UI 事故。splice 改的是同一个数组，
 *  内容不变、只会触发一次响应式，最坏情况也只是没重绘。 */
function refreshVueWidgets(node) {
    const widgets = node?.widgets;
    if (!Array.isArray(widgets) || !widgets.length) return;
    try {
        widgets.splice(0, widgets.length, ...widgets);
    } catch (error) {
        /* 忽略：没重绘也不影响功能 */
    }
}

function nodeClassName(node) {
    return String(node?.comfyClass || node?.type || "");
}

/* ================================================================
 * 2. 上游探测：这个分组里到底有多少图 / 视频 / 音频
 * ================================================================ */

function inputOf(node, name) {
    return (node?.inputs || []).find((item) => item && item.name === name) || null;
}

/** 从某个输入端口顺着连线找到上游节点（拿不到返回 null）。 */
function sourceNodeOf(node, input) {
    const graph = node?.graph || app.graph;
    if (!graph || !input || input.link == null) return null;
    let link = input.link;
    if (typeof link === "number" || typeof link === "string") {
        link = graph.links?.get?.(link) ?? graph.links?.[link] ?? graph._links?.[link];
    }
    if (!link) return null;
    const id = Number(link.origin_id ?? link.originId);
    if (!Number.isFinite(id)) return null;
    return graph.getNodeById?.(id) || null;
}

function upstreamNode(node) {
    return sourceNodeOf(node, inputOf(node, GROUP_INPUT));
}

/** 上游是「官方 ref_image_N / ref_audio_N」这类**逐口接线**的节点时，数已连线的口。 */
function countPackedInputs(node) {
    const counts = { image: 0, video: 0, audio: 0 };
    let seen = false;
    for (const input of node?.inputs || []) {
        const match = PACKED_INPUT_RE.exec(String(input?.name || ""));
        if (!match) continue;
        seen = true;
        if (input.link != null) counts[match[1]] += 1;
    }
    return seen ? counts : null;
}

/** 上游是「Groups Combine」这类把多个分组拼成一串的节点时，
 *  取**第一个**已连线的分组（后端 `as_group` 也只认第一个字典，口径一致）。 */
function firstGroupSource(node) {
    for (const input of node?.inputs || []) {
        const name = String(input?.name || "");
        if (!GROUP_INPUT_RE.test(name)) continue;
        const source = sourceNodeOf(node, input);
        if (source) return source;
    }
    return null;
}

function sourceLabel(node) {
    if (!node) return "（空）";
    return `${nodeClassName(node) || "?"}#${node.id ?? "?"}`;
}

/** 上游是否"带提示词控件的分组节点"（`资产卡 to Director Group` 这类）。
 *  用来判「它一张卡都没接 → 它现在产出的分组就是空的」。 */
function hasPromptWidget(node) {
    return Boolean(getWidget(node, "prompt"));
}

/** **已经连出线的素材口**：任何"按上游收敛"的操作都不许把它删掉。
 *
 *  为什么：口数跟着上游走的代价是"上游一变少，多出来的口就被删"，
 *  而口被删会连带把用户连在它上面的下游分支一起断掉。
 *  用户改提示词、临时清空上游这类日常动作不该毁掉已经连好的线，
 *  所以这里把"已连线的最靠后序号"作为该类型至少要保留的口数。
 */
function linkedPortCounts(node) {
    const counts = { image: 0, video: 0, audio: 0 };
    for (const output of node?.outputs || []) {
        const match = /^(image|video|audio)_(\d+)$/.exec(String(output?.name || ""));
        if (!match) continue;
        const links = Array.isArray(output.links)
            ? output.links
            : output?.link == null
              ? []
              : [output.link];
        if (!links.length) continue;
        counts[match[1]] = Math.max(counts[match[1]], Number(match[2]) || 0);
    }
    return counts;
}

/** 把"上游给的数量"与"已连线的口"合起来：取大者 —— 已连线的口一定要在。 */
function mergeKeepLinked(counts, keep) {
    const merged = {};
    let bumped = false;
    for (const group of COUNT_GROUPS) {
        const wanted = Number(counts?.[group.type]) || 0;
        const kept = Number(keep?.[group.type]) || 0;
        merged[group.type] = Math.max(wanted, kept);
        if (merged[group.type] > wanted) bumped = true;
    }
    return { counts: merged, bumped };
}

/** 认不出上游时，顺着一串「只有一个连线输入」的中转节点（Reroute 之类）往上再找几张卡。
 *  只在中转节点**恰好只有一个输入**时才敢走 —— 输入多的节点说明它自己做了别的事，
 *  再往上猜就是瞎猜了。最多走 3 层。 */
function walkThrough(source, depth = 3) {
    let cur = source;
    const seen = new Set();
    for (let step = 0; step < depth; step += 1) {
        if (!cur || seen.has(cur.id)) return null;
        seen.add(cur.id);
        const linked = (cur.inputs || []).filter((item) => item && item.link != null);
        if (linked.length !== 1) return null;
        const next = sourceNodeOf(cur, linked[0]);
        if (!next) return null;
        const media = resolveMediaCounts(next);
        if (media?.known) return { node: next, media };
        cur = next;
    }
    return null;
}

/**
 * 探清上游的素材数量。
 *
 * **永远返回一个对象**（不再用裸 `null` 表示"探测不到"）——
 * 之前每种不满足都 `return null`，而调用方把 null 当成"别动控件"，
 * 结果「关掉固定不恢复」「上游加卡不更新」两个症状都找不到原因、也看不见。
 * 现在失败会带回 `reason`，由节点上的状态文字 / 刷新按钮 / 控制台显形。
 *
 * 返回 `{ counts: {image,video,audio} | null, mode, filtered, reason, source }`：
 *   mode = "cards"   上游直接就是吃资产卡的节点（最常见）
 *   mode = "combine" 上游是分组拼接节点 —— **只算第一个分组**（与后端口径一致）
 *   mode = "packed"  上游是官方逐口接线节点，按已连线的 ref_* 口数
 *   mode = "empty"   上游是空的（带提示词控件却一张卡都没接）→ 数量就是 0
 *   mode = "idle"    **group 口还没接线** —— 这不是失败，是"还没开始"：界面上不吭声
 *                    （以前这里算 none，于是刚拖出来的节点就顶着"⚠ 未识别上游 ·
 *                     group 输入没接线"，把正常状态说成了故障）
 *   mode = "none"    接了线但认不出上游，reason 说明卡在哪一步 → 亮 ⚠，这才该提醒
 */
function probeUpstream(node) {
    const source = upstreamNode(node);
    if (!source) {
        return { counts: null, mode: "idle", reason: "no-source", source: null };
    }
    const label = sourceLabel(source);

    // ① 卡片路径：只要上游能"展平出卡片"就按卡片数算。
    //    刻意**不**再用类名判断（`DNMediaToDirectorGroup` 一旦改名 / 被别的节点包一层，
    //    类名判断会静默失效，而"能不能展平出卡片"才是这件事的真实信号）。
    const media = resolveMediaCounts(source);
    if (media?.known) {
        return {
            counts: { image: media.image, video: media.video || 0, audio: media.audio },
            mode: "cards",
            filtered: Boolean(media.filtered),
            source: label,
        };
    }

    // ② 分组拼接节点（Groups Combine）
    const group = firstGroupSource(source);
    if (group) {
        const inner = resolveMediaCounts(group);
        if (inner?.known) {
            return {
                counts: { image: inner.image, video: inner.video || 0, audio: inner.audio },
                mode: "combine",
                filtered: Boolean(inner.filtered),
                source: sourceLabel(group),
            };
        }
    }

    // ③ 官方逐口接线节点
    const packed = countPackedInputs(source);
    if (packed) {
        return { counts: packed, mode: "packed", filtered: true, source: label };
    }

    // ④ 中间隔了中转节点（Reroute 之类）：穿过去再试
    const through = walkThrough(source);
    if (through) {
        return {
            counts: {
                image: through.media.image,
                video: through.media.video || 0,
                audio: through.media.audio,
            },
            mode: "passthrough",
            filtered: Boolean(through.media.filtered),
            source: sourceLabel(through.node),
        };
    }

    // ⑤ 空分组：上游是"带提示词控件的分组节点"却一张卡都没接 ——
    //    它此刻产出的分组就是空的，数量**就是 0**（不是"认不出"，别报 ⚠）。
    if (hasPromptWidget(source)) {
        return {
            counts: { image: 0, video: 0, audio: 0 },
            mode: "empty",
            filtered: true,
            source: label,
        };
    }

    return { counts: null, mode: "none", reason: "no-cards", source: label };
}

/* ================================================================
 * 3. 输出口：剔除声明 → 按数量重建 → 把 prompt 固定在最下边
 * ================================================================ */

/** 把素材口从节点定义里删掉（保留 prompt，顺序不变）。 */
function trimNodeDataOutputs(nodeData) {
    if (!nodeData) return;
    const names = Array.isArray(nodeData.output_name) ? nodeData.output_name : null;
    const types = Array.isArray(nodeData.output) ? nodeData.output : null;
    if (names && types) {
        const keep = [];
        names.forEach((name, index) => {
            if (!MANAGED_OUTPUT_RE.test(String(name || ""))) keep.push(index);
        });
        const pick = (array) => (Array.isArray(array) ? keep.map((index) => array[index]) : array);
        nodeData.output = pick(types);
        nodeData.output_name = pick(names);
        if (Array.isArray(nodeData.output_is_list)) nodeData.output_is_list = pick(nodeData.output_is_list);
        if (Array.isArray(nodeData.output_tooltips)) nodeData.output_tooltips = pick(nodeData.output_tooltips);
        return;
    }
    // 旧前端把输出放在 nodeData.outputs 里
    if (Array.isArray(nodeData.outputs)) {
        nodeData.outputs = nodeData.outputs.filter(
            (output) => !MANAGED_OUTPUT_RE.test(String(output?.name || ""))
        );
    }
}

function desiredOutputNames(counts) {
    const names = [];
    for (const group of COUNT_GROUPS) {
        for (let index = 1; index <= counts[group.type]; index += 1) {
            names.push(`${group.type}_${index}`);
        }
    }
    return names;
}

function outputLabel(name) {
    const match = /^(image|video|audio)_(\d+)$/.exec(String(name || ""));
    if (!match) return String(name || "");
    const group = COUNT_GROUPS.find((item) => item.type === match[1]);
    return `${group?.label || match[1]} ${match[2]}`;
}

function outputType(name) {
    const match = /^(image|video|audio)_(\d+)$/.exec(String(name || ""));
    return match ? OUTPUT_TYPES[match[1]] || "*" : "*";
}

function removeOutputAt(node, index) {
    const output = node?.outputs?.[index];
    const graph = node?.graph || app.graph;
    const links = Array.isArray(output?.links)
        ? [...output.links]
        : output?.link == null
          ? []
          : [output.link];
    if (typeof node.removeOutput === "function") {
        node.removeOutput(index);
        return;
    }
    if (graph?.removeLink) for (const linkId of links) graph.removeLink(linkId);
    node.outputs?.splice(index, 1);
}

/** 口的顺序变了 → 把挂在口上的连线的 origin_slot 跟着改，连线就不会「跳槽」。 */
function updateLinkTargets(node) {
    const graph = node?.graph || app.graph;
    if (!graph || !Array.isArray(node?.outputs)) return;
    node.outputs.forEach((output, index) => {
        const links = Array.isArray(output?.links)
            ? output.links
            : output?.link == null
              ? []
              : [output.link];
        for (const linkId of links) {
            const link = graph.links?.get?.(linkId) ?? graph.links?.[linkId];
            if (!link) continue;
            link.origin_slot = index;
            if ("originSlot" in link) link.originSlot = index;
            if ("from_slot" in link) link.from_slot = index;
            if ("fromSlot" in link) link.fromSlot = index;
        }
    });
}

function syncOutputs(node, counts) {
    const wanted = desiredOutputNames(counts);
    const wantedSet = new Set(wanted);
    const order = new Map(wanted.map((name, index) => [name, index]));

    // ---- ① 先删：多余的素材口、重复口、无名口、重复的非素材口 ----
    //
    //  "重复口"必须在这里处理，而不是只靠后面重建数组 —— 实测（真实前端）：
    //  `configure()` 恢复工作流时是**追加**语义（原有的口不清空），
    //  于是存盘数据里带一份定义口、现场又留一份，口就会越堆越多；
    //  素材口之间有 wantedSet/seen 去重，**非素材口（prompt）却没有**，
    //  结果 prompt 口被复制成两个（其中一个还挂着别的口的标签）→ 就是"输出口乱掉"的现场。
    const drop = [];
    const seenManaged = new Set();
    const seenOther = new Set();
    (node.outputs || []).forEach((output, index) => {
        const name = String(output?.name || "");
        if (!name) {
            drop.push(index);                       // 无名口：老数据可能留下，清掉
            return;
        }
        if (MANAGED_OUTPUT_RE.test(name)) {
            if (!wantedSet.has(name) || seenManaged.has(name)) drop.push(index);
            else seenManaged.add(name);
            return;
        }
        if (seenOther.has(name)) drop.push(index);  // 非素材口同名只留第一个
        else seenOther.add(name);
    });
    for (const index of drop.reverse()) removeOutputAt(node, index);
    let changed = drop.length > 0;

    // ---- ② 再补缺 ----
    for (const name of wanted) {
        if ((node.outputs || []).some((output) => output?.name === name)) continue;
        if (typeof node.addOutput === "function") node.addOutput(name, outputType(name));
        else {
            node.outputs ||= [];
            node.outputs.push({ name, type: outputType(name), links: null });
        }
        changed = true;
    }

    // ---- ③ 摆顺序：素材口按 图 → 视频 → 音频，prompt 永远排最后 ----
    const managed = [];
    const rest = [];
    for (const output of node.outputs || []) {
        const name = String(output?.name || "");
        if (!MANAGED_OUTPUT_RE.test(name)) {
            rest.push(output); // prompt 口：不动、永远排最后
            continue;
        }
        if (!wantedSet.has(name)) continue;
        output.type = outputType(name);
        const label = outputLabel(name);
        output.label = label;
        output.localized_name = label;
        managed.push(output);
    }
    managed.sort((a, b) => order.get(a.name) - order.get(b.name));
    const sorted = [...managed, ...rest];
    const reordered =
        sorted.length !== (node.outputs || []).length ||
        sorted.some((output, index) => output !== node.outputs[index]);
    if (changed || reordered) {
        node.outputs ||= [];
        node.outputs.splice(0, node.outputs.length, ...sorted);
        updateLinkTargets(node);
    }

    // ---- ④ 收敛自检：万一没写进去（有些前端把 outputs 包成只读视图），至少留下证据 ----
    const actual = (node.outputs || []).map((output) => String(output?.name || ""));
    const expected = [...wanted, ...rest.map((output) => String(output?.name || ""))];
    if (actual.join("|") !== expected.join("|")) {
        console.warn("[DN group split] 输出口没能收敛（可能是前端把 outputs 包成了只读视图）:", {
            actual, expected,
        });
    }
    return changed;
}

/** 口数变了就把节点高度收到内容大小（避免留下 16 个口的空盒子）。
 *  折叠状态下不动 —— 那时 computeSize 给的不是展开后的高度，硬套会把节点改坏。 */
function resizeToContent(node) {
    if (node?.flags?.collapsed) return;
    if (typeof node.computeSize !== "function" || typeof node.setSize !== "function") return;
    const measured = node.computeSize();
    if (!Array.isArray(measured) || !Number.isFinite(Number(measured[1]))) return;
    const width = Math.max(240, Number(node.size?.[0]) || 0, Number(measured[0]) || 0);
    const height = Number(node.size?.[1]) || 0;
    const target = Math.max(1, Math.ceil(Number(measured[1])));
    if (Math.abs(height - target) > 1) node.setSize([width, target]);
}

/* ================================================================
 * 4. 刷新：数量控件 ↔ 输出口
 * ================================================================ */

function readCounts(node) {
    const counts = {};
    for (const group of COUNT_GROUPS) {
        counts[group.type] = clampCount(getWidget(node, group.widget)?.value, group.max);
    }
    return counts;
}

function countsKey(counts) {
    return COUNT_GROUPS.map((group) => counts[group.type]).join(":");
}

/** 三个数量控件是不是都在（缺控件时 readCounts 会当 0 处理，不能拿它当布局依据）。 */
function hasCountWidgets(node) {
    return COUNT_GROUPS.every((group) => Boolean(getWidget(node, group.widget)));
}

function applyCounts(node, counts) {
    for (const group of COUNT_GROUPS) setWidgetValue(node, group.widget, counts[group.type]);
}

function statusCountsText(counts) {
    const parts = [];
    if (counts?.image) parts.push(`${counts.image}图`);
    if (counts?.video) parts.push(`${counts.video}视频`);
    if (counts?.audio) parts.push(`${counts.audio}音`);
    return parts.join(" ") || "0 素材";
}

const MODE_TAG = {
    combine: "（首个分组）",
    packed: "（按已连线口）",
    passthrough: "（隔了中转节点）",
    empty: "（空分组）",
    manual: "（手动）",
};
/** "no-source" 只出现在**手动刷新时的控制台日志**里 —— 没接线是正常状态，
 *  界面上走 idle，一个字都不显示（see probeUpstream / statusShort）。 */
const REASON_TEXT = { "no-source": "group 输入没接线", "no-cards": "上游不是资产卡节点" };

/** 画在节点标题栏里的短状态（空间小，只留最要紧的）。
 *  idle（还没接线）返回空串 → drawStatus 直接不画：刚拖出来的节点干干净净。
 *
 *  只在**两种**情况下带 ⚠（其余一律只报数量，别把正常状态说成故障）：
 *   · 认不出上游（mode=none）—— 自动更新真的失灵了，要用户手动定数量；
 *   · counts 与显示不一致（stale / filtered=false）—— 口数不是上游的原话。
 *  详细的"这个数是怎么来的"只写进控制台（点刷新按钮时），不占界面。 */
function statusShort(status) {
    if (!status || status.mode === "idle") return "";
    if (status.mode === "none") return "⚠ 未识别上游";
    if (status.mode === "fix") return "固定 9+3+3";
    const mark = status.stale || status.filtered === false ? " ⚠" : "";
    return statusCountsText(status.counts) + mark;
}

/** 把状态讲清楚 —— **只给控制台用**（曾经把它拼到刷新按钮上，
 *  结果一长串糊在节点下边，比状态本身还显眼，已改掉）。 */
function statusLong(status) {
    if (!status) return "";
    if (status.mode === "idle") return "还没接线（本次不输出任何素材口）";
    if (status.mode === "manual") return statusCountsText(status.counts) + "（手动指定）";
    if (status.mode === "none") {
        const why = REASON_TEXT[status?.reason] || status?.reason || "";
        return why ? `未识别上游 · ${why}` : "未识别上游";
    }
    if (status.mode === "fix") return "固定 9+3+3";
    let text = statusCountsText(status.counts) + (MODE_TAG[status.mode] || "");
    if (status.filtered === false) text += " · 提示词读不到，按全部卡片算";
    if (status.stale) text += " · 已连线的口保留（上游当前给不出这么多）";
    return text;
}

/** 把探测结果显形：节点标题栏一行短字。**按钮只写「按上游刷新」**，不带任何状态尾巴。 */
function updateStatus(node, status) {
    node.__dnSplitStatus = status;
    node.__dnSplitStatusText = statusShort(status);
    const button = node.__dnSplitButton;
    if (button && button.label !== REFRESH_LABEL) {
        button.label = REFRESH_LABEL;
        node.setDirtyCanvas?.(true, true);
    }
}

/** 用户点了刷新按钮：结果写进控制台。
 *  界面上的状态字只说"结果"，**来龙去脉全写在这里**（按钮不再背那一长串）。
 *  "没接线"在界面上不吭声（idle），但点了按钮就是问了，所以这里照样说清。 */
function reportManual(node, status, probed) {
    const detail = {
        状态: statusLong(status) || "（无）",
        上游: probed?.source ?? sourceLabel(upstreamNode(node)),
        读写: status?.counts,
    };
    if (status?.mode === "none") {
        console.warn("[DN group split] 手动刷新：认不出上游，数量由你在控件里指定。", {
            ...detail,
            卡在哪一步: REASON_TEXT[status.reason] || status.reason,
            认得出的上游: "「资产卡 to Director Group」的输出、官方 ref_* 逐口节点、"
                + "Groups Combine（只算第一个分组）、以及穿过单输入中转节点后的卡片节点。",
        });
        return;
    }
    console.info("[DN group split] 手动刷新：", detail);
}

/**
 * 一次完整的刷新：**上游说几就是几**，口跟着控件走。
 *   ① 固定模式 → 把三个数量锁成 9/3/3（无条件，保证前后端一致）；
 *   ② 没接线（idle）→ 数量收敛成 0（只剩 prompt 口）——
 *      "什么都没连却摆着图片/音频口"是错的：没上游就没有素材可拆；
 *      但**已经连出去的口留着**（keep），不能因为上游没了就把用户下游的线断掉；
 *   ③ 自动模式 → 按上游报的数量写控件（含 0：提示词空着时后端一张卡都不会打包）；
 *   ④ 认不出上游 → **一个控件都不碰**，只在标题栏亮 ⚠ 让用户自己定。
 *
 *  options.resync === false —— **不许用上游的数覆盖控件**（只重建输出口）。
 *      手动改数量的回调走这条：用户刚把「图片数量」从 2 改成 5，若这里再探测一次
 *      并按上游的 2 写回去，手改会被立刻抹掉（而且是在同一次事件里，看上去像"改不动"）。
 *  options.force —— 即使布局没变也强制重绘（切换开关、刚接上线时用）。
 *  options.manual —— 用户点了刷新按钮：结果（含失败原因）写进控制台。
 *
 *  `node.__dnSplitApplied` 存的是**上游上次报告的数量指纹**（不是"我们写下去的值"）。
 *  拿它跟"这次探测到的"比，而不是跟"控件当前值"比 —— 这样用户手改过的值在
 *  上游不动的时候不会被 600ms 的扫描反复打回，上游真变了又一定能跟上。
 */
function refresh(node, options = {}) {
    if (!node || node.__dnSplitBusy) return false;
    node.__dnSplitBusy = true;
    try {
        let status = null;
        let probed = null;
        const keep = linkedPortCounts(node);   // 已经连出线的口：任何收敛都不许删

        if (isFixMax(node)) {
            applyCounts(node, FIXED_COUNTS);
            node.__dnSplitApplied = "fix";
            node.__dnSplitManual = false;
            status = { mode: "fix", counts: { ...FIXED_COUNTS } };
        } else if (options.resync !== false) {
            probed = probeUpstream(node);
            if (probed.mode === "idle") {
                // 还没接线：不输出任何素材口（已连线保留下来的除外；手改过的值以用户为准）
                if (node.__dnSplitManual) {
                    status = { mode: "manual", counts: readCounts(node) };
                } else {
                    applyCounts(node, keep);
                    node.__dnSplitApplied = "idle";
                    status = { mode: "idle", counts: { ...keep } };
                }
            } else if (probed.counts) {
                const merged = mergeKeepLinked(probed.counts, keep);
                const key = countsKey(probed.counts);
                const upstreamChanged = node.__dnSplitApplied !== key;
                if (upstreamChanged) {
                    node.__dnSplitApplied = key;
                    node.__dnSplitManual = false;
                }
                // 写控件的两种场合：上游真变了（自动跟上），或"有口因为连线被保留"（保证口与控件一致）
                if (upstreamChanged || (!node.__dnSplitManual && merged.bumped)) {
                    applyCounts(node, merged.counts);
                }
                status = node.__dnSplitManual
                    ? { mode: "manual", counts: readCounts(node) }
                    : { ...probed, counts: merged.counts, stale: merged.bumped };
            }
        }

        if (!status) {
            // 走到这里只有三种情况（没上游读数的不可能到这 —— idle 在上面处理了）：
            //   · 认不出上游（none）→ 标题栏亮 ⚠，控件保持原样，让用户自己定；
            //   · 刚被手改过（manual）→ 口按控件值走；
            //   · resync:false 的初始化 → 同样按控件值走。
            const unrecognized = Boolean(probed && !probed.counts && probed.mode !== "idle");
            status = {
                mode: unrecognized ? "none" : (node.__dnSplitManual ? "manual" : "idle"),
                counts: readCounts(node),
                reason: probed?.reason,
                filtered: probed?.filtered,
            };
        }

        const counts = readCounts(node);
        const layoutChanged = syncOutputs(node, counts);
        const changed = layoutChanged || Boolean(options.force);
        // 只有**口真的增删了**才收高度：单纯重绘不该把用户手动拉过的高度改掉
        if (layoutChanged) resizeToContent(node);
        if (changed) {
            refreshVueWidgets(node);
            node.setDirtyCanvas?.(true, true);
            app.graph?.setDirtyCanvas?.(true, true);
        }
        updateStatus(node, status);
        if (options.manual) reportManual(node, status, probed);
        return changed;
    } catch (error) {
        console.warn("[DN group split] 刷新失败:", error);
        return false;
    } finally {
        node.__dnSplitBusy = false;
    }
}

/** 「按上游刷新」按钮：自动更新没跟上时的明路（自动探测已经覆盖绝大多数情况，
 *  按钮的作用是"我说了算" + 把探测结果/失败原因显形）。
 *
 *  用 `serialize:false`，不写进工作流；即使宿主不认这个选项，它也是**最后一个**控件，
 *  多出来的一个 null 只会占 `widgets_values` 的末尾，不会错位到别的控件上。 */
function ensureRefreshButton(node) {
    if (node.__dnSplitButton) return node.__dnSplitButton;
    if (typeof node.addWidget !== "function") return null;
    let button = null;
    try {
        button = node.addWidget("button", REFRESH_WIDGET, null, () => {
            // 点一下 = 无条件重新对账：忘掉"手改过"和"上次读数"，重新探一次上游
            node.__dnSplitManual = false;
            node.__dnSplitApplied = null;
            refresh(node, { resync: true, force: true, manual: true });
        }, { serialize: false });
    } catch (error) {
        console.warn("[DN group split] 刷新按钮创建失败（自动更新不受影响）:", error);
        return null;
    }
    if (!button) return null;
    button.serialize = false;
    if (button.options) button.options.serialize = false;
    button.label = REFRESH_LABEL;
    node.__dnSplitButton = button;
    // 加了一个控件 → 高度要重新量一次（LiteGraph 不会因为 addWidget 自动长高）
    resizeToContent(node);
    return button;
}

function setup(node) {
    if (!node || node.__dnSplitSetup) return;
    node.__dnSplitSetup = true;

    for (const group of COUNT_GROUPS) {
        const widget = getWidget(node, group.widget);
        if (!widget) continue;
        const original = widget.callback;
        widget.callback = function onCountChanged(value) {
            original?.apply(this, arguments);
            const clamped = clampCount(value, group.max);
            if (Number(widget.value) !== clamped) widget.value = clamped;
            // 手改数量 = 用户显式下令：这是本次的布局依据。
            // resync:false —— 别在这一刻拿上游的数把手改写回去（否则用户看着像"改不动"）；
            // 自动模式要等上游的数量真变了才会再覆盖它。
            node.__dnSplitManual = true;
            refresh(node, { resync: false, force: true });
        };
    }

    const fixWidget = getWidget(node, FIX_WIDGET);
    if (fixWidget) {
        const original = fixWidget.callback;
        fixWidget.callback = function onFixMaxChanged(value) {
            original?.apply(this, arguments);
            const turningOn = typeof value === "boolean" ? value : isFixMax(node);
            if (turningOn) {
                // 顺手记住"打开固定之前"的数量 —— 关掉时要能一字不差地恢复原样
                if (!node.__dnSplitBeforeFix) node.__dnSplitBeforeFix = readCounts(node);
            } else {
                const snapshot = node.__dnSplitBeforeFix;
                node.__dnSplitBeforeFix = null;
                node.__dnSplitManual = false;
                if (snapshot) {
                    applyCounts(node, snapshot);
                    // 把快照登记成"上次读数"：上游的数若与它相同就不重复写，
                    // 不同则下面这次 refresh 会用上游的真值覆盖（自动跟上）。
                    node.__dnSplitApplied = countsKey(snapshot);
                } else {
                    node.__dnSplitApplied = null;
                }
            }
            refresh(node, { force: true });
        };
    }

    ensureRefreshButton(node);
    refresh(node, { force: true });
}

/* ================================================================
 * 5. 安装
 * ================================================================ */

/** 在节点标题栏右侧画一行短状态 —— 让人一眼看出当前口数是哪来的
 *  （自动探测 / 固定 9+3+3 / 手动 / 认不出上游）。标题栏在节点坐标系的**负 y** 区。 */
function drawStatus(node, ctx) {
    const text = node?.__dnSplitStatusText;
    if (!text || !ctx || typeof ctx.fillText !== "function") return;
    const width = Number(node.size?.[0]) || 0;
    if (width < 120) return;
    const warn = String(text).includes("⚠");
    ctx.save();
    ctx.font = "12px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = warn ? "rgba(255,186,80,.95)" : "rgba(196,196,196,.9)";
    const maxWidth = width - 24;
    let shown = String(text);
    if (ctx.measureText(shown).width > maxWidth) {
        while (shown.length > 1 && ctx.measureText(`${shown}…`).width > maxWidth) {
            shown = shown.slice(0, -1);
        }
        shown += "…";
    }
    ctx.fillText(shown, width - 8, -15, maxWidth);
    ctx.restore();
}

function installNode(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;
    trimNodeDataOutputs(nodeData);
    if (nodeType?.nodeData && nodeType.nodeData !== nodeData) trimNodeDataOutputs(nodeType.nodeData);
    if (nodeType.prototype.__dnGroupSplitInstalled) return;
    nodeType.prototype.__dnGroupSplitInstalled = true;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function onNodeCreatedDnGroupSplit() {
        const result = originalCreated?.apply(this, arguments);
        setup(this);
        return result;
    };

    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function onConfigureDnGroupSplit(info) {
        const result = originalConfigure?.apply(this, arguments);
        // ① 先认账：工作流里存下来的数量控件值就是"当时的布局依据"，
        //    把它当成"上游上次报告的指纹"登记好 —— 否则 setup() 里的刷新会立刻
        //    拿现场探测到的数把它压掉（用户存在盘上的配置一打开就变形）。
        // ② 再 setup + 按控件值重建输出口（resync:false：不拿上游覆盖）。
        //    上游之后真变了，scan / onConnectionsChange 会自己跟上。
        if (hasCountWidgets(this)) {
            this.__dnSplitApplied = countsKey(readCounts(this));
        }
        setup(this);
        refresh(this, { resync: false, force: true });
        return result;
    };

    const originalConnections = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function onConnectionsChangeDnGroupSplit() {
        const result = originalConnections?.apply(this, arguments);
        refresh(this, { force: true });
        return result;
    };

    const originalDraw = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function onDrawForegroundDnGroupSplit(ctx) {
        const result = originalDraw?.apply(this, arguments);
        try {
            drawStatus(this, ctx);
        } catch (error) {
            /* 画不出状态不该影响节点渲染 */
        }
        return result;
    };
}

/** 上游改了（换卡 / 改资产名 / 改提示词 / 加删连线）也得跟着变 —— 用 600ms 的轻扫描兜住。
 *
 *  稳态下每次扫描只做「遍历节点 → 探测上游数量 → 与上次指纹比」：
 *  指纹没变就一个控件都不碰、输出口也不动（syncOutputs 返回 false → 不重绘不收高度），
 *  所以除了探测本身没有额外开销；页面切到后台时整个跳过。 */
function scan() {
    if (typeof document !== "undefined" && document.hidden) return;
    for (const node of app.graph?._nodes || []) {
        if (!node || nodeClassName(node) !== NODE_CLASS) continue;
        // 口被外部清空过（例如从旧工作流恢复）时强制重建一次
        const known = Array.isArray(node.outputs) && node.outputs.length > 0;
        refresh(node, known ? undefined : { force: true });
    }
}

/** 拖完一条连线松手 → 上游多半变了：立刻对一次账，不必等下一次轮询
 *  （上游那侧的连线变化不会触发本节点的 onConnectionsChange，所以需要这个）。
 *  只在画布上监听捕获阶段的 pointerup，每次就多跑一次探测，很便宜。 */
function bindPointerTrigger() {
    if (extension.__pointerBound) return;
    const el = app.canvas?.canvas || app.canvasEl || null;
    if (!el || typeof el.addEventListener !== "function") return;
    extension.__pointerBound = true;
    el.addEventListener("pointerup", () => scan(), true);
}

const extension = {
    name: "DN.Nodes.GroupSplit",
    beforeRegisterNodeDef(nodeType, nodeData) {
        installNode(nodeType, nodeData);
    },
    setup() {
        if (extension.__setupDone) return;
        extension.__setupDone = true;
        // 页面已加载完的工作流（本扩展注册晚于 app.setup 时）也要补一次
        setTimeout(() => scan(), 0);
        setTimeout(() => scan(), 800);
        setInterval(scan, SCAN_INTERVAL_MS);
        // 画布可能还没建好，两次机会
        setTimeout(bindPointerTrigger, 0);
        setTimeout(bindPointerTrigger, 1500);
    },
};

function registerWhenAppReady() {
    let registered = false;
    const doRegister = (api) => {
        if (registered || !api || typeof api.registerExtension !== "function") return;
        registered = true;
        try {
            api.registerExtension(extension);
        } catch (error) {
            registered = false;
            console.warn("[DN group split] 注册失败:", error);
            return;
        }
        const kick = () => {
            try {
                extension.setup();
            } catch (error) {
                console.warn("[DN group split] 初始化失败:", error);
            }
        };
        setTimeout(kick, 0);
        setTimeout(kick, 1200);
    };

    if (globalThis.app?.registerExtension) {
        doRegister(globalThis.app);
        return;
    }
    try {
        // 显式依赖 core 的 app：ESM 保证 core 已求值完，天然没有竞态
        import("../../scripts/app.js")
            .then((mod) => doRegister(mod?.app ?? globalThis.app))
            .catch(() => {});
    } catch (error) {
        /* 落到下面的轮询 */
    }
    let tries = 0;
    const timer = setInterval(() => {
        if (registered) {
            clearInterval(timer);
            return;
        }
        doRegister(globalThis.app);
        tries += 1;
        if (registered || tries > 600) clearInterval(timer);
    }, 16);
}

registerWhenAppReady();
