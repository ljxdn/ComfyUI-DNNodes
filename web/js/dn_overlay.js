/*
 * DN 节点包 —— 画布之上的 DOM 覆盖层：把「选中时高亮」的连线画到节点与控件之上。
 *
 * 为什么需要它（实测结论，别改回纯 canvas 方案）：
 *   ComfyUI 里「节点自绘 UI」是真正的 DOM 元素（`.dom-widget`，父层 `.isolate`），
 *   而连线画在 `<canvas>` 上。`#graph-canvas-container` 的子元素顺序是：
 *       … → CANVAS → … → .isolate(DOM 控件) → …
 *   两者不在同一层，所以**无论 canvas 内部怎么调整绘制顺序，canvas 上画的线都永远
 *   在 DOM 控件下面**。实测：把一个「资产卡」节点压在线中点上，elementFromPoint
 *   命中的是 `DIV.pml-image`（节点自己的 DOM 控件），线中点根本点不到。
 *
 * 解法：在同一个容器里再挂一张透明 canvas，放在 DOM 控件之后（z-index 抬到它们之上、
 *   但仍低于菜单/浮层），并用**与主画布完全相同的变换矩阵**（graph → 设备像素）绘制。
 *   这样原有的绘制函数一行都不用改 —— 它们照旧按画布坐标画，只是画到了另一张画布上。
 *
 * 只在「有东西要画」时才清屏+重绘（绘制函数自己会判断有没有选中的 DN 节点），
 * 平时几乎零开销；pointer-events: none，不挡任何鼠标操作。
 */

const LAYER_ID = "dn-highlight-overlay";
const Z_INDEX = 5;              // 高于 .isolate 里的 DOM 控件(z-index:0)，低于 comfy-menu(999)/tooltip(99999)

/** 登记到覆盖层的绘制函数（同名只登记一次）。
 *  value = { fn, priority, order }；绘制时**按 priority 升序**（同优先级按登记先后），
 *  也就是 priority 越大的越晚画、越靠上。
 *  为什么要显式优先级：金色高亮和连线圆点是两个扩展各自登记的，而 ComfyUI 是
 *  **并行 import** 所有扩展脚本（文件小、编译快的先执行），所以「谁后画」本来是随机的 ——
 *  高亮线的 8px 外发光会把中点的序号圆点糊掉。用优先级把它钉死。 */
const painters = new Map();
let painterSeq = 0;

/** 画在最上层的优先级（用于「必须压过金色高亮」的东西，如连线中点的序号圆点）。 */
export const PAINTER_TOP = 100;

/* ------------------------------------------------------------------
 * 共享绘制件：虚拟连线中点的「序号圆点」
 * 几何与配色只在这里定义一次，避免多处各写一套导致大小/字体对不上。
 * ------------------------------------------------------------------ */
export const VIRTUAL_DOT = {
    radius: 11,               // 半径（原来是 8，用户反馈太小）
    ringWidth: 2.5,           // 深色描边：把圆点从金色发光的背景里"抠"出来
    fill: "#34d399",
    ring: "#071510",
    text: "#071510",
    font: "bold 12px Arial",
};

/** 在 (x, y) 画一个带序号的圆点。坐标 = 画布坐标。 */
export function drawVirtualDot(ctx, x, y, label) {
    if (!ctx || !Number.isFinite(x) || !Number.isFinite(y)) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, VIRTUAL_DOT.radius, 0, Math.PI * 2);
    ctx.fillStyle = VIRTUAL_DOT.fill;
    ctx.fill();
    if (VIRTUAL_DOT.ringWidth > 0) {
        ctx.lineWidth = VIRTUAL_DOT.ringWidth;
        ctx.strokeStyle = VIRTUAL_DOT.ring;
        ctx.stroke();
    }
    ctx.fillStyle = VIRTUAL_DOT.text;
    ctx.font = VIRTUAL_DOT.font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(label), x, y);
    ctx.restore();
}

/** 按优先级排好序的绘制函数列表。 */
function orderedPainters() {
    const list = Array.from(painters.values());
    list.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));
    return list;
}

/** 登记「可点击把手」的提供者（同名只登记一次）。
 *  为什么要 DOM 把手：线中点画在覆盖层上是**看得见**了，但覆盖层 pointer-events:none，
 *  真正吃到点击的是它下面那个节点自绘 UI（真 DOM 元素）—— 于是点线中点反而选中了节点。
 *  这里给每个可见的点挂一个透明 DOM 元素，它天然在 DOM 控件之上，点击就是它的。 */
const handleProviders = new Map();
const handlePool = new Map();
const HANDLE_Z_INDEX = Z_INDEX + 1;

