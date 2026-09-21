import { app } from "../../../scripts/app.js";
import { addForegroundPainter, addHandleProvider, drawVirtualDot, PAINTER_TOP, VIRTUAL_DOT_INACTIVE, VIRTUAL_DOT_NO_AUDIO } from "./dn_overlay.js";
import { refreshPromptMedia, getLinkBadges, planCardSwap, applyCardSwap, isNoneName } from "./dn_prompt_rich.js";

/*
 * 资产卡 to Director Group —— medias 单端口多连线。
 *
 * 前端一个输入插槽只存一条 link（NodeInputSlot.link 是单值），第二条线会顶掉第一条。
 * 所以「一个端口接多张卡」必须自己做：虚拟连线存在节点属性里，执行时注入隐藏输入 media_1..9。
 * 机制与上游 ComfyUI-H3-OpenNodes 的 web/js/MediaPrompt.js 同源
 * （MIT，Copyright (c) 2026 sunnyboxs；该仓库已被作者删除），但补了一个坑：
 *
 *   上游会在加载时就把原生连线收编，并且无条件删掉 prompt 里的 medias；
 *   本扩展改成「懒收编」——
 *     - 端口上只有一条原生连线时：**原样不动**（连 API 调用都能照旧跑，不依赖本扩展）；
 *     - 你往这个端口再拖第二条线时：先把你原本那条（可能刚被前端顶掉）收编成第 1 条，
 *       新线排第 2 条，一条都不丢；
 *     - 只有当虚拟列表非空时，才把 medias 改写成 media_1..N。
 *
 * 段级音频开关（2026-09-21 加）：
 *   右键连线中点圆点 →「本段不带音」。只在本节点的连线记录里写一个 ``skip_audio``，
 *   注入 prompt 时拼成 ``link_audio_mask``（"101"，与 media_1..N 逐位对齐），
 *   由后端 media_group_core.apply_audio_mask 在**过滤之前**把对应卡片的 audio 摘掉。
 *   为什么不在前端"注入时直接把 audio 抹掉"：注入的是 ``[source_id, slot]`` 这种**真链接**，
 *   前端改不了上游输出的内容 —— 只能让后端按掩码自己摘。
 *   为什么要段级：上游卡片的 ``audio_muted`` 是卡级属性，会影响引用它的**所有**段。
 */

const NODE_CLASS = "DNMediaToDirectorGroup";
const MEDIA_INPUT = "medias";
const MAX_MEDIA = 9;
const LINKS_PROPERTY = "dn_media_to_group_links";
/* 段级音频开关的隐藏输入名（后端 nodes.py 的 INPUT_AUDIO_MASK）。
   按**连线顺序**拼成 "101" 这样的串注入：第 i 位对应第 i+1 条连线，'0' = 这条不带音。 */
const AUDIO_MASK_INPUT = "link_audio_mask";
/* 要从前端节点定义里剔掉的隐藏输入：媒体槽 + 音频掩码。
   后端声明它们只为让注入的 prompt 输入名合法，界面上一个字都不该露。 */
const HIDDEN_INPUT_NAMES = new Set([
    ...Array.from({ length: MAX_MEDIA }, (_unused, index) => `media_${index + 1}`),
    AUDIO_MASK_INPUT,
]);

function isHiddenInputName(name) {
    return HIDDEN_INPUT_NAMES.has(String(name || ""));
}

/** 一条连线上「本段不带音」是否打开。 */
function isAudioSkipped(link) {
    return Boolean(link?.skip_audio);
}

/* 中点圆点的可点范围与透明把手的边长：圆点半径见 dn_overlay.js 的 VIRTUAL_DOT.radius（11）。
   两者比圆点本身大一圈，方便点。 */
const DOT_HIT_RADIUS = 20;
const HANDLE_SIZE = 40;

/** 返回该节点的虚拟媒体连接记录（数组即顺序）。 */
function getLinks(node) {
    node.properties ||= {};
    if (!Array.isArray(node.properties[LINKS_PROPERTY])) node.properties[LINKS_PROPERTY] = [];
    return node.properties[LINKS_PROPERTY];
}

/** 获取图中的节点实例。 */
function getNode(graph, id) {
    return graph?.getNodeById?.(Number(id)) || app.graph?.getNodeById?.(Number(id));
}

/** 从原生连接对象读取来源节点与输出槽。 */
function readSource(graph, link) {
    if (!link) return null;
    const sourceId = link.origin_id ?? link.originId ?? link.from_id ?? link.fromId;
    const sourceNode = link.origin_node || link.originNode || link.fromNode || link.sourceNode || getNode(graph, sourceId);
    const sourceSlot = Number(link.origin_slot ?? link.originSlot ?? link.from_slot ?? link.fromSlot ?? 0);
    if (!sourceNode || !Number.isFinite(sourceSlot)) return null;
    return { sourceNode, sourceId: Number(sourceNode.id), sourceSlot, sourceType: link.type || sourceNode.outputs?.[sourceSlot]?.type || "H3_MEDIA" };
}

/** 返回可见 medias 输入及其索引。 */
function getMediaInput(node) {
    const input = node?.inputs?.find((item) => item?.name === MEDIA_INPUT);
    return input ? { input, index: node.inputs.indexOf(input) } : null;
}

/** 返回唯一可见 medias 端口的画布坐标。 */
function getMediaPosition(node) {
    const media = getMediaInput(node);
    if (!media) return null;
    const point = node.getInputPos?.(media.index);
    if (Array.isArray(point)) return point;
    const result = [0, 0];
    try {
        const legacy = node.getConnectionPos?.(true, media.index, result);
        return Array.isArray(legacy) ? legacy : result;
    } catch (error) {
        return [Number(node.pos?.[0] || 0), Number(node.pos?.[1] || 0) + 40 + media.index * 20];
    }
}

/** 清理重复或来源节点已不存在的虚拟连接。 */
function normalizeLinks(node) {
    const graph = node?.graph || app.graph;
    const seen = new Set();
    const valid = getLinks(node).filter((link) => {
        const sourceId = Number(link?.source_id);
        const sourceSlot = Number(link?.source_slot);
        const key = `${sourceId}:${sourceSlot}`;
        if (!Number.isFinite(sourceId) || !Number.isFinite(sourceSlot) || seen.has(key)) return false;
        if (graph?.getNodeById && !getNode(graph, sourceId)) return false;
        seen.add(key);
        return true;
    });
    valid.forEach((link, index) => { link.order = index + 1; });
    node.properties[LINKS_PROPERTY] = valid.slice(0, MAX_MEDIA);
    return node.properties[LINKS_PROPERTY];
}

