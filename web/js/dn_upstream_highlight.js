import { app } from "../../../scripts/app.js";
import { addForegroundPainter, drawVirtualDot, PAINTER_TOP, VIRTUAL_DOT_INACTIVE } from "./dn_overlay.js";
import { getLinkBadges } from "./dn_prompt_rich.js";

/*
 * DN 节点「选中即高亮关联」—— 双向。
 *
 * 【方向 A：选中「资产卡镜头打包」→ 高亮上游】
 * 把它这一段视频真正吃进去的 **上游连线 + 上游节点（资产卡）**高亮出来，
 * 方便核对"到底用了哪几张卡"。
 *
 * 【方向 B：选中「资产卡（H3MediaLoader）」→ 高亮下游】（2026-09-30 加）
 * 反过来点亮这张卡连到的每个「资产卡镜头打包」+ 两者之间的连线，
 * 方便核对"这张卡被哪些段用到了"。与方向 A 是同一套几何，只有两处刻意不同：
 *   · 颜色用 **H3_MEDIA 连线本身的颜色**（与 dn_media_multilink.js 画虚拟连线
 *     取的是同一个来源：LGraphCanvas.link_type_colors.H3_MEDIA，缺失时 fallback
 *     #34d399），这样一眼能看出"现在是哪个方向在看"，不会和方向 A 的琥珀金混淆；
 *   · **不画连线中点的序号圆点**：圆点是"组视角"的信息（这条线在本组排第几），
 *     且 dn_media_multilink 只在**组被选中**时才给它挂可点把手 —— 这里画了却点不动，
 *     反而像坏了（见 skill §5.12.1"看得见不等于点得到"）。
 *
 * 设计要点（都是刻意为之）：
 * 1. **只画、不改图对象**：绝不动 node.color / bgcolor / link.color ——
 *    那些字段会被序列化进工作流，改完没还原就会污染保存。
 * 2. **虚拟连线也算连线**：H3_OpenNodes 的 medias 单端口多连线是存在
 *    properties 里的虚拟连接（见 dn_media_multilink.js），不跟随它就会
 *    "只亮一个节点、线却是断的"。只要被点亮的节点自己有虚拟连线，就继续跟随。
 * 3. **真实连线只走一层**：否则会顺着 prompt 一路点亮到模型加载器 / LoRA / VAE，
 *    灯光乱成一片。要更远把 HOP_LIMIT 调大即可。
 * 4. 方向 A 用琥珀金（#f5b942），方向 B 用 H3_MEDIA 连线色（#34d399），
 *    两者都不与节点选中白框撞色。
 * 5. 只在"选中的节点里有 DN 组 / 资产卡"时才有开销；其余时候首行就返回。
 */

const NODE_CLASS = "DNMediaToDirectorGroup";
/* 资产卡（前端类名仍是 H3MediaLoader，见 asset_card.js 顶部说明） */
const CARD_CLASS = "H3MediaLoader";

/* 媒体输入名：真实连线的入口只认这些 */
const MEDIA_INPUT_RE = /^media_[1-9]$/;

/* 各家前端扩展存虚拟连线的属性名（值形如 [{source_id, source_slot, order}, …]） */
const VIRTUAL_LINK_KEYS = [
    "dn_media_to_group_links",   // 本包 dn_media_multilink.js
    "h3_media_to_prompt_links",  // ComfyUI-H3-OpenNodes / H3MediaPrompt
    "h3_media_to_video_links",   // ComfyUI-H3-OpenNodes / H3MediaToVideo
];

/* 真实连线跟随的层数（1 = 只直接上游） */
const HOP_LIMIT = 1;

const COLOR = "#f5b942";
const COLOR_SOFT = "rgba(245, 185, 66, 0.28)";
const RING_PAD = 4;

/* 方向 B（选中资产卡）用的连线色：H3_MEDIA 连线本身是什么色就用什么色。
   LGraphCanvas.link_type_colors 里自定义类型常常是 null（本机实测 H3_MEDIA 就没登记），
   缺了就会画成透明 → 必须有 fallback，且与 dn_media_multilink.js 的 fallback 保持一致。 */
const MEDIA_LINK_FALLBACK = "#34d399";
const SOFT_ALPHA = 0.28;

/** 取 H3_MEDIA 连线颜色（惰性读：并行 import 期间 LGraphCanvas 可能还没挂上）。 */
function mediaLinkColor() {
    const value = globalThis.LGraphCanvas?.link_type_colors?.H3_MEDIA;
    return typeof value === "string" && value ? value : MEDIA_LINK_FALLBACK;
}