/** 取主画布所在容器（DOM 控件与主画布的共同父层）。 */
function getContainer(canvas) {
    const main = canvas?.canvas;
    if (!main) return null;
    return document.getElementById("graph-canvas-container")
        || main.closest?.(".graph-canvas-container")
        || main.parentElement;
}

/** 创建（或取回）覆盖层 canvas。 */
function ensureLayer(canvas) {
    const container = getContainer(canvas);
    if (!container) return null;
    let layer = document.getElementById(LAYER_ID);
    if (layer && layer.parentElement !== container) {
        layer.remove();
        layer = null;
    }
    if (!layer) {
        layer = document.createElement("canvas");
        layer.id = LAYER_ID;
        layer.style.position = "absolute";
        layer.style.left = "0";
        layer.style.top = "0";
        layer.style.pointerEvents = "none";
        layer.style.zIndex = String(Z_INDEX);
        container.append(layer);
    } else if (container.lastElementChild !== layer && !layer.dataset.dnMoved) {
        // 新来的元素（比如刚创建的 DOM 控件层）可能盖在它上面 → 挪到最后并抬 z-index
        layer.dataset.dnMoved = "1";
        container.append(layer);
    }
    return layer;
}

/** 让覆盖层的像素尺寸与主画布一致（含 DPR 处理，直接照抄主画布的宽高比）。 */
function syncSize(layer, main) {
    const rect = main.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    const ratio = cssW > 0 ? (main.width || cssW) / cssW : 1;
    const wantW = Math.max(1, Math.round(cssW * ratio));
    const wantH = Math.max(1, Math.round(cssH * ratio));
    if (layer.width !== wantW || layer.height !== wantH) {
        layer.width = wantW;
        layer.height = wantH;
    }
    if (layer.style.width !== `${cssW}px` || layer.style.height !== `${cssH}px`) {
        layer.style.width = `${cssW}px`;
        layer.style.height = `${cssH}px`;
    }
    return ratio;
}

/** 重画覆盖层：清屏 → 设成与主画布相同的变换 → 依次调用登记的绘制函数。 */
function repaint(canvas) {
    const main = canvas?.canvas;
    if (!main || !main.isConnected) return;
    const layer = ensureLayer(canvas);
    if (!layer) return;
    if (!painters.size && !handleProviders.size) return;

    const ratio = syncSize(layer, main);
    const ctx = layer.getContext("2d");
    if (!ctx) return;

    const ds = canvas.ds || { scale: 1, offset: [0, 0] };
    const scale = Number(ds.scale) || 1;
    const offset = ds.offset || [0, 0];

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, layer.width, layer.height);
    // graph → 设备像素：dev = (g + offset) * scale * ratio
    const k = scale * ratio;
    ctx.setTransform(k, 0, 0, k, offset[0] * k, offset[1] * k);
    ctx.save();
    for (const rec of orderedPainters()) {
        try {
            rec.fn(ctx, canvas);
        } catch (error) {
            console.warn("[DN overlay] painter failed:", error);
        }
    }
    ctx.restore();

    const dbg = globalThis.__dnOverlay;
    if (dbg) {
        dbg.paints = (dbg.paints || 0) + 1;
        dbg.lastSize = [layer.width, layer.height];
        dbg.lastTransform = [k, offset[0] * k, offset[1] * k];
    }

    syncHandles(canvas, ratio);
}

/* ------------------------------------------------------------------
 * 可点击把手（透明 DOM 元素，压在节点自绘 UI 之上）
 * ------------------------------------------------------------------ */