/** 记住端口上那条原生连线（懒收编用；尚未收编时才需要）。 */
function syncNative(node) {
    if (node.__dnConverted || node.__dnNativeMedias) return;
    const media = getMediaInput(node);
    if (!media?.input || media.input.link == null) return;
    const graph = node.graph || app.graph;
    const link = graph?.links?.get?.(media.input.link) || graph?._links?.[media.input.link];
    const source = readSource(graph, link);
    if (!source || source.sourceNode === node) return;
    node.__dnNativeMedias = {
        source_id: source.sourceId,
        source_slot: source.sourceSlot,
        source_type: source.sourceType,
    };
}

/** 删除前端定义里的隐藏传输输入（media_1..9 与段级音频掩码），避免它们出现在节点上。 */
function trimNodeDefinition(nodeData) {
    const remove = (container) => {
        if (!container || typeof container !== "object") return;
        for (const name of Object.keys(container)) {
            if (isHiddenInputName(name)) delete container[name];
        }
    };
    remove(nodeData?.input?.required);
    remove(nodeData?.input?.optional);
    remove(nodeData?.required);
    remove(nodeData?.optional);
    for (const key of ["required", "optional"]) {
        if (Array.isArray(nodeData?.input_order?.[key])) {
            nodeData.input_order[key] = nodeData.input_order[key].filter((name) => !isHiddenInputName(name));
        }
    }
    if (Array.isArray(nodeData?.inputs)) {
        nodeData.inputs = nodeData.inputs.filter((input) => !isHiddenInputName(input?.name || input?.id || input));
    }
}

/**
 * 把「刚连上来的这条线」转成虚拟连接。
 * 若端口上原本还有一条原生连线（前端把它顶掉了），先把它收编成第 1 条 —— 保证不会静默丢卡。
 */
function convertVisibleConnection(node, linkInfo) {
    const media = getMediaInput(node);
    if (!media) return false;
    const graph = node.graph || app.graph;
    const nativeLink = linkInfo || (media.input.link != null ? graph?.links?.get?.(media.input.link) || graph?._links?.[media.input.link] : null);
    const source = readSource(graph, nativeLink);
    if (!source || source.sourceNode === node) return false;

    const links = normalizeLinks(node);
    const seen = new Set(links.map((item) => `${Number(item.source_id)}:${Number(item.source_slot)}`));
    const pending = [];
    const stash = node.__dnNativeMedias;
    if (stash && !seen.has(`${stash.source_id}:${stash.source_slot}`)) {
        pending.push({ source_id: stash.source_id, source_slot: stash.source_slot, source_type: stash.source_type, order: 0 });
        seen.add(`${stash.source_id}:${stash.source_slot}`);
    }
    const incoming = `${source.sourceId}:${source.sourceSlot}`;
    if (!seen.has(incoming)) {
        pending.push({ source_id: source.sourceId, source_slot: source.sourceSlot, source_type: source.sourceType, order: 0 });
    }

    node.__dnConverted = true;
    node.__dnNativeMedias = null;

    const room = MAX_MEDIA - links.length;
    if (room > 0) {
        links.push(...pending.slice(0, room));
        node.properties[LINKS_PROPERTY] = links;
        normalizeLinks(node);
    }
    node.disconnectInput?.(media.index);
    node.setDirtyCanvas?.(true, true);
    graph?.setDirtyCanvas?.(true, true);
    graph?.change?.();
    return room > 0;
}

/** 获取来源节点输出端口位置。 */
function getOutputPosition(node, slot) {
    const point = node?.getOutputPos?.(slot);
    if (Array.isArray(point)) return point;
    const result = [0, 0];
    try {
        const legacy = node?.getConnectionPos?.(false, slot, result);
        return Array.isArray(legacy) ? legacy : result;
    } catch (error) {
        return [Number(node?.pos?.[0] || 0) + Number(node?.size?.[0] || 160), Number(node?.pos?.[1] || 0) + 40 + slot * 20];
    }
}

/** 节点当前是否被选中（不同版本的存法不一样，三个都试一遍）。 */
function isNodeSelected(canvas, node) {
    if (!canvas || !node) return false;
    if (canvas.selected_nodes?.[node.id]) return true;
    const items = canvas.selectedItems;
    if (items && typeof items.has === "function" && items.has(node)) return true;
    return !!node.flags?.selected;
}

/** 绘制虚拟媒体连线和顺序序号。
 *  `options.selectedOnly` = true 时只画「目标节点处于选中状态」的连线 ——
 *  用于把它们补画到**节点层之上**（否则线中点会被别的节点压住，右键点不到）。
 *  `options.linesOnly` / `options.dotsOnly` 把「线」和「中点圆点」拆成两层画，
 *  圆点单独用高优先级登记到覆盖层最上层（否则会被选中时的高亮外发光糊掉）。 */