/** 把 #rrggbb 转成同色的半透明 rgba()；认不出的写法原样返回（不猜、不改）。 */
function withAlpha(color, alpha) {
    const match = /^#([0-9a-fA-F]{6})$/.exec(String(color || "").trim());
    if (!match) return color;
    const n = parseInt(match[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** 是否是媒体输入名（medias / media_1..9）。 */
function isMediaInputName(name) {
    return name === "medias" || MEDIA_INPUT_RE.test(String(name));
}

/** 当前选中的、满足 predicate 的节点（兼容 selected_nodes 与 selectedItems 两种形态）。 */
function selectedNodesOf(predicate) {
    const canvas = app?.canvas;
    if (!canvas) return [];
    const out = [];
    const seen = new Set();
    const push = (node) => {
        if (!node || seen.has(node.id)) return;
        if (!predicate(node)) return;
        seen.add(node.id);
        out.push(node);
    };
    const map = canvas.selected_nodes;
    if (map && typeof map === "object") {
        if (typeof map.forEach === "function") map.forEach((value) => push(value));
        else Object.values(map).forEach(push);
    }
    const items = canvas.selectedItems;
    if (items && typeof items.forEach === "function") items.forEach(push);
    return out;
}

/** 是否是「资产卡镜头打包」节点。 */
function isGroupNode(node) {
    return node?.comfyClass === NODE_CLASS || node?.type === NODE_CLASS;
}

/** 是否是「资产卡」节点。 */
function isCardNode(node) {
    return node?.comfyClass === CARD_CLASS || node?.type === CARD_CLASS;
}

/** 取当前选中的 DN 组（方向 A 的起点）。 */
function selectedTargets() {
    return selectedNodesOf(isGroupNode);
}

/** 取当前选中的资产卡（方向 B 的起点）。 */
function selectedCards() {
    return selectedNodesOf(isCardNode);
}

/** 从一个 link 对象/id 解析出来源节点与输出槽。 */
function sourceOf(graph, link) {
    if (link == null) return null;
    if (typeof link === "number") link = graph?.links?.get?.(link) || graph?._links?.[link];
    if (!link) return null;
    const id = link.origin_id ?? link.originId;
    const slot = Number(link.origin_slot ?? link.originSlot ?? 0);
    const node = graph?.getNodeById?.(Number(id)) || link.origin_node || link.originNode;
    if (!node) return null;
    return { node, slot: Number.isFinite(slot) ? slot : 0, id: Number(node.id) };
}

/** 读取某个节点上所有已知形态的虚拟连线。 */
function virtualLinksOf(node) {
    const props = node?.properties;
    if (!props) return [];
    const out = [];
    for (const key of VIRTUAL_LINK_KEYS) {
        const list = props[key];
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            const sourceId = Number(item?.source_id);
            if (!Number.isFinite(sourceId)) continue;
            out.push({ source_id: sourceId, source_slot: Number(item?.source_slot) || 0 });
        }
    }
    return out;
}

/** 收集以 targets 为终点的上游连线与上游节点。
 *
 *  ⚠️ `nodes` 的 value 是**节点本身**（不是 `{ node, hop }` 之类的包装对象）——
 *  ringNodes() 是方向 A/B 共用的，两边的 Map 必须同构。hop 只在本函数的
 *  queue 里传递，别塞回 Map（2026-09-30 踩过：把包装对象留在 Map 里，
 *  共用方按裸节点取 `node.pos` → 全部 undefined，描边一环都画不出来）。 */
function collectUpstream(targets) {
    const graph = app?.graph;
    const nodes = new Map();   // id -> 节点本身（裸节点，与 collectDownstream 同构）
    const links = [];          // { fromNode, fromSlot, toNode, virtual }
    const queue = [];
    const visited = new Set();

    for (const target of targets) {
        visited.add(target.id);
        queue.push({ node: target, hop: 0 });
    }

    while (queue.length) {
        const { node, hop } = queue.shift();
        const graphOf = node.graph || graph;

        // ① 真实连线：只认媒体输入，且只跟随 HOP_LIMIT 层
        if (hop < HOP_LIMIT) {
            for (const input of node.inputs || []) {
                if (!input || !isMediaInputName(input.name) || input.link == null) continue;
                const src = sourceOf(graphOf, input.link);
                if (!src || src.id === node.id) continue;
                links.push({ fromNode: src.node, fromSlot: src.slot, toNode: node, virtual: false });
                if (!nodes.has(src.id)) {
                    nodes.set(src.id, src.node);
                    if (!visited.has(src.id)) { visited.add(src.id); queue.push({ node: src.node, hop: hop + 1 }); }
                }
            }
        }

        // ② 虚拟连线：既然画布上把它画成了一条线，就跟着它继续点亮（不设层数上限，靠 visited 防环）
        for (const item of virtualLinksOf(node)) {
            if (item.source_id === node.id) continue;
            const src = graphOf?.getNodeById?.(item.source_id);
            if (!src) continue;
            links.push({ fromNode: src, fromSlot: item.source_slot, toNode: node, virtual: true });
            if (!nodes.has(src.id)) {
                nodes.set(src.id, src);
                if (!visited.has(src.id)) { visited.add(src.id); queue.push({ node: src, hop: hop + 1 }); }
            }
        }
    }
    return { nodes, links };
}

/** 节点输出/输入端口在画布上的坐标（优先用节点自身方法，本机 canvas 上没有）。 */
function outputPos(node, slot) {
    if (!node) return null;
    const direct = node.getOutputPos?.(slot);
    if (Array.isArray(direct)) return direct;
    try {
        const result = [0, 0];
        const legacy = node.getConnectionPos?.(false, slot, result);
        if (Array.isArray(legacy)) return legacy;
    } catch (error) {
        /* 忽略：退回估算 */
    }
    const size = node.size || [200, 100];
    const pos = node.pos || [0, 0];
    return [pos[0] + size[0], pos[1] + 20 + 20 * Number(slot || 0)];
}

function inputPos(node, index) {
    if (!node) return null;
    const direct = node.getInputPos?.(index);
    if (Array.isArray(direct)) return direct;
    try {
        const result = [0, 0];
        const legacy = node.getConnectionPos?.(true, index, result);
        if (Array.isArray(legacy)) return legacy;
    } catch (error) {
        /* 忽略：退回估算 */
    }
    const pos = node.pos || [0, 0];
    return [pos[0], pos[1] + 20 + 20 * Number(index || 0)];
}

/** medias 端口在画布上的坐标（虚拟连线的终点）。 */
function mediaPortPos(node) {
    const inputs = node?.inputs || [];
    let index = inputs.findIndex((input) => input?.name === "medias");
    if (index < 0) index = 0;
    return inputPos(node, index);
}

/* ------------------------------------------------------------------
 * 方向 B：选中资产卡 → 下游（DN 组 + 连线）
 * ------------------------------------------------------------------ */

/** 收集以选中的资产卡为起点的下游连线与下游节点（= 用到这张卡的 DN 组）。
 *
 *  与 collectUpstream 对称：一个从组往下找卡，一个从卡往上找组。
 *  两种连法都要认：
 *    ① **虚拟连线** —— 本包 dn_media_multilink.js 把 medias 端口的多条连线存在
 *       **DN 组自己**的 properties.dn_media_to_group_links 里（`{source_id, source_slot}`），
 *       所以必须遍历所有 DN 组去看"哪几条记录的 source_id 是这张卡"。
 *       ⚠️ 反查方向注意：记录挂在**组**上，不是挂在卡上，别指望从卡上能读到。
 *    ② **真实连线** —— 老工作流还没被收编（懒收编，见 dn_media_multilink.js 顶部）时，
 *       端口上就是一条真的原生连线，此时卡在组的 media_N / medias 输入口上。 */
function collectDownstream(cards) {
    const graph = app?.graph;
    const nodes = new Map();   // id -> 组节点
    const links = [];          // { fromNode(卡), fromSlot, toNode(组), virtual }
    if (!graph?._nodes || !cards.length) return { nodes, links };

    const cardIds = new Set(cards.map((card) => Number(card.id)));
    const seen = new Set();

    for (const group of graph._nodes) {
        if (!isGroupNode(group)) continue;

        // ① 虚拟连线
        for (const item of virtualLinksOf(group)) {
            if (!cardIds.has(Number(item.source_id))) continue;
            const key = `v:${item.source_id}:${item.source_slot}:${group.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const card = graph.getNodeById?.(Number(item.source_id));
            if (!card) continue;
            links.push({ fromNode: card, fromSlot: item.source_slot, toNode: group, virtual: true });
            nodes.set(group.id, group);
        }

        // ② 真实连线
        for (const input of group.inputs || []) {
            if (!input || !isMediaInputName(input.name) || input.link == null) continue;
            const src = sourceOf(group.graph || graph, input.link);
            if (!src || !cardIds.has(Number(src.id))) continue;
            const key = `n:${src.id}:${src.slot}:${group.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            links.push({ fromNode: src.node, fromSlot: src.slot, toNode: group, virtual: false });
            nodes.set(group.id, group);
        }
    }
    return { nodes, links };
}

/** 画一条高亮连线（在原有连线之上叠一层，不改原 line 对象）。
 *  `off` = 这张卡「资产名不在提示词里、不会被收进分组」→ 高亮也压灰，别再给它镀金。
 *  `style` = { color, soft }，缺省是方向 A 的琥珀金；方向 B 传 H3_MEDIA 连线色。 */
function strokeLink(ctx, from, to, off, style) {
    if (!from || !to) return;
    const color = style?.color || COLOR;
    const soft = style?.soft || withAlpha(color, SOFT_ALPHA);
    if (off) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(from[0], from[1]);
        ctx.bezierCurveTo(from[0] + 80, from[1], to[0] - 80, to[1], to[0], to[1]);
        ctx.globalAlpha = 0.8;
        ctx.setLineDash([7, 6]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#77817d";
        ctx.stroke();
        ctx.restore();
        return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.bezierCurveTo(from[0] + 80, from[1], to[0] - 80, to[1], to[0], to[1]);
    ctx.lineWidth = 8;
    ctx.strokeStyle = soft;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.bezierCurveTo(from[0] + 80, from[1], to[0] - 80, to[1], to[0], to[1]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.restore();
}

/** 按「目标组节点」缓存编号/过滤判定，一轮绘制里同一节点只算一次。 */
function badgesFor(cache, node) {
    const key = node?.id ?? "x";
    if (!cache.has(key)) cache.set(key, getLinkBadges(node));
    return cache.get(key);
}

/** 高亮连线层（画在节点下方，与已有连线同层）。只画线 —— 中点的序号圆点
 *  由 drawVirtualDots() 单独一层、且画在**最上层**（高亮之后再画）。 */
function drawLinkHighlight(ctx) {
    const targets = selectedTargets();
    if (!targets.length) return;
    const { links } = collectUpstream(targets);
    if (!links.length) return;
    const cache = new Map();
    for (const item of links) {
        const from = outputPos(item.fromNode, item.fromSlot);
        const to = item.virtual ? mediaPortPos(item.toNode) : inputPos(item.toNode, mediaInputIndex(item.toNode));
        const off = Boolean(badgesFor(cache, item.toNode).get(Number(item.fromNode?.id))?.off);
        strokeLink(ctx, from, to, off);
    }
}

/** 虚拟连线中点的序号圆点：**单独一层、最高优先级**。
 *
 *  为什么要拆出来：高亮线画的是 8px 半透明外发光 + 3px 实线，会糊掉压在同一位置的圆点；
 *  而两个扩展是并行加载的，绘制顺序本来不确定（谁文件小谁先执行），
 *  靠登记顺序碰运气不靠谱 → 用覆盖层的 PAINTER_TOP 把「点在金线之上」钉死。
 *  几何/配色统一走 dn_overlay 的共享绘制件，和 dn_media_multilink 画出来的一模一样。 */
function drawVirtualDots(ctx) {
    const targets = selectedTargets();
    if (!targets.length) return;
    const { links } = collectUpstream(targets);
    if (!links.length) return;
    const seen = new Map();
    const cache = new Map();
    for (const item of links) {
        if (!item.virtual) continue;
        const key = item.toNode?.id;
        const order = (seen.get(key) || 0) + 1;
        seen.set(key, order);
        const from = outputPos(item.fromNode, item.fromSlot);
        const to = mediaPortPos(item.toNode);
        if (!from || !to) continue;
        const badge = badgesFor(cache, item.toNode).get(Number(item.fromNode?.id));
        const off = Boolean(badge?.off);
        // 数字 = 后端实际会给的编号（被丢的卡不吃号、不画数字），不再用连线序号
        const label = badge ? badge.label : String(order);
        drawVirtualDot(ctx, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, label, off ? VIRTUAL_DOT_INACTIVE : undefined);
    }
}

function mediaInputIndex(node) {
    const inputs = node?.inputs || [];
    const index = inputs.findIndex((input) => input && isMediaInputName(input.name));
    return index < 0 ? 0 : index;
}

/** 节点视觉框的**顶边在 `pos.y` 之上**：这版前端把标题栏画在 `pos.y - NODE_TITLE_HEIGHT` 那一段
 *  （`pos.y` 是「节点体」的顶边，标题栏占其上方 30px；分隔线正好落在 `pos.y` 上）。
 *
 *  实测依据（别改成 pos[1] 直接减 pad）：沿节点中轴逐像素扫描主画布 ——
 *    dy = -30..-1 → (51,51,51) 标题栏色块（整整 30px）；dy = 0 → (42,42,42) 分隔线；dy ≥ 1 → (53,53,53) 节点体。
 *  不补这一段，金色描边就会「包不住顶上那块标题」（用户报的现象）。
 *  常量在并行 import 期间可能还没挂上，所以**每次都惰性读**，并留一个 30 的兜底。 */
function titleHeight() {
    const v = Number(globalThis.LiteGraph?.NODE_TITLE_HEIGHT);
    return Number.isFinite(v) && v > 0 ? v : 30;
}

/** 给一批节点描一圈（画在节点之上，所以边框不会被节点本身盖住）。
 *  `style` = { color, soft }；被判定 off（不会真的生效）的节点统一压灰、去外发光。 */
function ringNodes(ctx, nodeMap, offIds, style) {
    if (!nodeMap.size) return;
    const color = style?.color || COLOR;
    const soft = style?.soft || withAlpha(color, SOFT_ALPHA);
    const scale = app?.canvas?.ds?.scale || 1;
    const lineWidth = 2.5 / scale;
    const th = titleHeight();
    ctx.save();
    for (const item of nodeMap.values()) {
        // 值可能是裸节点，也可能是 `{ node, … }` 包装（历史收集器差异）——都拆开吃。
        // 不拆的话 node.pos 是 undefined，会被下面的 continue **静默**吃掉、一环都不画（2026-09-30 的教训）。
        const node = item?.node?.pos ? item.node : item;
        const pos = node?.pos;
        const size = node?.size;
        if (!pos || !size) continue;
        // 收起（collapsed）时只画标题那一条，不套用原来的 size[1]（会拖出一条空框）
        const bodyH = node?.flags?.collapsed ? 0 : size[1];
        const x = pos[0] - RING_PAD;
        const y = pos[1] - th - RING_PAD;
        const w = size[0] + RING_PAD * 2;
        const h = bodyH + th + RING_PAD * 2;
        const off = offIds.has(Number(node.id));
        ctx.beginPath();
        const r = 8 / scale;
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
        ctx.lineWidth = lineWidth + 2 / scale;
        ctx.strokeStyle = off ? "rgba(119,129,125,0.25)" : soft;
        ctx.shadowColor = off ? "#77817d" : color;
        ctx.shadowBlur = off ? 0 : 14;
        ctx.stroke();
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = off ? "#77817d" : color;
        ctx.stroke();
    }
    ctx.restore();
}

/** 方向 A 的描边层（选中的 DN 组 → 它的上游资产卡）。
 *  「资产名不在提示词里」的卡：圈也压灰（无外发光），不再镀金 —— 金光 = 后端真的会用它。 */
function drawNodeRings(ctx) {
    const targets = selectedTargets();
    if (!targets.length) return;
    const { nodes, links } = collectUpstream(targets);
    if (!nodes.size) return;
    const offIds = new Set();
    const cache = new Map();
    for (const item of links) {
        const id = Number(item.fromNode?.id);
        if (badgesFor(cache, item.toNode).get(id)?.off) offIds.add(id);
    }
    ringNodes(ctx, nodes, offIds);
}

/* ------------------------------------------------------------------
 * 方向 B 的绘制：连线用 H3_MEDIA 连线色，节点用同色描边
 * ------------------------------------------------------------------ */

/** 下游连线层：从资产卡的输出口画到每个用到它的 DN 组的 medias 口。 */
function drawDownstreamLinks(ctx) {
    const cards = selectedCards();
    if (!cards.length) return;
    const { links } = collectDownstream(cards);
    if (!links.length) return;
    const style = { color: mediaLinkColor(), soft: withAlpha(mediaLinkColor(), SOFT_ALPHA) };
    const cache = new Map();
    for (const item of links) {
        const from = outputPos(item.fromNode, item.fromSlot);
        const to = item.virtual ? mediaPortPos(item.toNode) : inputPos(item.toNode, mediaInputIndex(item.toNode));
        const off = Boolean(badgesFor(cache, item.toNode).get(Number(item.fromNode?.id))?.off);
        strokeLink(ctx, from, to, off, style);
    }
}

/** 下游描边层：把「用到这张卡的 DN 组」圈出来。
 *  判定压灰的口径与连线一致 —— 同一张卡在同一组里被过滤，线和圈一起变灰。 */
function drawDownstreamRings(ctx) {
    const cards = selectedCards();
    if (!cards.length) return;
    const { nodes, links } = collectDownstream(cards);
    if (!nodes.size) return;
    const offIds = new Set();
    const cache = new Map();
    for (const item of links) {
        if (badgesFor(cache, item.toNode).get(Number(item.fromNode?.id))?.off) offIds.add(Number(item.toNode?.id));
    }
    ringNodes(ctx, nodes, offIds, { color: mediaLinkColor(), soft: withAlpha(mediaLinkColor(), SOFT_ALPHA) });
}

/** 覆盖画布绘制：连线层 + 前景层（节点描边）。两个方向各画一套。 */
function patchCanvas() {
    const canvas = app.canvas;
    if (!canvas || canvas.__DnUpstreamHighlightPatched) return;
    canvas.__DnUpstreamHighlightPatched = true;

    if (typeof canvas.drawConnections === "function") {
        const originalDraw = canvas.drawConnections;
        canvas.drawConnections = function (ctx) {
            const result = originalDraw.apply(this, arguments);
            const target = ctx || this.bgctx || this.ctx;
            try {
                drawLinkHighlight(target);
                drawDownstreamLinks(target);
            } catch (error) {
                console.warn("[DN highlight] link layer failed:", error);
            }
            return result;
        };
    }

    if (typeof canvas.onDrawForeground === "function") {
        const originalForeground = canvas.onDrawForeground;
        canvas.onDrawForeground = function (ctx) {
            const result = originalForeground.apply(this, arguments);
            const target = ctx || this.bgctx || this.ctx;
            try {
                drawNodeRings(target);
                drawDownstreamRings(target);
            } catch (error) {
                console.warn("[DN highlight] node layer failed:", error);
            }
            return result;
        };
    }
    // 方向 A：选中 DN 组 → 上游资产卡（琥珀金）
    addForegroundPainter("dn.highlight.links", (ctx) => {
        drawLinkHighlight(ctx);
    });
    // 方向 B：选中资产卡 → 下游 DN 组（H3_MEDIA 连线色）
    addForegroundPainter("dn.highlight.down.links", (ctx) => {
        drawDownstreamLinks(ctx);
    });
    // 序号圆点：最高优先级 —— 必须画在金色高亮之上（详见 drawVirtualDots 的说明）
    addForegroundPainter("dn.highlight.dots", (ctx) => {
        drawVirtualDots(ctx);
    }, PAINTER_TOP);
    addForegroundPainter("dn.highlight.rings", (ctx) => {
        drawNodeRings(ctx);
    });
}

/* 注册必须「等 app 就绪」再调：ComfyUI 会**并行** import 所有扩展脚本，
   文件越小越先执行，那时 window.app 可能还没赋值 —— 顶层直接 `app.registerExtension(...)`
   会 ReferenceError，而且会被 ComfyUI 静默吞掉（界面上完全看不出来，像没装一样）。
   详见 skill `comfyui-custom-node-authoring` §5.11。 */
const extension = {
    name: "DN.UpstreamHighlight",
    setup() {
        if (extension.__setupDone) return;   // 幂等：注册晚于 app.setup 时会自己补调一次
        extension.__setupDone = true;
        const install = (attempt = 0) => {
            patchCanvas();
            if (attempt < 8 && !app.canvas?.__DnUpstreamHighlightPatched) {
                setTimeout(() => install(attempt + 1), 250);
            }
        };
        install();
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
            console.warn("[DN upstream highlight] 注册失败:", error);
            return;
        }
        const kick = () => {
            try { extension.setup(); } catch (error) { console.warn("[DN upstream highlight] 初始化失败:", error); }
        };
        setTimeout(kick, 0);
        setTimeout(kick, 1200);
    };

    if (globalThis.app?.registerExtension) { doRegister(globalThis.app); return; }
    try {
        // 显式依赖 core 的 app：ESM 保证 core 已求值完，天然没有竞态
        import("../../scripts/app.js").then((mod) => doRegister(mod?.app ?? globalThis.app)).catch(() => {});
    } catch (error) { /* 落到下面的轮询 */ }
    let tries = 0;
    const timer = setInterval(() => {
        if (registered) { clearInterval(timer); return; }
        doRegister(globalThis.app);
        tries += 1;
        if (registered || tries > 600) clearInterval(timer);
    }, 16);
}

registerWhenAppReady();