/** 收集所有提供者给的把手，增量同步到 DOM。 */
function syncHandles(canvas, ratio) {
    const layer = document.getElementById(LAYER_ID);
    const container = layer?.parentElement;
    if (!container) return;
    const ds = canvas?.ds || { scale: 1, offset: [0, 0] };
    const scale = Number(ds.scale) || 1;
    const offset = ds.offset || [0, 0];
    // 画布坐标 → 容器内 CSS 像素（与主画布同一套换算：(g + offset) * scale）
    const toScreen = (point) => [
        (Number(point?.[0]) + offset[0]) * scale,
        (Number(point?.[1]) + offset[1]) * scale,
    ];

    const list = [];
    for (const fn of handleProviders.values()) {
        try {
            const out = fn(canvas, toScreen);
            if (Array.isArray(out)) list.push(...out);
        } catch (error) {
            console.warn("[DN overlay] handle provider failed:", error);
        }
    }

    const seen = new Set();
    for (const item of list) {
        if (!item || item.key == null) continue;
        const key = String(item.key);
        seen.add(key);
        let rec = handlePool.get(key);
        if (!rec) {
            const el = document.createElement("div");
            el.className = "dn-link-handle";
            el.dataset.dnHandle = key;
            el.style.position = "absolute";
            el.style.background = "transparent";
            el.style.pointerEvents = "auto";
            el.style.cursor = "pointer";
            el.style.zIndex = String(HANDLE_Z_INDEX);
            container.append(el);
            rec = { el };
            handlePool.set(key, rec);
        }
        rec.data = item;
        const size = Number(item.size) || 34;
        rec.el.style.width = `${size}px`;
        rec.el.style.height = `${size}px`;
        rec.el.style.left = `${item.x - size / 2}px`;
        rec.el.style.top = `${item.y - size / 2}px`;
        if (rec.el.title !== (item.title || "")) rec.el.title = item.title || "";
        if (!rec.bound) {
            rec.bound = true;
            // 事件一律就地掐断：不能让它冒到画布/ComfyUI 那边去（否则又变成选中节点）
            rec.el.addEventListener("pointerdown", (event) => {
                const data = rec.data;
                if (event.button === 2) return;          // 右键交给 contextmenu，免得开两次菜单
                if (!data?.onActivate) return;
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                data.onActivate(event);
            }, true);
            rec.el.addEventListener("contextmenu", (event) => {
                const data = rec.data;
                if (!data?.onMenu) return;
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                data.onMenu(event);
            }, true);
        }
    }
    for (const [key, rec] of Array.from(handlePool.entries())) {
        if (seen.has(key)) continue;
        rec.el.remove();
        handlePool.delete(key);
    }
    const dbg = globalThis.__dnOverlay;
    if (dbg) dbg.handles = handlePool.size;
}

/** 登记一个把手提供者：(canvas, toScreen) => [{ key, x, y, size, title, onActivate, onMenu }]。
 *  x/y 用容器内 CSS 像素（调用 toScreen(画布坐标) 得到）。 */
export function addHandleProvider(name, fn) {
    handleProviders.set(name, fn);
    ensureHooked();
    return fn;
}

/** 移除把手提供者。 */
export function removeHandleProvider(name) {
    handleProviders.delete(name);
}

/** 把主画布的前景回调接上覆盖层重绘（幂等）。 */
function hookCanvas(canvas) {
    if (!canvas || canvas.__DnOverlayHooked) return;
    canvas.__DnOverlayHooked = true;
    const originalForeground = canvas.onDrawForeground;
    canvas.onDrawForeground = function () {
        const result = originalForeground?.apply(this, arguments);
        repaint(this);
        return result;
    };
    // 画布尺寸变化（侧栏开合、窗口缩放）时也要跟着变
    if (typeof ResizeObserver === "function" && !canvas.__DnOverlayRO) {
        const container = getContainer(canvas);
        if (container) {
            const ro = new ResizeObserver(() => {
                const layer = document.getElementById(LAYER_ID);
                if (layer) layer.dataset.dnResized = "1";
                repaint(canvas);
            });
            ro.observe(container);
            canvas.__DnOverlayRO = ro;
        }
    }
}

/** 确保主画布的前景回调已接上（app 还没就绪时轮询等它）。 */
function ensureHooked() {
    const canvas = globalThis.app?.canvas;
    if (canvas) {
        hookCanvas(canvas);
        repaint(canvas);
        return;
    }
    let tries = 0;
    const timer = setInterval(() => {
        if (globalThis.app?.canvas) {
            hookCanvas(globalThis.app.canvas);
            repaint(globalThis.app.canvas);
            clearInterval(timer);
        } else if (++tries > 600) {
            clearInterval(timer);
        }
    }, 16);
}

/** 登记一个「需要画在节点/DOM 控件之上」的绘制函数。
 *  @param name      唯一名字（重复登记会覆盖，便于热刷新）
 *  @param fn        (ctx, canvas) => void，坐标 = 画布坐标（与画布上正常绘制一致）
 *  @param priority  越大越晚画、越靠上（默认 0；要用 :data:`PAINTER_TOP` 压过高亮层） */
export function addForegroundPainter(name, fn, priority = 0) {
    painters.set(name, { fn, priority: Number(priority) || 0, order: ++painterSeq });
    ensureHooked();
    return fn;
}

/** 移除已登记的绘制函数。 */
export function removeForegroundPainter(name) {
    painters.delete(name);
}

// 调试把手（探针用）：能看到覆盖层本体、绘制次数与当前变换
globalThis.__dnOverlay = globalThis.__dnOverlay || { paints: 0 };
globalThis.__dnOverlay.layerId = LAYER_ID;
globalThis.__dnOverlay.painterCount = () => painters.size;
/** 探针用：当前登记的绘制函数与它们的优先级（按绘制顺序）。 */
globalThis.__dnOverlay.painters = () => orderedPainters().map((rec) => rec.priority);
globalThis.__dnOverlay.painterNames = () => Array.from(painters.keys());
