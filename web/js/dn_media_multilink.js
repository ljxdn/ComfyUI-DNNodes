import { app } from "../../../scripts/app.js";
import { addForegroundPainter } from "./dn_overlay.js";

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
 */

const NODE_CLASS = "DNMediaToDirectorGroup";
const MEDIA_INPUT = "medias";
const BACKING_RE = /^media_[1-9]$/;
const MAX_MEDIA = 9;
const LINKS_PROPERTY = "dn_media_to_group_links";

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

/** 删除前端定义里的隐藏传输输入，避免它们出现在节点上。 */
function trimNodeDefinition(nodeData) {
    const remove = (container) => {
        if (!container || typeof container !== "object") return;
        for (const name of Object.keys(container)) {
            if (BACKING_RE.test(name)) delete container[name];
        }
    };
    remove(nodeData?.input?.required);
    remove(nodeData?.input?.optional);
    remove(nodeData?.required);
    remove(nodeData?.optional);
    for (const key of ["required", "optional"]) {
        if (Array.isArray(nodeData?.input_order?.[key])) {
            nodeData.input_order[key] = nodeData.input_order[key].filter((name) => !BACKING_RE.test(String(name)));
        }
    }
    if (Array.isArray(nodeData?.inputs)) {
        nodeData.inputs = nodeData.inputs.filter((input) => !BACKING_RE.test(String(input?.name || input?.id || input)));
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
 *  用于把它们补画到**节点层之上**（否则线中点会被别的节点压住，右键点不到）。 */
function drawVirtualLinks(canvas, ctx, options) {
    const graph = canvas?.graph || app.graph;
    if (!ctx || !graph?._nodes || canvas.links_render_mode === globalThis.LiteGraph?.HIDDEN_LINK) return;
    const selectedOnly = !!options?.selectedOnly;
    for (const target of graph._nodes) {
        if (target?.comfyClass !== NODE_CLASS && target?.type !== NODE_CLASS) continue;
        if (selectedOnly && !isNodeSelected(canvas, target)) continue;
        const targetPoint = getMediaPosition(target);
        if (!targetPoint) continue;
        for (const [index, item] of normalizeLinks(target).entries()) {
            const sourceNode = getNode(graph, item.source_id);
            const sourcePoint = getOutputPosition(sourceNode, Number(item.source_slot));
            if (!sourceNode || !sourcePoint) continue;
            const midX = (sourcePoint[0] + targetPoint[0]) / 2;
            const midY = (sourcePoint[1] + targetPoint[1]) / 2;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(sourcePoint[0], sourcePoint[1]);
            ctx.bezierCurveTo(sourcePoint[0] + 80, sourcePoint[1], targetPoint[0] - 80, targetPoint[1], targetPoint[0], targetPoint[1]);
            ctx.lineWidth = canvas.connections_width || 3;
            ctx.strokeStyle = globalThis.LGraphCanvas?.link_type_colors?.H3_MEDIA || "#34d399";
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(midX, midY, 8, 0, Math.PI * 2);
            ctx.fillStyle = "#34d399";
            ctx.fill();
            ctx.fillStyle = "#071510";
            ctx.font = "bold 10px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(index + 1), midX, midY);
            ctx.restore();
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
            if (distance <= 18 && (!best || distance < best.distance)) {
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
        const count = normalizeLinks(hit.targetNode).length;
        const items = [];
        if (count > 1) {
            items.push({ content: "上移一位（编号提前）", callback: run(() => moveVirtualLink(hit.targetNode, hit.index, -1)) });
            items.push({ content: "下移一位（编号推后）", callback: run(() => moveVirtualLink(hit.targetNode, hit.index, +1)) });
            items.push(null);
        }
        items.push({ content: "删除这条连线", callback: run(() => removeVirtualLink(hit.targetNode, hit.index)) });
        menuInstance = new globalThis.LiteGraph.ContextMenu(items, { event: menuEvent });
    }
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
        drawVirtualLinks(mainCanvas, ctx, { selectedOnly: true });
    });
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
            let mediaIndex = 1;
            for (const link of links) {
                // 被忽略（mute / bypass）的上游不会出现在最终 prompt 里，不能继续作为后端连接提交。
                if (!Object.prototype.hasOwnProperty.call(prompt, String(link.source_id))) continue;
                promptNode.inputs[`media_${mediaIndex}`] = [String(link.source_id), Number(link.source_slot)];
                mediaIndex += 1;
            }
            if (mediaIndex > 1) delete promptNode.inputs.medias;
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