function drawVirtualLinks(canvas, ctx, options) {
    const graph = canvas?.graph || app.graph;
    if (!ctx || !graph?._nodes || canvas.links_render_mode === globalThis.LiteGraph?.HIDDEN_LINK) return;
    const selectedOnly = !!options?.selectedOnly;
    const linesOnly = !!options?.linesOnly;
    const dotsOnly = !!options?.dotsOnly;
    for (const target of graph._nodes) {
        if (target?.comfyClass !== NODE_CLASS && target?.type !== NODE_CLASS) continue;
        if (selectedOnly && !isNodeSelected(canvas, target)) continue;
        const targetPoint = getMediaPosition(target);
        if (!targetPoint) continue;
        // 「资产名不在提示词里」的卡：连线压灰 + 虚线，中点圆点压灰且**不画数字**。
        // 圆点数字 = 后端实际会给的编号（过滤后重排），不再用连线序号 —— 两者否则会错位
        // （例：虚线在第 2 位时，后端只编 1、2，连线序号却写着 1、2、3）。
        const badges = getLinkBadges(target);
        for (const [index, item] of normalizeLinks(target).entries()) {
            const sourceNode = getNode(graph, item.source_id);
            const sourcePoint = getOutputPosition(sourceNode, Number(item.source_slot));
            if (!sourceNode || !sourcePoint) continue;
            const badge = badges.get(Number(item.source_id));
            const off = Boolean(badge?.off);
            const midX = (sourcePoint[0] + targetPoint[0]) / 2;
            const midY = (sourcePoint[1] + targetPoint[1]) / 2;
            if (!dotsOnly) {
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(sourcePoint[0], sourcePoint[1]);
                ctx.bezierCurveTo(sourcePoint[0] + 80, sourcePoint[1], targetPoint[0] - 80, targetPoint[1], targetPoint[0], targetPoint[1]);
                ctx.lineWidth = canvas.connections_width || 3;
                if (off) {
                    ctx.setLineDash([7, 6]);
                    ctx.globalAlpha = 0.8;
                    ctx.strokeStyle = "#77817d";
                } else {
                    ctx.strokeStyle = globalThis.LGraphCanvas?.link_type_colors?.H3_MEDIA || "#34d399";
                }
                ctx.stroke();
                ctx.restore();
            }
            if (!linesOnly) {
                const label = badge ? badge.label : String(index + 1);
                // 圆点三态（颜色只在"你该不该注意它"上区分）：
                //   灰   = 后端把这张卡整张丢了（资产名不在提示词里）—— 故障
                //   琥珀 = 图照送、但这条连线的**音本段不送**（卡片静音 or 段级开关）—— 你的选择
                //   绿   = 照常
                // 连线本身只有"被丢"才变灰虚线；关掉的只是音，图还在送，线不该跟着变虚。
                const style = off
                    ? VIRTUAL_DOT_INACTIVE
                    : (badge?.audioOff ? VIRTUAL_DOT_NO_AUDIO : undefined);
                drawVirtualDot(ctx, midX, midY, label, style);
            }
        }
    }
}

/** 将浏览器鼠标事件转换为画布坐标。 */
function getGraphPosition(canvas, event) {
    try {
        canvas.adjustMouseEvent?.(event);
    } catch (error) {
        // 兼容不提供 adjustMouseEvent 的旧版 LiteGraph。
    }
    if (Array.isArray(canvas?.graph_mouse)) return [canvas.graph_mouse[0], canvas.graph_mouse[1]];
    if (Number.isFinite(event?.canvasX) && Number.isFinite(event?.canvasY)) return [event.canvasX, event.canvasY];
    const rect = canvas?.canvas?.getBoundingClientRect?.();
    const scale = canvas?.ds?.scale || 1;
    const offset = canvas?.ds?.offset || [0, 0];
    if (rect && Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
        return [(event.clientX - rect.left) / scale - offset[0], (event.clientY - rect.top) / scale - offset[1]];
    }
    return [0, 0];
}

/** 将画布坐标转换为浏览器客户区坐标。 */
function getClientPosition(canvas, point) {
    const rect = canvas?.canvas?.getBoundingClientRect?.();
    if (!rect) return null;
    const scale = canvas?.ds?.scale || 1;
    const offset = canvas?.ds?.offset || [0, 0];
    return { x: rect.left + (point[0] + offset[0]) * scale, y: rect.top + (point[1] + offset[1]) * scale };
}

/** 选中 DN 节点时，给每条虚拟连线的中点挂一个**透明 DOM 把手**。
 *
 *  为什么光有覆盖层绘制不够：线在覆盖层上是看得见了，但覆盖层 pointer-events:none，
 *  真正吃到点击的是它下面那个节点自绘 UI（真 DOM 元素）→ 点线中点反而选中了节点（用户实测报过）。
 *  把手是 DOM 元素，天然在自绘 UI 之上，点击就是它的；坐标用 toScreen 从画布坐标换算。 */
function virtualLinkHandles(canvas, toScreen) {
    const graph = canvas?.graph || app.graph;
    if (!graph?._nodes) return [];
    const out = [];
    for (const target of graph._nodes) {
        if (target?.comfyClass !== NODE_CLASS && target?.type !== NODE_CLASS) continue;
        if (!isNodeSelected(canvas, target)) continue;
        const targetPoint = getMediaPosition(target);
        if (!targetPoint) continue;
        const badges = getLinkBadges(target);
        normalizeLinks(target).forEach((item, index) => {
            const sourceNode = getNode(graph, item.source_id);
            const sourcePoint = getOutputPosition(sourceNode, Number(item.source_slot));
            if (!sourceNode || !sourcePoint) return;
            const mid = [(sourcePoint[0] + targetPoint[0]) / 2, (sourcePoint[1] + targetPoint[1]) / 2];
            const screen = toScreen(mid);
            const open = (event) => openLinkMenu(canvas, { targetNode: target, index, point: mid }, event);
            // 悬停就要能看出"这条音是关着的"，不用去点菜单确认
            const badge = badges.get(Number(item.source_id));
            const state = badge?.muted ? "卡片已静音" : (badge?.skipAudio ? "本段不带音" : "");
            out.push({
                key: `${target.id}:${index}`,
                x: screen[0],
                y: screen[1],
                size: HANDLE_SIZE,
                title: `第 ${index + 1} 条连线${state ? `｜${state}` : ""}`
                    + "（右键：本段带音 / 不带音、序号提前 / 退后、删除、替换这张卡）",
                onActivate: open,
                onMenu: open,
            });
        });
    }
    return out;
}

/** 查找鼠标位置最近的虚拟连线。 */
function hitTestVirtualLinks(graph, x, y) {
    let best = null;
    for (const targetNode of graph?._nodes || []) {
        if (targetNode?.comfyClass !== NODE_CLASS && targetNode?.type !== NODE_CLASS) continue;
        const targetPoint = getMediaPosition(targetNode);
        if (!targetPoint) continue;
        normalizeLinks(targetNode).forEach((link, index) => {
            const sourceNode = getNode(graph, link.source_id);
            const sourcePoint = getOutputPosition(sourceNode, Number(link.source_slot));
            if (!sourceNode || !sourcePoint) return;
            const mid = [(sourcePoint[0] + targetPoint[0]) / 2, (sourcePoint[1] + targetPoint[1]) / 2];
            const distance = Math.hypot(x - mid[0], y - mid[1]);
            if (distance <= DOT_HIT_RADIUS && (!best || distance < best.distance)) {
                best = { targetNode, index, point: mid, distance };
            }
        });
    }
    return best;
}

