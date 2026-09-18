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

/** 登记到覆盖层的绘制函数（同名只登记一次）。 */
const painters = new Map();

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
    if (!painters.size) return;

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
    for (const fn of painters.values()) {
        try {
            fn(ctx, canvas);
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

/** 登记一个「需要画在节点/DOM 控件之上」的绘制函数。
 *  @param name  唯一名字（重复登记会覆盖，便于热刷新）
 *  @param fn    (ctx, canvas) => void，坐标 = 画布坐标（与画布上正常绘制一致） */
export function addForegroundPainter(name, fn) {
    painters.set(name, fn);
    const canvas = globalThis.app?.canvas;
    if (canvas) hookCanvas(canvas);
    else {
        // app 还没就绪：轮询等它（本扩展都跑在 setup 里，一般不会走到）
        let tries = 0;
        const timer = setInterval(() => {
            if (globalThis.app?.canvas) { hookCanvas(globalThis.app.canvas); repaint(globalThis.app.canvas); clearInterval(timer); }
            else if (++tries > 600) clearInterval(timer);
        }, 16);
    }
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
