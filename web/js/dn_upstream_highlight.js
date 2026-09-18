import { app } from "../../../scripts/app.js";
import { addForegroundPainter, drawVirtualDot, PAINTER_TOP } from "./dn_overlay.js";

/*
 * DN 节点「选中即高亮上游」。
 *
 * 选中「资产卡 to Director Group」时，把它这一段视频真正吃进去的
 * **上游连线 + 上游节点**高亮出来，方便核对"到底用了哪几张卡"。
 *
 * 设计要点（都是刻意为之）：
 * 1. **只画、不改图对象**：绝不动 node.color / bgcolor / link.color ——
 *    那些字段会被序列化进工作流，改完没还原就会污染保存。
 * 2. **虚拟连线也算连线**：H3_OpenNodes 的 medias 单端口多连线是存在
 *    properties 里的虚拟连接（见 dn_media_multilink.js），不跟随它就会
 *    "只亮一个节点、线却是断的"。只要被点亮的节点自己有虚拟连线，就继续跟随。
 * 3. **真实连线只走一层**：否则会顺着 prompt 一路点亮到模型加载器 / LoRA / VAE，
 *    灯光乱成一片。要更远把 HOP_LIMIT 调大即可。
 * 4. 颜色用琥珀金（#f5b942），和节点选中白框、H3_MEDIA 的绿色线都不撞。
 * 5. 只在"选中了 DN 节点"时才有开销；其余时候首行就返回。
 */

const NODE_CLASS = "DNMediaToDirectorGroup";

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

/** 是否是媒体输入名（medias / media_1..9）。 */
function isMediaInputName(name) {
    return name === "medias" || MEDIA_INPUT_RE.test(String(name));
}

/** 取当前选中的 DN 节点（兼容 selected_nodes 与 selectedItems 两种形态）。 */
function selectedTargets() {
    const canvas = app?.canvas;
    if (!canvas) return [];
    const out = [];
    const seen = new Set();
    const push = (node) => {
        if (!node || seen.has(node.id)) return;
        if (node.comfyClass !== NODE_CLASS && node.type !== NODE_CLASS) return;
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

/** 收集以 targets 为终点的上游连线与上游节点。 */
function collectUpstream(targets) {
    const graph = app?.graph;
    const nodes = new Map();   // id -> { node, hop }
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
                    nodes.set(src.id, { node: src.node, hop: hop + 1 });
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
                nodes.set(src.id, { node: src, hop: hop + 1 });
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

/** 画一条高亮连线（在原有连线之上叠一层，不改原 line 对象）。 */
function strokeLink(ctx, from, to) {
    if (!from || !to) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.bezierCurveTo(from[0] + 80, from[1], to[0] - 80, to[1], to[0], to[1]);
    ctx.lineWidth = 8;
    ctx.strokeStyle = COLOR_SOFT;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.bezierCurveTo(from[0] + 80, from[1], to[0] - 80, to[1], to[0], to[1]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLOR;
    ctx.shadowColor = COLOR;
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.restore();
}

/** 高亮连线层（画在节点下方，与已有连线同层）。只画线 —— 中点的序号圆点
 *  由 drawVirtualDots() 单独一层、且画在**最上层**（高亮之后再画）。 */
function drawLinkHighlight(ctx) {
    const targets = selectedTargets();
    if (!targets.length) return;
    const { links } = collectUpstream(targets);
    if (!links.length) return;
    for (const item of links) {
        const from = outputPos(item.fromNode, item.fromSlot);
        const to = item.virtual ? mediaPortPos(item.toNode) : inputPos(item.toNode, mediaInputIndex(item.toNode));
        strokeLink(ctx, from, to);
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
    for (const item of links) {
        if (!item.virtual) continue;
        const key = item.toNode?.id;
        const order = (seen.get(key) || 0) + 1;
        seen.set(key, order);
        const from = outputPos(item.fromNode, item.fromSlot);
        const to = mediaPortPos(item.toNode);
        if (!from || !to) continue;
        drawVirtualDot(ctx, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, order);
    }
}

function mediaInputIndex(node) {
    const inputs = node?.inputs || [];
    const index = inputs.findIndex((input) => input && isMediaInputName(input.name));
    return index < 0 ? 0 : index;
}

/** 高亮节点描边层（画在节点之上，所以边框不会被节点本身盖住）。 */
function drawNodeRings(ctx) {
    const targets = selectedTargets();
    if (!targets.length) return;
    const { nodes } = collectUpstream(targets);
    if (!nodes.size) return;
    const scale = app?.canvas?.ds?.scale || 1;
    const lineWidth = 2.5 / scale;
    ctx.save();
    for (const { node } of nodes.values()) {
        const pos = node?.pos;
        const size = node?.size;
        if (!pos || !size) continue;
        const x = pos[0] - RING_PAD;
        const y = pos[1] - RING_PAD;
        const w = size[0] + RING_PAD * 2;
        const h = size[1] + RING_PAD * 2;
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
        ctx.strokeStyle = COLOR_SOFT;
        ctx.shadowColor = COLOR;
        ctx.shadowBlur = 14;
        ctx.stroke();
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = COLOR;
        ctx.stroke();
    }
    ctx.restore();
}

/** 覆盖画布绘制：连线层 + 前景层（节点描边）。 */
function patchCanvas() {
    const canvas = app.canvas;
    if (!canvas || canvas.__DnUpstreamHighlightPatched) return;
    canvas.__DnUpstreamHighlightPatched = true;

    if (typeof canvas.drawConnections === "function") {
        const originalDraw = canvas.drawConnections;
        canvas.drawConnections = function (ctx) {
            const result = originalDraw.apply(this, arguments);
            try {
                drawLinkHighlight(ctx || this.bgctx || this.ctx);
            } catch (error) {
                console.warn("[DN upstream highlight] link layer failed:", error);
            }
            return result;
        };
    }

    if (typeof canvas.onDrawForeground === "function") {
        const originalForeground = canvas.onDrawForeground;
        canvas.onDrawForeground = function (ctx) {
            const result = originalForeground.apply(this, arguments);
            try {
                drawNodeRings(ctx || this.bgctx || this.ctx);
            } catch (error) {
                console.warn("[DN upstream highlight] node layer failed:", error);
            }
            return result;
        };
    }
    addForegroundPainter("dn.highlight.links", (ctx) => {
        drawLinkHighlight(ctx);
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