/** 删除指定的虚拟媒体连线。 */
function removeVirtualLink(targetNode, index) {
    const links = normalizeLinks(targetNode);
    if (index < 0 || index >= links.length) return false;
    links.splice(index, 1);
    normalizeLinks(targetNode);
    refreshPromptMedia(targetNode);      // 连线变了 → 编辑器的 <Picture N> 编号 / 提示条跟着重算
    targetNode.setDirtyCanvas?.(true, true);
    (targetNode.graph || app.graph)?.setDirtyCanvas?.(true, true);
    (targetNode.graph || app.graph)?.change?.();
    return true;
}

/** 把虚拟连线列表写回 properties 并刷新画布（normalizeLinks 会重排 order）。 */
function writeLinks(node, list) {
    node.properties = node.properties || {};
    node.properties[LINKS_PROPERTY] = Array.isArray(list) ? list.slice(0, MAX_MEDIA) : [];
    normalizeLinks(node);
    refreshPromptMedia(node);            // 连线变了 → 编辑器的 <Picture N> 编号 / 提示条跟着重算
    node.setDirtyCanvas?.(true, true);
    (node.graph || app.graph)?.setDirtyCanvas?.(true, true);
    (node.graph || app.graph)?.change?.();
}

/** 清空该节点上的全部虚拟连线。 */
function clearAllVirtualLinks(node) {
    const links = normalizeLinks(node);
    if (!links.length) return false;
    node.__dnNativeMedias = null;      // 原生连线快照一起作废
    writeLinks(node, []);
    return true;
}

/** 反转连线顺序（顺序 = 提示词里 <Picture N> 的编号）。 */
function reverseVirtualLinks(node) {
    const links = normalizeLinks(node);
    if (links.length < 2) return false;
    writeLinks(node, links.slice().reverse());
    return true;
}

/** 把第 index 条连线前移 / 后移一位（delta = -1 / +1）。 */
function moveVirtualLink(node, index, delta) {
    const links = normalizeLinks(node);
    const to = index + delta;
    if (index < 0 || index >= links.length || to < 0 || to >= links.length) return false;
    const list = links.slice();
    const [moved] = list.splice(index, 1);
    list.splice(to, 0, moved);
    writeLinks(node, list);
    return true;
}

/** 设置第 index 条连线的**音频**开关（段级）。图照旧送，编号也不变。
 *
 *  为什么需要段级：卡片自己的 ``audio_muted`` 是**卡级**属性，一勾静音，引用这张卡的
 *  **所有段**都失去音色参考；而实际需求常常是「A 段要他的音色、B 段不要」。
 *  这里只改**本节点**这条连线记录里的 ``skip_audio`` —— 上游卡片一个字节都不动
 *  （尤其不能去改它，那张卡还被同一段里的别的节点共用着）。
 *  真正的摘音在后端做（media_group_core.apply_audio_mask）。 */
function setLinkAudio(targetNode, index, skip) {
    const links = normalizeLinks(targetNode);
    if (index < 0 || index >= links.length) return false;
    links[index].skip_audio = Boolean(skip);
    writeLinks(targetNode, links);
    return true;
}

/** 翻转第 index 条连线的音频开关。 */
function toggleLinkAudio(targetNode, index) {
    const links = normalizeLinks(targetNode);
    if (index < 0 || index >= links.length) return false;
    return setLinkAudio(targetNode, index, !isAudioSkipped(links[index]));
}

/** 在虚拟连线位置打开删除菜单。 */
function openLinkMenu(canvas, hit, event) {
    const anchor = getClientPosition(canvas, hit.point) || { x: event?.clientX || 0, y: event?.clientY || 0 };
    const menuEvent = typeof PointerEvent === "function"
        ? new PointerEvent("pointerdown", { clientX: anchor.x + 8, clientY: anchor.y + 8, bubbles: true, cancelable: true })
        : new MouseEvent("mousedown", { clientX: anchor.x + 8, clientY: anchor.y + 8, bubbles: true, cancelable: true });
    let menuInstance = null;
    const close = () => {
        menuInstance?.close?.();
        menuInstance?.remove?.();
    };
    const run = (fn) => () => { fn(); close(); };
    if (globalThis.LiteGraph?.ContextMenu) {
        const links = normalizeLinks(hit.targetNode);
        const count = links.length;
        const link = count > hit.index ? links[hit.index] : null;
        const items = [];
        if (count > 1) {
            items.push({ content: "序号提前", callback: run(() => moveVirtualLink(hit.targetNode, hit.index, -1)) });
            items.push({ content: "序号退后", callback: run(() => moveVirtualLink(hit.targetNode, hit.index, +1)) });
            items.push(null);
        }
        // 只有上游这张卡**真的有音**时才给这个开关 —— 没音的卡摆一个"不带音"是噪声。
        if (link && cardHasAudio(hit.targetNode, link)) {
            const skipped = isAudioSkipped(link);
            items.push({
                content: skipped ? "本段带音（恢复）" : "本段不带音",
                callback: run(() => toggleLinkAudio(hit.targetNode, hit.index)),
            });
            items.push(null);
        }
        items.push({ content: "删除这条连线", callback: run(() => removeVirtualLink(hit.targetNode, hit.index)) });
        items.push(null);
        items.push({ content: "替换这张卡…", callback: run(() => openCardPicker(anchor, hit)) });
        menuInstance = new globalThis.LiteGraph.ContextMenu(items, { event: menuEvent });
    }
}

/** 这条连线的上游卡片是不是真的挂了音频文件（没挂就没必要给"不带音"开关）。 */
function cardHasAudio(targetNode, link) {
    const source = getNode(targetNode?.graph || app.graph, link?.source_id);
    const props = source?.properties || {};
    const value = props.pml_audio_filename;
    if (typeof value === "string" && value.trim() && !isNoneName(value)) return true;
    const widget = (source?.widgets || []).find((item) => item && /audio|sound/i.test(item.name || "")
        && !/mute/i.test(item.name || ""));
    const raw = typeof widget?.value === "object" ? widget?.value?.filename : widget?.value;
    return typeof raw === "string" && raw.trim() && !isNoneName(raw);
}

/** 判断当前画布是否正在创建新的媒体连线。 */
function isConnectingMedia(canvas) {
    const node = canvas?.connecting_node || canvas?.connectingNode;
    const input = canvas?.connecting_input || canvas?.connectingInput;
    if (!node || !input) return false;
    const slot = typeof input === "number" ? node.inputs?.[input] : input;
    return String(slot?.name || "") === MEDIA_INPUT;
}

/** 覆盖画布连接层，补绘虚拟连接并恢复其菜单交互。 */
function patchCanvas() {
    const canvas = app.canvas;
    if (!canvas || canvas.__DnMultiLinkPatched || typeof canvas.drawConnections !== "function") return;
    canvas.__DnMultiLinkPatched = true;
    const originalDraw = canvas.drawConnections;
    canvas.drawConnections = function (ctx) {
        const result = originalDraw.apply(this, arguments);
        drawVirtualLinks(this, ctx || this.bgctx || this.ctx);
        return result;
    };
    // 选中 DN 节点时，把这些虚拟连线**再画一遍到节点层之上**：
    // 连接层在节点之下，线中点会被别的节点压住 → 右键菜单点不到（实际遇到的问题）。
    const originalForeground = canvas.onDrawForeground;
    canvas.onDrawForeground = function (ctx) {
        const result = originalForeground?.apply(this, arguments);
        try {
            drawVirtualLinks(this, ctx || this.bgctx || this.ctx, { selectedOnly: true });
        } catch (error) {
            console.warn("[DN multilink] overlay draw failed:", error);
        }
        return result;
    };
    // 但「节点层之上」对**自绘 UI 的节点**还不够：那些节点的内容是真 DOM 元素，
    // canvas 上画的线永远压在它们下面（实测资产卡节点会盖住线中点）。
    // 所以再登记一份到 DOM 覆盖层 —— 同一套绘制函数，坐标也一样，只是画到了另一张画布。
    addForegroundPainter("dn.multilink.selected", (ctx, mainCanvas) => {
        drawVirtualLinks(mainCanvas, ctx, { selectedOnly: true, linesOnly: true });
    });
    // 中点圆点单独一层，用最高优先级 —— 它必须压在**选中时的金色高亮**之上，
    // 否则高亮线 8px 的外发光会把序号糊掉（用户实测反馈）。
    addForegroundPainter("dn.multilink.dots", (ctx, mainCanvas) => {
        drawVirtualLinks(mainCanvas, ctx, { selectedOnly: true, dotsOnly: true });
    }, PAINTER_TOP);
    // 看得见还不够，还得点得到：给每个中点挂透明 DOM 把手（在自绘 UI 之上）。
    addHandleProvider("dn.multilink.handles", virtualLinkHandles);
    const originalDown = canvas.processMouseDown;
    canvas.processMouseDown = function (event) {
        if (!isConnectingMedia(this)) {
            const [x, y] = getGraphPosition(this, event);
            const hit = hitTestVirtualLinks(this.graph || app.graph, x, y);
            if (hit) {
                openLinkMenu(this, hit, event);
                event?.preventDefault?.();
                event?.stopImmediatePropagation?.();
                return true;
            }
        }
        return originalDown?.apply(this, arguments);
    };
    const linkPointerHandler = (event) => {
        if (isConnectingMedia(canvas)) return;
        const [x, y] = getGraphPosition(canvas, event);
        const hit = hitTestVirtualLinks(canvas.graph || app.graph, x, y);
        if (!hit) return;
        openLinkMenu(canvas, hit, event);
        event.preventDefault?.();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
    };
    canvas.canvas?.addEventListener?.("pointerdown", linkPointerHandler, true);
}

/** 在 graphToPrompt 阶段把虚拟连接写成后端隐藏输入 media_1..N。 */
function patchGraphToPrompt() {
    if (app.__DnMultiLinkPromptPatched || typeof app.graphToPrompt !== "function") return;
    app.__DnMultiLinkPromptPatched = true;
    const original = app.graphToPrompt;
    app.graphToPrompt = async function () {
        const output = await original.apply(this, arguments);
        const prompt = output?.output || output || {};
        for (const node of app.graph?._nodes || []) {
            if (node?.comfyClass !== NODE_CLASS && node?.type !== NODE_CLASS) continue;
            const links = normalizeLinks(node);
            // 只有一条原生连线、没被收编过 → prompt 保持原样：老工作流与 API 调用都不受影响。
            if (!links.length) continue;
            const promptNode = prompt[String(node.id)];
            if (!promptNode) continue;
            promptNode.inputs ||= {};
            for (let index = 1; index <= MAX_MEDIA; index += 1) delete promptNode.inputs[`media_${index}`];
            delete promptNode.inputs[AUDIO_MASK_INPUT];
            let mediaIndex = 1;
            /* 段级音频掩码：与 media_1..N **在同一次循环里 push**，逐位对齐。
               顺序一旦分家，'0' 就会落到别的卡头上（那正好是"关错人"的经典 bug）。 */
            const mask = [];
            for (const link of links) {
                // 被忽略（mute / bypass）的上游不会出现在最终 prompt 里，不能继续作为后端连接提交。
                if (!Object.prototype.hasOwnProperty.call(prompt, String(link.source_id))) continue;
                promptNode.inputs[`media_${mediaIndex}`] = [String(link.source_id), Number(link.source_slot)];
                mask.push(isAudioSkipped(link) ? "0" : "1");
                mediaIndex += 1;
            }
            if (mediaIndex > 1) {
                delete promptNode.inputs.medias;
                // 全 1 就不注入：老工作流/API 调用看到的 prompt 与加这个功能之前完全一样。
                if (mask.some((bit) => bit === "0")) {
                    promptNode.inputs[AUDIO_MASK_INPUT] = mask.join("");
                }
            }
        }
        return output;
    };
}

/** 安装节点生命周期钩子，保证单端口可以重复接入。 */
function installNode(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS || nodeType.prototype.__DnMultiLinkInstalled) return;
    trimNodeDefinition(nodeData);
    nodeType.prototype.__DnMultiLinkInstalled = true;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        const result = originalCreated?.apply(this, arguments);
        normalizeLinks(this);
        syncNative(this);
        return result;
    };

    const originalConfigured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
        const result = originalConfigured?.apply(this, arguments);
        normalizeLinks(this);
        syncNative(this);
        this.setDirtyCanvas?.(true, true);
        return result;
    };

    const originalConnections = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type, index, connected, linkInfo) {
        const result = originalConnections?.apply(this, arguments);
        const input = this.inputs?.[Number(index)];
        if (type === 1 && input?.name === MEDIA_INPUT) {
            if (connected) {
                setTimeout(() => convertVisibleConnection(this, linkInfo), 0);
            } else if (!this.__dnConverted) {
                // 用户手动拔掉了唯一那条原生连线：快照作废。
                this.__dnNativeMedias = null;
            }
        }
        return result;
    };

    const originalDraw = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function () {
        const result = originalDraw?.apply(this, arguments);
        normalizeLinks(this);
        syncNative(this);
        return result;
    };

    // 节点右键菜单：一键清空 / 反转顺序（比逐个去点线中点方便得多）。
    const originalMenu = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
        const result = originalMenu?.apply(this, arguments);
        const links = normalizeLinks(this);
        if (!Array.isArray(options) || !links.length) return result;
        options.push(null);
        options.push({
            content: `清空全部连线（${links.length} 条）`,
            callback: () => { clearAllVirtualLinks(this); },
        });
        if (links.length > 1) {
            options.push({
                content: "连线顺序反转",
                callback: () => { reverseVirtualLinks(this); },
            });
        }
        return result;
    };
}

/** 注册扩展并在画布初始化后安装补丁。
 *  注意：注册必须「等 app 就绪」再调 —— ComfyUI 并行 import 所有扩展脚本，文件越小越先执行，
 *  那时 window.app 可能还没赋值，顶层直接 `app.registerExtension(...)` 会 ReferenceError
 *  且被静默吞掉（界面上像没装一样）。详见 skill `comfyui-custom-node-authoring` §5.11。 */
const extension = {
    name: "DN.MediaToDirectorGroup.MultiLink",
    setup() {
        if (extension.__setupDone) return;   // 幂等：注册晚于 app.setup 时会自己补调一次
        extension.__setupDone = true;
        const installPatches = (attempt = 0) => {
            patchGraphToPrompt();
            patchCanvas();
            if (attempt < 8 && (!app.__DnMultiLinkPromptPatched || !app.canvas?.__DnMultiLinkPatched)) {
                setTimeout(() => installPatches(attempt + 1), 250);
            }
        };
        installPatches();
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        installNode(nodeType, nodeData);
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
            console.warn("[DN multilink] 注册失败:", error);
            return;
        }
        const kick = () => {
            try { extension.setup(); } catch (error) { console.warn("[DN multilink] 初始化失败:", error); }
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

/* ================================================================
 * 8. 替换这张卡：圆点菜单 → 搜全工作流的资产卡 → 换连线（＋改提示词）
 * ================================================================ */

const PICKER_STYLE_ID = "dn-card-picker-style";
const PICKER_WIDTH = 320;
const PICKER_ROW = 46;          // 单行高度（缩略图 38 + 上下留白）
const PICKER_VISIBLE_ROWS = 5;  // 不用滑杆能直接看到的行数

function ensurePickerStyles() {
    if (document.getElementById(PICKER_STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = PICKER_STYLE_ID;
    el.textContent = `
.dn-card-picker { position: fixed; z-index: 100100; width: ${PICKER_WIDTH}px; padding: 6px; border-radius: 8px;
  background: #1b1f2a; border: 1px solid rgba(148,163,184,.35); box-shadow: 0 8px 24px rgba(0,0,0,.45);
  font: 12px/1.5 sans-serif; color: #e5e7eb; }
.dn-card-search { width: 100%; box-sizing: border-box; padding: 5px 8px; margin-bottom: 6px; border-radius: 6px;
  border: 1px solid rgba(148,163,184,.4); background: #12151d; color: #e5e7eb; outline: none; font-size: 12px; }
.dn-card-search:focus { border-color: #7dd3fc; }
.dn-card-list { max-height: ${PICKER_VISIBLE_ROWS * PICKER_ROW}px; overflow-y: auto; }
.dn-card-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
.dn-card-row:hover { background: rgba(245,185,66,.18); }
.dn-card-thumb { width: 38px; height: 38px; border-radius: 5px; object-fit: cover; background: #0c0f16; flex: 0 0 auto; display: block; }
.dn-card-thumb.is-audio { display: flex; align-items: center; justify-content: center; color: #93c5fd; font-size: 15px; }
.dn-card-main { min-width: 0; flex: 1; }
.dn-card-name { font-size: 12px; color: #e5e7eb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dn-card-sub { font-size: 10px; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dn-card-empty { padding: 16px 8px; text-align: center; opacity: .55; font-size: 12px; }
.dn-card-preview { position: fixed; z-index: 100101; width: 220px; padding: 5px; border-radius: 8px;
  background: rgba(12,16,24,.96); border: 1px solid rgba(245,185,66,.5); pointer-events: none; display: none; }
.dn-card-preview img { width: 100%; display: block; border-radius: 5px; }
.dn-card-preview .dn-card-preview-name { font-size: 11px; color: #e5e7eb; padding-top: 4px; text-align: center; }
.dn-swap-dialog { position: fixed; z-index: 100102; width: 400px; max-width: 94vw; max-height: 70vh; overflow: auto;
  padding: 10px 12px; border-radius: 10px; background: #1b1f2a; border: 1px solid rgba(245,185,66,.5);
  box-shadow: 0 12px 30px rgba(0,0,0,.55); font: 12px/1.6 sans-serif; color: #e5e7eb; box-sizing: border-box; }
.dn-swap-title { font-weight: 600; font-size: 13px; margin-bottom: 6px; }
.dn-swap-line { margin: 3px 0; }
.dn-swap-warn { color: #f5b942; margin: 3px 0; }
.dn-swap-ctx { opacity: .6; font-size: 11px; margin: 1px 0 1px 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dn-swap-check { display: flex; align-items: center; gap: 6px; margin-top: 8px; cursor: pointer; }
.dn-swap-check input { accent-color: #f5b942; }
.dn-swap-btns { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }
.dn-swap-btns button { font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--border-color,#4b5563); background: rgba(255,255,255,.06); color: var(--input-text,#e5e7eb); }
.dn-swap-btns button:hover { background: rgba(255,255,255,.12); }
.dn-swap-btns button.dn-primary { background: rgba(245,185,66,.2); border-color: rgba(245,185,66,.6); color: #f5b942; }
.dn-swap-toast { position: fixed; z-index: 100103; bottom: 22px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 8px;
  background: rgba(12,16,24,.95); border: 1px solid rgba(148,163,184,.4);
  font: 12px/1.5 sans-serif; color: #e5e7eb; box-shadow: 0 8px 24px rgba(0,0,0,.45); }
.dn-swap-toast button { font-size: 12px; padding: 2px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid rgba(245,185,66,.6); background: rgba(245,185,66,.15); color: #f5b942; }
`;
    document.head.append(el);
}

function widgetValueOf(node, name) {
    const w = (node?.widgets || []).find((item) => item && item.name === name);
    return w ? w.value : undefined;
}

function cardViewUrl(name) {
    return name ? `/view?filename=${encodeURIComponent(name)}&type=input` : "";
}

let cardPicker = null;

function closeCardPicker() {
    if (!cardPicker) return;
    cardPicker.cleanup?.();
    cardPicker.el?.remove();
    cardPicker.preview?.remove();
    cardPicker = null;
}

/** 打开选卡器：搜索栏 + 5 行可见的滚动列表（缩略图 + 资产名），排除本组已连的卡。 */
function openCardPicker(anchor, hit) {
    ensurePickerStyles();
    closeCardPicker();
    // 不选中节点直接右键圆点时，节点自己的菜单也会叠上来 —— 打开选卡器前把残留菜单清掉
    document.querySelectorAll(".litecontextmenu").forEach((m) => m.remove());
    const node = hit.targetNode;
    const index = hit.index;
    const connected = new Set(normalizeLinks(node).map((link) => Number(link.source_id)));
    const rows = (app.graph?._nodes || [])
        .filter((n) => n.type === "H3MediaLoader" && !connected.has(Number(n.id)))
        .map((n) => {
            const role = String(widgetValueOf(n, "role_name") ?? "").trim();
            // 资产卡没选图时 properties 里是哨兵值 "(none)" —— 不认它就会把 "(none)"
            // 当成文件名（搜索结果里多一个假文件名、缩略图去请求一个不存在的图片）。
            let rawImage = n.properties?.pml_image_filename;
            if (isNoneName(rawImage)) rawImage = widgetValueOf(n, "image_filename");
            const image = isNoneName(rawImage) ? "" : String(rawImage);
            const rawAudio = n.properties?.pml_audio_filename;
            const audio = isNoneName(rawAudio) ? "" : String(rawAudio);
            return { id: Number(n.id), role, image, audio, hay: `${role} ${image}`.toLowerCase() };
        })
        .sort((a, b) => (a.role || "\uffff").localeCompare(b.role || "\uffff", "zh-Hans-CN"));

    const el = document.createElement("div");
    el.className = "dn-card-picker";
    const search = document.createElement("input");
    search.className = "dn-card-search";
    search.placeholder = "按资产名 / 文件名搜索…";
    const list = document.createElement("div");
    list.className = "dn-card-list";
    el.append(search, list);
    const preview = document.createElement("div");
    preview.className = "dn-card-preview";
    document.body.append(el, preview);

    const render = (query) => {
        list.textContent = "";
        const q = String(query || "").trim().toLowerCase();
        const hits = rows.filter((row) => !q || row.hay.includes(q));
        if (!hits.length) {
            const empty = document.createElement("div");
            empty.className = "dn-card-empty";
            empty.textContent = "没有匹配的资产卡";
            list.append(empty);
            return;
        }
        for (const row of hits) {
            const item = document.createElement("div");
            item.className = "dn-card-row";
            const hasImg = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(row.image);
            const kind = [hasImg ? "图" : null, row.audio ? "音" : null].filter(Boolean).join("+") || "空";
            if (hasImg) {
                const img = document.createElement("img");
                img.className = "dn-card-thumb";
                img.src = cardViewUrl(row.image);
                img.alt = "";
                item.append(img);
                item.addEventListener("mouseenter", () => {
                    preview.textContent = "";
                    const big = document.createElement("img");
                    big.src = img.src;
                    big.alt = "";
                    const cap = document.createElement("div");
                    cap.className = "dn-card-preview-name";
                    cap.textContent = row.role || row.image;
                    preview.append(big, cap);
                    preview.style.display = "block";
                    const pw = 230;
                    const px = Math.min(anchor.x + PICKER_WIDTH + 8, window.innerWidth - pw - 8);
                    const py = Math.min(Math.max(8, item.getBoundingClientRect().top - 40), window.innerHeight - 260);
                    preview.style.left = `${Math.max(8, px)}px`;
                    preview.style.top = `${py}px`;
                });
                item.addEventListener("mouseleave", () => { preview.style.display = "none"; });
            } else {
                const ph = document.createElement("div");
                ph.className = "dn-card-thumb is-audio";
                ph.textContent = "音";
                item.append(ph);
            }
            const main = document.createElement("div");
            main.className = "dn-card-main";
            const name = document.createElement("div");
            name.className = "dn-card-name";
            name.textContent = row.role || "(未命名)";
            const sub = document.createElement("div");
            sub.className = "dn-card-sub";
            sub.textContent = `${kind} · ${row.image || row.audio || "无文件"}`;
            main.append(name, sub);
            item.append(main);
            item.addEventListener("click", () => {
                const at = { x: anchor.x, y: anchor.y };
                closeCardPicker();
                pickReplacement(node, index, row, at);
            });
            list.append(item);
        }
    };
    render("");
    search.addEventListener("input", () => render(search.value));

    const onDocDown = (event) => {
        if (cardPicker && !cardPicker.el.contains(event.target)) closeCardPicker();
    };
    const onKey = (event) => { if (event.key === "Escape") closeCardPicker(); };
    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
    const cleanup = () => {
        document.removeEventListener("pointerdown", onDocDown, true);
        document.removeEventListener("keydown", onKey, true);
    };
    cardPicker = { el, preview, cleanup };

    el.style.left = `${Math.min(Math.max(8, anchor.x), Math.max(8, window.innerWidth - PICKER_WIDTH - 8))}px`;
    el.style.top = `${Math.min(Math.max(8, anchor.y), Math.max(8, window.innerHeight - (PICKER_VISIBLE_ROWS * PICKER_ROW + 96)))}px`;
    setTimeout(() => search.focus(), 0);
}

/** 选定一张卡：能直接换就直接换；会动提示词的先弹确认框。 */
/** 找出**其它组**里连着同一张卡的连线（多组联动替换用）。
 *  跳过「已连着新卡」的组 —— 换上去会被 normalizeLinks 按 卡:槽 去重，静默丢一条。 */
function findOtherOccurrences(node, outId, toId) {
    const out = [];
    let skippedDup = 0;
    for (const n of app.graph?._nodes || []) {
        if (!n || n === node || n.type !== NODE_CLASS) continue;
        const links = normalizeLinks(n);
        links.forEach((link, index) => {
            if (Number(link.source_id) !== Number(outId)) return;
            if (links.some((l) => Number(l.source_id) === Number(toId))) { skippedDup += 1; return; }
            out.push({ node: n, index });
        });
    }
    return { others: out, skippedDup };
}

function pickReplacement(node, index, row, anchor) {
    const links = normalizeLinks(node);
    const outId = Number(links[index]?.source_id);
    const { others, skippedDup } = findOtherOccurrences(node, outId, row.id);
    const plan = planCardSwap(node, index, row.id, 0);
    if (!plan) { showToast("替换失败：找不到连线或卡片"); return; }
    const needsConfirm = !plan.sameRole || plan.remaps.length > 0 || plan.warnings.length > 0 || others.length > 0;
    if (!needsConfirm) {
        const res = applyCardSwap(node, index, row.id, 0, "rewrite");
        showToast(`已替换为「${row.role || "(未命名)"}」`, res?.undo);
        return;
    }
    openSwapConfirm(node, index, row, plan, anchor, others, skippedDup);
}

/** 确认框：列出会动的每一处 —— 名字替换、编号重映射、警告、多组联动；三个出口。 */
function openSwapConfirm(node, index, row, plan, anchor, others, skippedDup) {
    closeCardPicker();
    ensurePickerStyles();
    const oldName = plan.oldRole || "(未命名)";
    const newName = plan.newRole || "(未命名)";
    const el = document.createElement("div");
    el.className = "dn-swap-dialog";
    const title = document.createElement("div");
    title.className = "dn-swap-title";
    title.textContent = `替换连线：${oldName} → ${newName}`;
    el.append(title);

    if (plan.nameCount) {
        const line = document.createElement("div");
        line.className = "dn-swap-line";
        line.textContent = `提示词将替换 ${plan.nameCount} 处「${plan.oldRole}」→「${plan.newRole}」：`;
        el.append(line);
        for (const ctx of plan.contexts) {
            const c = document.createElement("div");
            c.className = "dn-swap-ctx";
            c.textContent = `…${ctx}…`;
            el.append(c);
        }
    }
    for (const r of plan.remaps) {
        const line = document.createElement("div");
        line.className = "dn-swap-line";
        line.textContent = `编号变化：<${r.type} ${r.from}> → <${r.type} ${r.to}>`;
        el.append(line);
    }
    for (const w of plan.warnings) {
        const line = document.createElement("div");
        line.className = "dn-swap-warn";
        line.textContent = `⚠ ${w}`;
        el.append(line);
    }

    // 多组联动：同一张卡还连在别的组里 → 勾选就一起换（每个组各自的提示词各自重写）
    let linkOthers = null;
    if (others.length) {
        const label = document.createElement("label");
        label.className = "dn-swap-check";
        linkOthers = document.createElement("input");
        linkOthers.type = "checkbox";
        label.append(linkOthers, document.createTextNode(` 同时替换其它组里的同一张卡（${others.length} 处，各自改提示词）`));
        el.append(label);
    } else if (skippedDup) {
        const line = document.createElement("div");
        line.className = "dn-swap-ctx";
        line.textContent = `（另有 ${skippedDup} 个组已连着新卡，跳过不动）`;
        el.append(line);
    }

    const btns = document.createElement("div");
    btns.className = "dn-swap-btns";
    const make = (label, cls, fn) => {
        const b = document.createElement("button");
        b.textContent = label;
        if (cls) b.className = cls;
        b.addEventListener("click", () => { el.remove(); fn(); });
        return b;
    };
    const runSwap = (mode) => {
        const undos = [];
        let names = 0;
        let remapTotal = 0;
        let groups = 0;
        const apply = (n, i) => {
            const res = applyCardSwap(n, i, row.id, 0, mode);
            if (!res) return;
            groups += 1;
            names += res.nameCount || 0;
            remapTotal += res.remaps?.length || 0;
            if (res.undo) undos.push(res.undo);
        };
        apply(node, index);
        if (linkOthers?.checked) for (const occ of others) apply(occ.node, occ.index);
        const undo = undos.length ? () => { for (const u of undos.reverse()) u(); } : null;
        const parts = [`已替换 ${groups} 个组为「${newName}」`];
        if (names) parts.push(`改了 ${names} 处资产名`);
        if (remapTotal) parts.push(`重映射 ${remapTotal} 个编号`);
        showToast(parts.join("，"), undo, mode === "link-only");
    };
    btns.append(make("替换并改提示词", "dn-primary", () => runSwap("rewrite")));
    btns.append(make("只换连线", "", () => runSwap("link-only")));
    btns.append(make("取消", "", () => {}));
    el.append(btns);

    const onKey = (event) => { if (event.key === "Escape") { el.remove(); document.removeEventListener("keydown", onKey, true); } };
    document.addEventListener("keydown", onKey, true);
    el.addEventListener("click", (event) => event.stopPropagation());
    document.body.append(el);
    const dw = 400;
    el.style.left = `${Math.min(Math.max(8, (anchor?.x ?? 100)), Math.max(8, window.innerWidth - dw - 8))}px`;
    el.style.top = `${Math.min(Math.max(8, (anchor?.y ?? 100)), Math.max(8, window.innerHeight - 240))}px`;
}

/** 换完的提示条：可撤销，12 秒后自己消失。 */
function showToast(text, undo, isLinkOnly) {
    document.querySelectorAll(".dn-swap-toast").forEach((item) => item.remove());
    ensurePickerStyles();
    const el = document.createElement("div");
    el.className = "dn-swap-toast";
    const span = document.createElement("span");
    span.textContent = isLinkOnly ? `${text}（提示词未自动修改）` : text;
    el.append(span);
    if (undo) {
        const btn = document.createElement("button");
        btn.textContent = "撤销";
        btn.addEventListener("click", () => { undo(); el.remove(); });
        el.append(btn);
    }
    document.body.append(el);
    setTimeout(() => el.remove(), 12000);
}
