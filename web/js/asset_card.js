/*
 * 资产卡（Asset Card）前端 —— 原 ComfyUI-H3-OpenNodes 的 H3 Media Loader 前端
 *
 * 来源与授权（MIT）：
 *   派生自 https://github.com/juntaosun/ComfyUI-H3-OpenNodes 的 web/js/MediaLoader.js
 *   作者 sunnyboxs（GitHub: juntaosun），MIT License，Copyright (c) 2026 sunnyboxs。
 *   上游仓库已删除（GitHub 404）。
 *   完整信息见仓库根目录 LICENSE 与 THIRD_PARTY_NOTICES.md。
 *
 * 本包（ComfyUI-DNNodes）相对上游的改动：
 *   - 标签/提示词里的「角色名」→「资产名」、波形区高度减半、上传改走本包路由
 *   - 清掉「控件转输入」自动生成、且因为控件被隐藏而全部叠在左上角的残留输入槽位
 */

import { app } from "../../../scripts/app.js";

/* =====================================================================
资产卡 前端（节点类名仍是 H3MediaLoader，改动只为界面观感）
- 图像：保留 LoadImage 风格下拉（含上传按钮），预览区仅展示/拖放
- 音频：波形、播放、裁剪；拖入音频区域时高亮
- 文本：原生多行框，高度锁定，避免播放时被撑开
===================================================================== */

const NODE_CLASS = "H3MediaLoader";
const IMAGE_NONE = "(none)";

const PROP_IMAGE = "pml_image_filename";
const PROP_AUDIO = "pml_audio_filename";
const PROP_TRIM_START = "pml_trim_start";
const PROP_TRIM_END = "pml_trim_end";
const PROP_AUDIO_MUTED = "pml_audio_muted";

/* ----------------------------- 布局 ----------------------------- */
const NODE_WIDTH = 480;
const IMAGE_H = 148;
// 波形区高度：75 → 38（上下砍掉约一半），画布按 clientHeight 自适应，无需改绘制逻辑。
const WAVEFORM_H = 38;
const CTRLROW_H = 16;
const GAP = 6;
const AUDIO_GAP = 2;
const AUDIO_PADDING = 6;
const PAD_X = 2;
const PAD_Y = 2;
// 「角色名 + 最长边」并成一行画在图像/音频容器里，原生 role_name / max_edge 控件隐藏不占高度，
// 所以 CHROME 只需容纳标题栏与图像下拉行（原 92 里含一整行原生「角色名」）。
const ROLE_ROW_H = 30;
const ROLE_ROW_GAP = 6;
const MAX_EDGE_W = 62;
const CHROME = 60;
const AUDIO_BLOCK_H = WAVEFORM_H + CTRLROW_H + AUDIO_GAP + AUDIO_PADDING * 2 + 8;
const CONTENT_H = IMAGE_H + GAP + AUDIO_BLOCK_H + GAP + ROLE_ROW_H + PAD_Y;
const TEXT_WIDGET_MIN_H = 70;
const TEXT_BOTTOM_GAP = 10;
const TEXT_NODE_BOTTOM_MARGIN = 8;
const TEXT_HEIGHT_OFFSET = 30;
const ROLE_NAME_TOP_GAP = 14;
const DEFAULT_HEIGHT = CONTENT_H + CHROME + ROLE_NAME_TOP_GAP + TEXT_WIDGET_MIN_H + TEXT_BOTTOM_GAP + TEXT_NODE_BOTTOM_MARGIN + 50;
const MIN_WIDTH = 340;
const MIN_HEIGHT = DEFAULT_HEIGHT;
const SIZE_SANITY_MAX = 4096;

const REQUIRED_WIDGET_INDEX = {
    image_filename: 0,
    audio_filename: 1,
    trim_start: 2,
    trim_end: 3,
    audio_muted: 4,
    role_name: 5,
    prompt: 6,
};

/* 「最长边」默认值与取值范围，与 H3MediaLoader.py 的 DEFAULT_MAX_EDGE / MIN_MAX_EDGE / MAX_EDGE_LIMIT 对齐。 */
const MAX_EDGE_DEFAULT = 1440;
const MAX_EDGE_MIN = 32;
const MAX_EDGE_MAX = 4096;

/* ---- 剪贴板粘贴图片 ---- */
const PASTE_TITLE = "粘贴剪贴板里的图片（截图后点这里）";
const PASTE_HINT_ARMED = "现在按 Ctrl+V 粘贴图片（8 秒内有效）";
const PASTE_WAIT_MS = 8000;
const PASTE_MIME_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/avif": "avif",
};

/*
 * 控件在列表末尾的固定排布顺序。
 *
 * ComfyUI 默认按「位置」读写 widgets_values（namedValuesRestore 默认为关），
 * 一旦控件顺序变化，旧工作流的所有值就会整体错位（曾把 prompt 挤进「角色名」）。
 * 因此 max_edge 固定追加在最后：前 9 位与没有「最长边」的旧版本逐一对应，
 * 旧工作流按位置还原依然正确，新版只多出最后 1 位给 max_edge。
 */
const TAIL_WIDGET_ORDER = ["pml_ui", "role_name", "prompt", "max_edge"];

/* ----------------------------- 颜色 ----------------------------- */
const C = {
    primary: "#34d399",
    primaryStrong: "#10b981",
    wave: "#34d399",
    selectionBg: "rgba(52, 211, 153, 0.18)",
    selectionBorder: "#34d399",
    trimmedBg: "rgba(250, 204, 21, 0.20)",
    trimmedBorder: "#facc15",
    trimmedLabelBg: "rgba(250, 204, 21, 0.18)",
    textMuted: "rgba(255, 255, 255, 0.55)",
    text: "rgba(255, 255, 255, 0.92)",
    record: "#f87171",
    recordBg: "rgba(248, 113, 113, 0.18)",
    hover: "rgba(255, 255, 255, 0.10)",
    pill: "rgba(255, 255, 255, 0.05)",
    pillBorder: "rgba(255, 255, 255, 0.07)",
    panel: "rgba(255, 255, 255, 0.045)",
    panelBorder: "rgba(255, 255, 255, 0.08)",
    dropBg: "rgba(52, 211, 153, 0.16)",
    dropBorder: "#34d399",
};

const SVG = {
    upload: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    image: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
    mic: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>`,
    play: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>`,
    pause: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
    restore: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
    speaker: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
    speakerMute: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`,
    cut: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`,
    recording: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>`,
    close: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    zoom: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="16" y1="16" x2="21" y2="21"/></svg>`,
    // 剪贴板 + 向下箭头 = 粘贴
    clipboard: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2.5" width="8" height="4" rx="1"/><path d="M16 4.5h2a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h2"/><path d="M12 11v6"/><path d="M9.6 14.6 12 17l2.4-2.4"/></svg>`,
};

/* --------------------------------------------------------------------------
 * 「控件转输入」残留槽位清理
 *
 * ComfyUI 前端会给**每个控件**预建一个输入槽位（ComfyNode._arrangeWidgetInputSlots：
 * `n.pos = [10, widget.y + 10]`），用途是"把控件转成输入"。
 * 本节点把 audio_filename / trim_* / audio_muted / role_name / max_edge / upload
 * 这些原生控件都隐藏了（改用自绘 UI），它们的 y 都是 0 → 这些槽位全被摆到
 * **(10, 10)**，也就是节点左上角，叠成一小撮既看不清也用不上的圆点（用户报的就是这个）。
 *
 * 处理：默认**全部移除**（只留真接上线的那几条），并同步前端的 _concreteInputs 映射
 * （不更新的话前端 arrange() 会访问不到对应对象而抛 TypeError —— 实测过）。
 *
 * 如果以后想让某个控件重新可以接线（例如用文本节点往「资产描述」里喂值），
 * 把它的控件名加进 KEEP_SLOT_NAMES 即可，例如 KEEP_SLOT_NAMES = ["prompt"]。
 * ------------------------------------------------------------------------ */
const KEEP_SLOT_NAMES = [];
const MAX_KEPT_INPUTS = KEEP_SLOT_NAMES.length;

/** 移除「控件转输入」自动生成的残留槽位，返回移除个数。 */
function stripWidgetInputSlots(node) {
    if (!Array.isArray(node.inputs) || !node.inputs.length) return 0;
    const keep = node.inputs.filter((input) => input
        && (input.link != null || KEEP_SLOT_NAMES.includes(input.name)));
    const removed = node.inputs.length - keep.length;
    if (removed <= 0) return 0;
    node.inputs = keep;
    try {
        // 前端的槽位对象缓存必须一起刷新，否则它的 arrange() 会踩空
        node._setConcreteSlots?.();
    } catch (error) {
        console.warn("[AssetCard] 刷新输入槽缓存失败：", error);
    }
    node._widgetSlotsDirty = false;
    node.setDirtyCanvas?.(true, true);
    return removed;
}

app.registerExtension({
    name: "DN.AssetCard",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            this.properties = this.properties || {};
            this.pml_state = this.pml_state || {};

            const hasSize =
                Array.isArray(this.size) &&
                this.size[0] >= MIN_WIDTH &&
                this.size[1] >= MIN_HEIGHT &&
                this.size[0] <= SIZE_SANITY_MAX &&
                this.size[1] <= SIZE_SANITY_MAX;
            if (!hasSize) {
                this.setSize([NODE_WIDTH, DEFAULT_HEIGHT]);
            }
            this.setMinSize?.([MIN_WIDTH, MIN_HEIGHT]);

            collapseWidget(this, "audio_filename");
            collapseWidget(this, "trim_start");
            collapseWidget(this, "trim_end");
            collapseWidget(this, "audio_muted");
            // 角色名与最长边改由自定义行并排绘制：原生控件隐藏（仍参与序列化与后端读取），
            // 列表末尾顺序固定为 pml_ui → role_name → prompt → max_edge。
            collapseWidget(this, "role_name");
            collapseWidget(this, "max_edge");
            styleNativeTextWidget(this);
            hookImageCombo(this);
            hookRoleRowWidgets(this);
            hideBuiltinImagePreview(this);
            hideBuiltinUploadButton(this);
            buildUI(this);
            syncRoleRow(this);
            stripWidgetInputSlots(this);
            this.pml_clear_image = () => clearImage(this, false);
            this.pml_clear_audio = () => clearAudio(this, false);
            return r;
        };

        const origGetExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            const r = origGetExtraMenuOptions?.apply(this, arguments);
            options = options || [];
            if (!isEmptyImage(this.properties?.[PROP_IMAGE])) {
                options.push({
                    content: "Clear image",
                    callback: () => this.pml_clear_image?.(),
                });
            }
            if (this.properties?.[PROP_AUDIO]) {
                options.push({
                    content: "Clear audio",
                    callback: () => this.pml_clear_audio?.(),
                });
            }
            return r;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            const r = origOnConfigure?.apply(this, arguments);
            this.properties = this.properties || {};
            // 必须在读取控件值之前修正：ComfyUI 按位置还原 widgets_values，
            // 控件顺序一变旧工作流就会整体错位，这里按名字（widgets_values_named）再覆盖一次。
            restoreWidgetValues(this, info);

            const imgW = this.widgets?.find((w) => w.name === "image_filename");
            const fnW = this.widgets?.find((w) => w.name === "audio_filename");
            const tsW = this.widgets?.find((w) => w.name === "trim_start");
            const teW = this.widgets?.find((w) => w.name === "trim_end");
            const muteW = this.widgets?.find((w) => w.name === "audio_muted");

            this.properties[PROP_IMAGE] = imgW?.value || IMAGE_NONE;
            this.properties[PROP_AUDIO] = fnW?.value || "";
            this.properties[PROP_TRIM_START] = tsW?.value ?? 0;
            this.properties[PROP_TRIM_END] = teW?.value ?? -1;
            this.properties[PROP_AUDIO_MUTED] = !!muteW?.value;

            collapseWidget(this, "audio_filename");
            collapseWidget(this, "trim_start");
            collapseWidget(this, "trim_end");
            collapseWidget(this, "audio_muted");
            collapseWidget(this, "role_name");
            collapseWidget(this, "max_edge");
            styleNativeTextWidget(this);
            hookImageCombo(this);
            hookRoleRowWidgets(this);
            hideBuiltinImagePreview(this);
            hideBuiltinUploadButton(this);

            if (this.pml_built) {
                restoreImage(this);
                const fn = this.properties[PROP_AUDIO];
                if (fn) {
                    loadAndRender(this, fn).catch((err) =>
                        console.error("[H3MediaLoader] restore audio failed:", err)
                    );
                } else {
                    renderEmptyAudio(this);
                }
            } else {
                buildUI(this);
            }
            arrangeWidgets(this, null);
            syncRoleRow(this);
            stripWidgetInputSlots(this);
            return r;
        };

        const origOnSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            const r = origOnSerialize?.apply(this, arguments);
            o.properties = o.properties || {};
            o.properties[PROP_IMAGE] = this.properties?.[PROP_IMAGE] || IMAGE_NONE;
            o.properties[PROP_AUDIO] = this.properties?.[PROP_AUDIO] || "";
            o.properties[PROP_TRIM_START] = this.properties?.[PROP_TRIM_START] ?? 0;
            o.properties[PROP_TRIM_END] = this.properties?.[PROP_TRIM_END] ?? -1;
            o.properties[PROP_AUDIO_MUTED] = !!this.properties?.[PROP_AUDIO_MUTED];
            return r;
        };

        const origOnResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            const r = origOnResize?.apply(this, arguments);
            hideBuiltinImagePreview(this);
            hideBuiltinUploadButton(this);
            relayoutWaveform(this);
            this.pml_paintOverlay?.();
            styleNativeTextWidget(this);
            syncRoleRow(this);
            return r;
        };

        const origOnDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function () {
            hideBuiltinImagePreview(this);
            // 前端在 arrange() 里会重新给残留槽位定位 → 这里用一次长度判断兜住（开销可忽略）
            if ((this.inputs?.length || 0) > MAX_KEPT_INPUTS) stripWidgetInputSlots(this);
            return origOnDrawForeground?.apply(this, arguments);
        };

        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            const r = origOnRemoved?.apply(this, arguments);
            closeFullscreenImage(this);
            stopPlayheadLoop(this);
            this.pml_cleanupPlayback?.();
            this.pml_cleanupInteraction?.();
            this.pml_wfRO?.disconnect?.();
            if (this.pml_audioElement) {
                try { this.pml_audioElement.pause(); } catch (e) {}
                this.pml_audioElement = null;
            }
            return r;
        };
    },
});

/** 判断图像是否未选择。 */
function isEmptyImage(name) {
    if (name == null) return true;
    const text = String(name).trim();
    return text === "" || text === IMAGE_NONE || text === "none" || text === "None";
}

/** 完全隐藏指定控件，避免占用节点高度。 */
function collapseWidget(node, name) {
    const w = node.widgets?.find((x) => x.name === name);
    if (!w) return;
    w.hidden = true;
    w.computeSize = () => [0, -4];
    const hideEl = () => {
        if (w.element) w.element.style.display = "none";
    };
    hideEl();
    requestAnimationFrame(hideEl);
    setTimeout(hideEl, 60);
}

/** 计算 prompt 在当前节点高度下可以使用的剩余空间。 */
function getPromptHeight(node) {
    const nodeHeight = Number(node.size?.[1]);
    if (!Number.isFinite(nodeHeight)) return TEXT_WIDGET_MIN_H;
    return Math.max(
        TEXT_WIDGET_MIN_H,
        nodeHeight - CHROME - CONTENT_H - ROLE_NAME_TOP_GAP - TEXT_BOTTOM_GAP * 2 - TEXT_NODE_BOTTOM_MARGIN * 2 - TEXT_HEIGHT_OFFSET,
    );
}

/** 将 prompt 的实际 DOM 高度同步到当前节点尺寸。 */
function updatePromptLayout(node, widget) {
    const height = getPromptHeight(node);
    const elements = [widget.inputEl, widget.element];
    for (const el of elements) {
        if (!el) continue;
        el.style.height = `${height}px`;
        el.style.minHeight = "0";
        el.style.maxHeight = "none";
        el.style.flex = "1 1 auto";
        if (el.parentElement && el.parentElement !== el) {
            el.parentElement.style.height = `${height}px`;
            el.parentElement.style.minHeight = `${TEXT_WIDGET_MIN_H}px`;
            el.parentElement.style.maxHeight = "none";
            el.parentElement.style.flex = "1 1 auto";
            el.parentElement.style.marginBottom = `${TEXT_BOTTOM_GAP}px`;
        }
    }
}

/** 按 ComfyUI 原生多行 STRING 方式处理文本框，并同步节点缩放后的高度。 */
function styleNativeTextWidget(node) {
    const w = node.widgets?.find((x) => x && x.name === "prompt");
    if (!w) return;

    w.options = w.options || {};
    w.options.multiline = true;
    // computeSize 不能依赖 node.size，否则会触发节点高度持续增长的反馈循环。
    w.computeSize = function (width) {
        return [width || NODE_WIDTH, TEXT_WIDGET_MIN_H];
    };

    const styleEl = (el) => {
        if (!el) return;
        el.style.overflowY = "auto";
        el.style.resize = "none";
        el.style.boxSizing = "border-box";
        el.style.border = "1px solid rgba(125, 211, 252, 0.28)";
        el.style.outline = "none";
        el.style.boxShadow = "none";
        el.style.background = "rgba(8, 12, 20, 0.35)";
        el.style.borderRadius = `8px`;
        if (!el.dataset.pmlFocusBound) {
            el.dataset.pmlFocusBound = "1";
            el.addEventListener("focus", () => {
                el.style.border = "1px solid rgba(125, 211, 252, 0.95)";
                el.style.boxShadow = "0 0 0 2px rgba(56, 189, 248, 0.28)";
            });
            el.addEventListener("blur", () => {
                el.style.border = "1px solid rgba(125, 211, 252, 0.28)";
                el.style.boxShadow = "none";
            });
        }
    };

    styleEl(w.inputEl);
    styleEl(w.element);
    updatePromptLayout(node, w);
}

/** 屏蔽 LoadImage 风格 image_upload 在节点底部绘制的第二张预览。 */
function hideBuiltinImagePreview(node) {
    node.imgs = null;
    node.imageIndex = null;
    node.overIndex = null;
    if (Array.isArray(node.widgets)) {
        for (const w of node.widgets) {
            if (!w) continue;
            const name = String(w.name || "") + " " + String(w.type || "");
            if (/preview/i.test(name) && w.name !== "pml_ui") {
                w.hidden = true;
                w.computeSize = () => [0, -4];
                if (w.element) w.element.style.display = "none";
            }
        }
    }
}

/** 隐藏 ComfyUI image_upload 在节点底部生成的“选择要上传的文件”按钮。 */
function hideBuiltinUploadButton(node) {
    const kill = (el) => {
        if (!el) return;
        el.style.display = "none";
        el.style.visibility = "hidden";
        el.style.height = "0";
        el.style.width = "0";
        el.style.overflow = "hidden";
        el.style.pointerEvents = "none";
        el.setAttribute("hidden", "true");
    };
    const looksLikeUpload = (el) => {
        if (!el) return false;
        const text = ((el.textContent || "") + " " + (el.title || "") + " " + (el.value || "")).toLowerCase();
        if (/choose file to upload|选择要上传的文件|choose file|upload image/.test(text)) return true;
        if (el.tagName === "INPUT" && el.type === "file") return true;
        return false;
    };
    const walk = (root) => {
        if (!root) return;
        const nodes = root.querySelectorAll ? root.querySelectorAll("button, input, label, div, span") : [];
        for (const el of nodes) {
            if (looksLikeUpload(el)) {
                kill(el);
                if (el.parentElement && looksLikeUpload(el.parentElement)) kill(el.parentElement);
            }
        }
    };
    if (Array.isArray(node.widgets)) {
        for (const w of node.widgets) {
            if (!w) continue;
            const name = String(w.name || "") + " " + String(w.type || "") + " " + String(w.label || "");
            if (/upload/i.test(name) && w.name !== "pml_ui") {
                w.hidden = true;
                w.computeSize = () => [0, -4];
                if (w.element) kill(w.element);
            }
            walk(w.element);
            walk(w.inputEl);
        }
    }
    walk(node.pml_container?.parentElement);
}

/** 监听图像下拉，选择后同步预览。 */
function hookImageCombo(node) {
    const w = node.widgets?.find((x) => x.name === "image_filename");
    if (!w || w.pml_hooked) return;
    w.pml_hooked = true;
    const orig = w.callback;
    w.callback = function (value) {
        if (node.pml_applyingImage) return;
        const r = orig?.apply(this, arguments);
        applyImageSelection(node, value);
        return r;
    };
}

/** 按名称取原生控件。 */
function findWidget(node, name) {
    return node.widgets?.find((w) => w && w.name === name) || null;
}

/**
 * 把 DOM 容器、角色名、prompt、「最长边」按固定顺序排到控件列表末尾。
 *
 * 顺序固定为 [..., pml_ui, role_name, prompt, max_edge]，这样：
 * - 显示顺序 = 图像下拉 → 图像/音频区 →（自定义行：角色名 + 最长边）→ prompt
 * - widgets_values 前 9 位与旧版本（没有「最长边」时）逐一对应，旧工作流不会整体错位
 * - 隐藏的原生 role_name / max_edge 不影响显示，但值仍会被序列化并传给后端
 */
function arrangeWidgets(node, uiWidget) {
    if (!node.widgets) return;
    if (uiWidget && !node.widgets.includes(uiWidget)) {
        node.widgets.push(uiWidget);
    }
    const tail = [];
    for (const name of TAIL_WIDGET_ORDER) {
        const index = node.widgets.findIndex((w) => w && w.name === name);
        if (index >= 0) tail.push(node.widgets.splice(index, 1)[0]);
    }
    for (const widget of tail) node.widgets.push(widget);
}

/** 把「最长边」收敛到合法整数区间。 */
function clampMaxEdge(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return MAX_EDGE_DEFAULT;
    return Math.min(MAX_EDGE_MAX, Math.max(MAX_EDGE_MIN, Math.round(parsed)));
}

/**
 * 还原控件值。
 *
 * ComfyUI 默认（namedValuesRestore = false）按「位置」把 widgets_values 灌进控件，
 * 只要控件数量/顺序变化过，旧工作流就会整体错位——这正是之前 prompt 跑进「角色名」的原因。
 * 这里在按位置还原之后再按名字（widgets_values_named）覆盖一遍，彻底免疫顺序变化。
 */
function restoreWidgetValues(node, info) {
    if (!node || !node.widgets) return;
    const named = info?.widgets_values_named || node.widgets_values_named;
    if (named && typeof named === "object") {
        for (const widget of node.widgets) {
            if (!widget || widget.serialize === false) continue;
            if (Object.prototype.hasOwnProperty.call(named, widget.name)) {
                widget.value = named[widget.name];
            }
        }
    }
    // 老工作流里没有 max_edge：错位时这里可能拿到字符串，统一清洗成合法整数或默认值。
    const edgeWidget = findWidget(node, "max_edge");
    if (edgeWidget) edgeWidget.value = clampMaxEdge(edgeWidget.value);
}

/** 把原生控件的值变化同步到自定义行（例如被外部脚本改写、或从 input 连回来）。 */
function hookRoleRowWidgets(node) {
    for (const name of ["role_name", "max_edge"]) {
        const widget = findWidget(node, name);
        if (!widget || widget.pml_roleHooked) continue;
        widget.pml_roleHooked = true;
        const orig = widget.callback;
        widget.callback = function () {
            const r = orig?.apply(this, arguments);
            syncRoleRow(node);
            return r;
        };
    }
}

/** 输入框边框/背景样式，与原生多行 prompt 保持一致。 */
function applyRowInputStyle(el) {
    if (!el) return;
    el.style.height = "24px";
    el.style.boxSizing = "border-box";
    el.style.border = "1px solid rgba(125, 211, 252, 0.28)";
    el.style.outline = "none";
    el.style.boxShadow = "none";
    el.style.background = "rgba(8, 12, 20, 0.35)";
    el.style.borderRadius = "8px";
    el.style.color = C.text;
    el.style.fontSize = "11px";
    el.style.fontFamily = "inherit";
    el.style.padding = "0 8px";
    el.style.userSelect = "text";
    el.style.webkitUserSelect = "text";
    if (!el.dataset.pmlRowFocusBound) {
        el.dataset.pmlRowFocusBound = "1";
        el.addEventListener("focus", () => {
            el.style.border = "1px solid rgba(125, 211, 252, 0.95)";
            el.style.boxShadow = "0 0 0 2px rgba(56, 189, 248, 0.28)";
        });
        el.addEventListener("blur", () => {
            el.style.border = "1px solid rgba(125, 211, 252, 0.28)";
            el.style.boxShadow = "none";
        });
    }
}

/** 行内标签。 */
function buildRowLabel(text) {
    const label = document.createElement("span");
    label.textContent = text;
    label.style.cssText = `
        flex: 0 0 auto;
        font-size: 11px;
        color: ${C.textMuted};
        white-space: nowrap;
        user-select: none;
        -webkit-user-select: none;
    `;
    return label;
}

/** 构建「角色名 + 最长边」行：两者并排显示，值写回隐藏的原生控件。 */
function buildRoleRow(node) {
    const row = document.createElement("div");
    row.className = "pml-role-row";
    row.style.cssText = `
        display: flex;
        align-items: center;
        gap: ${ROLE_ROW_GAP}px;
        width: 100%;
        height: ${ROLE_ROW_H}px;
        min-height: ${ROLE_ROW_H}px;
        max-height: ${ROLE_ROW_H}px;
        box-sizing: border-box;
        flex: 0 0 auto;
    `;

    const roleLabel = buildRowLabel("资产名");
    const roleInput = document.createElement("input");
    roleInput.type = "text";
    roleInput.spellcheck = false;
    roleInput.placeholder = "资产名";
    roleInput.className = "pml-role-name-input";
    roleInput.style.cssText = "flex: 1 1 auto; min-width: 0; width: 100%;";
    applyRowInputStyle(roleInput);

    const edgeLabel = buildRowLabel("最长边");
    const edgeInput = document.createElement("input");
    edgeInput.type = "number";
    edgeInput.min = String(MAX_EDGE_MIN);
    edgeInput.max = String(MAX_EDGE_MAX);
    edgeInput.step = "1";
    edgeInput.className = "pml-max-edge-input";
    edgeInput.title = "参考图最长边上限（像素），超出则等比缩小，绝不放大";
    edgeInput.style.cssText = `
        flex: 0 0 ${MAX_EDGE_W}px;
        width: ${MAX_EDGE_W}px;
        text-align: right;
        font-variant-numeric: tabular-nums;
    `;
    applyRowInputStyle(edgeInput);

    row.appendChild(roleLabel);
    row.appendChild(roleInput);
    row.appendChild(edgeLabel);
    row.appendChild(edgeInput);
    node.pml_roleRow = { row, roleLabel, roleInput, edgeLabel, edgeInput };

    roleInput.addEventListener("input", () => setRoleName(node, roleInput.value));
    roleInput.addEventListener("change", () => setRoleName(node, roleInput.value));
    edgeInput.addEventListener("input", () => {
        if (edgeInput.value === "") return;
        setMaxEdge(node, edgeInput.value);
    });
    edgeInput.addEventListener("change", () => {
        setMaxEdge(node, edgeInput.value);
        edgeInput.value = String(edgeWidgetValue(node));
    });
    edgeInput.addEventListener("blur", () => {
        edgeInput.value = String(edgeWidgetValue(node));
    });
    edgeInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") edgeInput.blur();
    });
    return row;
}

/** 读取「最长边」当前生效值。 */
function edgeWidgetValue(node) {
    const widget = findWidget(node, "max_edge");
    return widget ? clampMaxEdge(widget.value) : MAX_EDGE_DEFAULT;
}

/** 写入角色名到隐藏的原生控件。 */
function setRoleName(node, value) {
    const widget = findWidget(node, "role_name");
    if (!widget || widget.value === value) return;
    widget.value = value;
    markGraphDirty(node);
    try { app.graph?.afterChange?.(); } catch (e) {}
}

/** 写入最长边到隐藏的原生控件（空输入不写回，避免打字中途变成默认值）。 */
function setMaxEdge(node, raw) {
    const widget = findWidget(node, "max_edge");
    if (!widget || raw === "" || raw == null) return;
    if (!Number.isFinite(Number(raw))) return;
    const value = clampMaxEdge(raw);
    if (widget.value === value) return;
    widget.value = value;
    markGraphDirty(node);
    try { app.graph?.afterChange?.(); } catch (e) {}
}

/** 把原生控件值同步到自定义行；正在编辑的输入框不覆盖。 */
function syncRoleRow(node) {
    const refs = node.pml_roleRow;
    if (!refs) return;
    const roleWidget = findWidget(node, "role_name");
    const roleValue = roleWidget ? String(roleWidget.value ?? "") : "";
    const edgeValue = String(edgeWidgetValue(node));

    const show = (el, visible) => {
        if (el) el.style.display = visible ? "" : "none";
    };
    // 角色名被「转成输入」后原生控件会消失，此时隐藏自定义输入框，只保留最长边。
    show(refs.roleInput, !!roleWidget);
    show(refs.roleLabel, !!roleWidget);
    if (document.activeElement !== refs.roleInput && refs.roleInput.value !== roleValue) {
        refs.roleInput.value = roleValue;
    }
    if (document.activeElement !== refs.edgeInput && refs.edgeInput.value !== edgeValue) {
        refs.edgeInput.value = edgeValue;
    }
}

/** 构建图像预览与音频波形的 DOM 控件。 */
function buildUI(node) {
    if (node.pml_built) return;
    node.pml_built = true;

    const container = document.createElement("div");
    container.className = "pml-container";
    container.style.cssText = `
        width: 100%;
        height: ${CONTENT_H}px;
        min-height: ${CONTENT_H}px;
        max-height: ${CONTENT_H}px;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
        align-items: stretch;
        gap: ${GAP}px;
        padding: ${PAD_Y}px ${PAD_X}px 12px;
        background: transparent;
        border: none;
        overflow: hidden;
        user-select: none;
        -webkit-user-select: none;
        color: ${C.text};
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        position: relative;
        flex: 0 0 auto;
    `;

    const uiWidget = node.addDOMWidget("pml_ui", "media_ui", container, {
        serialize: false,
        hideOnZoom: false,
    });
    if (uiWidget) {
        uiWidget.computeSize = function (width) {
            return [width || NODE_WIDTH, CONTENT_H + ROLE_NAME_TOP_GAP];
        };
        arrangeWidgets(node, uiWidget);
    }

    node.pml_container = container;
    container.appendChild(buildImageSection(node));

    const audioSection = document.createElement("div");
    audioSection.className = "pml-audio-section";
    audioSection.style.cssText = `
        position: relative;
        display: flex;
        flex-direction: column;
        gap: ${AUDIO_GAP}px;
        flex: 0 0 auto;
        min-height: ${AUDIO_BLOCK_H}px;
        box-sizing: border-box;
        padding: ${AUDIO_PADDING}px;
        border: 1px solid ${C.panelBorder};
        border-radius: 8px;
        background: rgba(24, 24, 24, 0.62);
        overflow: hidden;
        transition: background 0.12s, outline-color 0.12s, box-shadow 0.12s;
    `;
    const audioBody = document.createElement("div");
    audioBody.className = "pml-audio-body";
    audioSection.appendChild(audioBody);
    const audioClearBtn = mkIconBtn(SVG.close, "Clear audio", C.textMuted);
    audioClearBtn.style.cssText += `
        position: absolute;
        top: 8px;
        right: 8px;
        display: none;
        background: rgba(0,0,0,0.45);
        z-index: 3;
    `;
    audioClearBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearAudio(node, true);
    };
    audioSection.appendChild(audioClearBtn);
    const controls = buildControlsRow(node);
    audioSection.appendChild(controls);
    container.appendChild(audioSection);

    node.pml_audioSection = audioSection;
    node.pml_body = audioBody;
    node.pml_controls = controls;
    node.pml_audioClearBtn = audioClearBtn;
    bindAudioDrop(node, audioSection);

    // 角色名与最长边并排一行，紧跟在音频区下方。
    container.appendChild(buildRoleRow(node));

    restoreImage(node);
    const fn = node.properties?.[PROP_AUDIO];
    if (fn) {
        loadAndRender(node, fn).catch((err) =>
            console.error("[H3MediaLoader] initial audio load failed:", err)
        );
    } else {
        renderEmptyAudio(node);
    }
    styleNativeTextWidget(node);
    arrangeWidgets(node, null);
    syncRoleRow(node);
}

/** 构建图像预览区域。 */
function buildImageSection(node) {
    const section = document.createElement("div");
    section.className = "pml-image";
    section.style.cssText = `
        position: relative;
        width: 100%;
        height: ${IMAGE_H}px;
        min-height: ${IMAGE_H}px;
        max-height: ${IMAGE_H}px;
        flex: 0 0 ${IMAGE_H}px;
        box-sizing: border-box;
        background: ${C.panel};
        outline: 1px solid ${C.panelBorder};
        outline-offset: -1px;
        border-radius: 8px;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: outline-color 0.12s, background 0.12s;
    `;

    const empty = document.createElement("div");
    empty.style.cssText = `
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        color: ${C.textMuted};
        pointer-events: none;
    `;
    empty.innerHTML = SVG.image;
    const emptyLabel = document.createElement("div");
    emptyLabel.textContent = "拖入参考图像 / Drop upload audio";
    emptyLabel.style.cssText = "font-size: 11px;";
    empty.appendChild(emptyLabel);

    const preview = document.createElement("img");
    preview.alt = "media image";
    preview.style.cssText = `
        display: none;
        max-width: 100%;
        max-height: 100%;
        width: auto;
        height: auto;
        object-fit: contain;
        pointer-events: none;
    `;

    const sizeBadge = document.createElement("div");
    sizeBadge.style.cssText = `
        position: absolute;
        left: 8px;
        bottom: 8px;
        display: none;
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.55);
        color: rgba(255,255,255,0.92);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        pointer-events: none;
        z-index: 2;
    `;

    const imageActionGroup = document.createElement("div");
    imageActionGroup.style.cssText = `
        position: absolute;
        top: 6px;
        right: 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        z-index: 2;
    `;

    const clearBtn = mkIconBtn(SVG.close, "Clear image", C.textMuted);
    clearBtn.style.cssText += `
        display: flex;
        justify-content: center;
        align-items: center;
        background: rgba(0,0,0,0.45);
    `;

    const zoomBtn = mkIconBtn(SVG.zoom, "View fullscreen", C.textMuted);
    zoomBtn.style.cssText += `
        display: flex;
        justify-content: center;
        align-items: center;
        background: rgba(0,0,0,0.45);
    `;
    zoomBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openFullscreenImage(node, preview.src);
    };

    // 粘贴按钮：常驻显示（空图时也能用），把剪贴板里的图片直接写进 input 目录
    const pasteBtn = mkIconBtn(SVG.clipboard, PASTE_TITLE, C.textMuted);
    pasteBtn.style.cssText += `
        display: flex;
        justify-content: center;
        align-items: center;
        background: rgba(0,0,0,0.45);
    `;
    pasteBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        pasteImageFromClipboard(node, pasteBtn);
    };

    // 兜底：图片区（或它上面的任何层）抢走了命中时，按坐标再判一次。
    // 实测节点 DOM widget 里，覆盖层可能让按钮自身收不到 click（连自带的清空/放大也一样），
    // 而 section 永远能收到（拖放就靠它），所以这里按矩形判定补一次。
    const onSectionClick = (e) => {
        if (node.pml_pasting) return;
        const r = pasteBtn.getBoundingClientRect();
        if (!r.width) return;
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
        if (Date.now() - (node.pml_lastPasteAt || 0) < 800) return;   // 与按钮自身的 onclick 去重
        node.pml_lastPasteAt = Date.now();
        e.preventDefault();
        e.stopPropagation();
        pasteImageFromClipboard(node, pasteBtn);
    };
    section.addEventListener("click", onSectionClick);   // 只挂 click：拖放结束不会产生 click，不会误触发

    // 鼠标停在图片区上 → 直接 Ctrl+V 也能粘贴（完全不依赖按钮是否被点中）
    section.addEventListener("mouseenter", () => { node.pml_imageHovered = true; });
    section.addEventListener("mouseleave", () => { node.pml_imageHovered = false; });
    installGlobalPasteShortcut();

    imageActionGroup.appendChild(pasteBtn);
    imageActionGroup.appendChild(clearBtn);
    imageActionGroup.appendChild(zoomBtn);
    section.appendChild(empty);
    section.appendChild(preview);
    section.appendChild(sizeBadge);
    section.appendChild(imageActionGroup);
    node.pml_imageRefs = { section, empty, preview, sizeBadge, clearBtn, zoomBtn, pasteBtn };

    clearBtn.onclick = (e) => {
        e.stopPropagation();
        clearImage(node, true);
    };

    section.ondragover = (e) => {
        const file = e.dataTransfer?.files?.[0] || e.dataTransfer?.items?.[0];
        if (file && (file.type || "").startsWith("image/")) {
            e.preventDefault();
            e.stopPropagation();
            section.style.outlineColor = C.dropBorder;
            section.style.background = C.dropBg;
        }
    };
    section.ondragleave = () => {
        section.style.outlineColor = C.panelBorder;
        section.style.background = C.panel;
    };
    section.ondrop = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        section.style.outlineColor = C.panelBorder;
        section.style.background = C.panel;
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        if (file.type.startsWith("image/")) {
            try {
                await handleImageFile(node, file);
            } catch (err) {
                console.error(err);
                alert("Image upload failed: " + err.message);
            }
        } else if (file.type.startsWith("audio/")) {
            try {
                await handleAudioFile(node, file);
            } catch (err) {
                console.error(err);
                alert("Audio upload failed: " + err.message);
            }
        }
    };
    return section;
}

/** 绑定音频区域拖放与高亮。 */
function bindAudioDrop(node, section) {
    const setHighlight = (on) => {
        if (on) {
            section.style.background = C.dropBg;
            section.style.outline = `1px solid ${C.dropBorder}`;
            section.style.outlineOffset = "-1px";
            section.style.boxShadow = `inset 0 0 0 1px ${C.dropBorder}`;
        } else {
            section.style.background = "transparent";
            section.style.outline = "none";
            section.style.boxShadow = "none";
        }
    };
    const hasAudio = (e) => {
        const items = e.dataTransfer?.items;
        if (items && items.length) {
            for (const item of items) {
                if ((item.type || "").startsWith("audio/")) return true;
            }
        }
        const files = e.dataTransfer?.files;
        if (files && files.length) {
            for (const file of files) {
                if ((file.type || "").startsWith("audio/") || /\.(wav|mp3|flac|ogg|m4a|aac|wma)$/i.test(file.name || "")) {
                    return true;
                }
            }
        }
        const types = e.dataTransfer?.types;
        return types && (types.includes("Files") || types.contains?.("Files"));
    };

    section.addEventListener("dragenter", (e) => {
        if (!hasAudio(e)) return;
        e.preventDefault();
        e.stopPropagation();
        node.pml_audioDragCount = (node.pml_audioDragCount || 0) + 1;
        setHighlight(true);
    });
    section.addEventListener("dragover", (e) => {
        if (!hasAudio(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setHighlight(true);
    });
    section.addEventListener("dragleave", (e) => {
        e.stopPropagation();
        node.pml_audioDragCount = Math.max(0, (node.pml_audioDragCount || 1) - 1);
        if (!node.pml_audioDragCount) setHighlight(false);
    });
    section.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        node.pml_audioDragCount = 0;
        setHighlight(false);
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        if (file.type.startsWith("audio/") || /\.(wav|mp3|flac|ogg|m4a|aac|wma)$/i.test(file.name || "")) {
            try {
                await handleAudioFile(node, file);
            } catch (err) {
                console.error(err);
                alert("Upload failed: " + err.message);
            }
        } else if (file.type.startsWith("image/")) {
            try {
                await handleImageFile(node, file);
            } catch (err) {
                console.error(err);
                alert("Image upload failed: " + err.message);
            }
        }
    });
}

/** 构造圆角按钮组样式。 */
function pillStyle() {
    return `
        display: flex;
        align-items: center;
        gap: 2px;
        background: transparent;
        border: none;
        border-radius: 6px;
        padding: 0;
        flex: 0 0 auto;
    `;
}

/** 构造统一尺寸的音频图标按钮基础样式。 */
function iconBtnStyle(color) {
    return `
        width: 18px;
        height: 18px;
        min-width: 18px;
        min-height: 18px;
        box-sizing: border-box;
        background: transparent;
        border: none;
        cursor: pointer;
        color: ${color};
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        transition: background 0.15s, color 0.15s;
        flex: 0 0 28px;
    `;
}

/** 创建带悬停效果的图标按钮。 */
function mkIconBtn(icon, title, color) {
    const btn = document.createElement("button");
    btn.innerHTML = icon;
    btn.title = title;
    btn.style.cssText = iconBtnStyle(color || C.text);
    btn.onmouseenter = () => (btn.style.background = C.hover);
    btn.onmouseleave = () => (btn.style.background = "transparent");
    return btn;
}

/** 构建音频控制条。 */
function buildControlsRow(node) {
    const row = document.createElement("div");
    row.className = "pml-controls";
    row.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: center;
        flex-wrap: nowrap;
        margin-top: 4px;
        gap: 8px;
        width: 100%;
        height: ${CTRLROW_H}px;
        padding: 2px 2px;
        box-sizing: border-box;
        background: transparent;
        overflow: hidden;
        flex: 0 0 auto;
    `;

    const tCur = document.createElement("span");
    tCur.style.cssText = `
        font-size: 10px; color: ${C.textMuted}; font-variant-numeric: tabular-nums;
        min-width: 28px; display: none; flex: 0 0 auto;
    `;
    tCur.textContent = "0:00";

    const tDur = document.createElement("span");
    tDur.style.cssText = `
        font-size: 10px; color: ${C.textMuted}; font-variant-numeric: tabular-nums;
        min-width: 28px; text-align: right; display: none; flex: 0 0 auto;
    `;
    tDur.textContent = "0:00";

    const playGroup = document.createElement("div");
    playGroup.style.cssText = pillStyle();
    playGroup.style.display = "none";
    const speakerBtn = mkIconBtn(SVG.speaker, "Mute", C.text);
    const playBtn = mkIconBtn(SVG.play, "Play / Pause", C.text);
    const restoreBtn = mkIconBtn(SVG.restore, "Restore original (clear all trims)", C.text);
    const cutBtn = mkIconBtn(SVG.cut, "Confirm trim", C.text);
    [speakerBtn, playBtn, restoreBtn, cutBtn].forEach((b) => playGroup.appendChild(b));

    const fileGroup = document.createElement("div");
    fileGroup.style.cssText = pillStyle();
    const uploadBtn = mkIconBtn(SVG.upload, "Upload audio", C.primary);
    const micBtn = mkIconBtn(SVG.mic, "Record from microphone", C.primary);
    micBtn.onmouseleave = () => {
        if (!(node.pml_recorder && node.pml_recorder.state === "recording")) {
            micBtn.style.background = "transparent";
        }
    };
    fileGroup.appendChild(uploadBtn);
    fileGroup.appendChild(micBtn);

    row.appendChild(tCur);
    row.appendChild(playGroup);
    row.appendChild(fileGroup);
    row.appendChild(tDur);

    node.pml_refs = node.pml_refs || {};
    Object.assign(node.pml_refs, {
        tCur, tDur, playGroup, fileGroup,
        speakerBtn, playBtn, restoreBtn, cutBtn, uploadBtn, micBtn,
    });
    setupControls(node);
    return row;
}

/** 读取图像下拉当前可选值，兼容数组与函数形式。 */
function getComboValues(widget) {
    const raw = widget?.options?.values;
    if (typeof raw === "function") {
        try {
            const result = raw();
            return Array.isArray(result) ? result.slice() : [];
        } catch (e) {
            return [];
        }
    }
    return Array.isArray(raw) ? raw : [];
}

/** 给图像下拉补充新上传的文件名，并返回该控件。 */
function ensureComboOption(node, name) {
    const w = node.widgets?.find((x) => x.name === "image_filename");
    if (!w || !name) return null;
    w.options = w.options || {};
    const values = getComboValues(w);
    if (!values.includes(name)) values.push(name);
    w.options.values = values;
    return w;
}

/** 把 combo 的实际选中值写成指定文件名。 */
function setComboValue(widget, name) {
    if (!widget) return;
    widget.value = name;
    if (widget.widget && widget.widget !== widget) {
        widget.widget.value = name;
    }
    const el = widget.inputEl || widget.element;
    if (el && "value" in el) el.value = name;
}

/** 同步下拉、属性与预览。 */
function applyImageSelection(node, filename) {
    const name = isEmptyImage(filename) ? IMAGE_NONE : String(filename);
    node.properties[PROP_IMAGE] = name;
    const widget = ensureComboOption(node, name);
    if (widget) setComboValue(widget, name);
    else setRequiredWidget(node, "image_filename", name);
    markGraphDirty(node);
    try { app.graph?.afterChange?.(); } catch (e) {}
    hideBuiltinImagePreview(node);
    if (isEmptyImage(name)) showImageEmpty(node);
    else showImagePreview(node, name);
}

/** 强制把下拉选中项改成实际上传后的文件名，避免仍停在原名。 */
function selectUploadedImage(node, filename) {
    const name = isEmptyImage(filename) ? IMAGE_NONE : String(filename);
    node.pml_applyingImage = true;
    const apply = () => applyImageSelection(node, name);
    apply();
    requestAnimationFrame(() => {
        apply();
        node.pml_applyingImage = false;
    });
}

/** 上传图像到 input 目录并刷新下拉与预览。 */
async function handleImageFile(node, file) {
    let filename = file.name || "image.png";
    if (!/\.[a-z0-9]+$/i.test(filename)) filename += ".png";
    const savedName = await uploadImageToInput(file, filename);
    selectUploadedImage(node, savedName);
}

/* ================================================================
 * 剪贴板粘贴图片
 * ================================================================ */

/** 粘贴用的文件名：`clipboard-20260917-113045-123.png`。
 *  后端按内容 MD5 去重，所以重复粘同一张图不会堆文件。 */
function pasteFileName(mime) {
    const ext = PASTE_MIME_EXT[String(mime || "").toLowerCase()] || "png";
    const d = new Date();
    const pad = (n, width) => String(n).padStart(width || 2, "0");
    return "clipboard-"
        + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
        + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
        + "-" + pad(d.getMilliseconds(), 3) + "." + ext;
}

/** 把剪贴板/拖放里的原始图片换成带我们自己文件名的 File。 */
function asPasteFile(raw) {
    const type = raw.type || "image/png";
    return new File([raw], pasteFileName(type), { type });
}

/** 从 DataTransfer 里挑第一张图片（paste 事件用）。 */
function pickImageFromDataTransfer(dt) {
    if (!dt) return null;
    for (const file of Array.from(dt.files || [])) {
        if ((file.type || "").startsWith("image/")) return file;
    }
    for (const item of Array.from(dt.items || [])) {
        if (item.kind !== "file") continue;
        if (!String(item.type || "").startsWith("image/")) continue;
        const file = item.getAsFile?.();
        if (file) return file;
    }
    return null;
}

/** 图片区上的一条轻提示（不打断操作，2.4 秒后淡出）。 */
function flashImageTip(node, text, tone) {
    const section = node.pml_imageRefs?.section;
    if (!section) return;
    let tip = section.querySelector(".pml-paste-tip");
    if (!tip) {
        tip = document.createElement("div");
        tip.className = "pml-paste-tip";
        tip.style.cssText = `
            position: absolute;
            left: 50%;
            top: 6px;
            transform: translateX(-50%);
            z-index: 3;
            padding: 3px 10px;
            border-radius: 999px;
            font-size: 11px;
            white-space: nowrap;
            background: rgba(0,0,0,0.72);
            color: #fff;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.15s;
        `;
        section.appendChild(tip);
    }
    tip.textContent = text;
    if (tone === "error") tip.style.color = "#ffb4b4";
    else if (tone === "ok") tip.style.color = "#b8f5c4";
    else tip.style.color = "#fff";
    tip.style.opacity = "1";
    clearTimeout(tip.pmlTimer);
    tip.pmlTimer = setTimeout(() => { tip.style.opacity = "0"; }, 2400);
}

/** 读剪贴板里的图片。
 *  返回 `{ file }`；拿不到时给出 `reason`：
 *  - `unsupported`：浏览器没有 Clipboard API 的 read()（Firefox 等）
 *  - `denied`：没有授权 / 用户拒绝 / 页面未聚焦
 *  - `no-image`：剪贴板里没有图片（比如只是文本）
 */
async function readClipboardImage() {
    const clip = navigator.clipboard;
    if (!clip || typeof clip.read !== "function") return { reason: "unsupported" };
    let items;
    try {
        items = await clip.read();
    } catch (err) {
        console.warn("[H3MediaLoader] clipboard.read() 失败：", err);
        return { reason: "denied" };
    }
    let sawItem = false;
    for (const item of Array.from(items || [])) {
        sawItem = true;
        const type = (item.types || []).find((t) => String(t).startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        return { file: asPasteFile(blob) };
    }
    return { reason: sawItem ? "no-image" : "empty" };
}

/** 兜底：等用户按一次 Ctrl+V（浏览器不给读剪贴板时用）。
 *  捕获阶段拦下事件，避免 ComfyUI 前端顺手把图片贴到画布上。 */
function armPasteOnce(node, btn) {
    if (node.pml_pasteArmed) return false;
    node.pml_pasteArmed = true;
    let timer = null;
    const cleanup = () => {
        window.removeEventListener("paste", onPaste, true);
        clearTimeout(timer);
        node.pml_pasteArmed = false;
        node.pml_pasteCancel = null;
        if (btn) {
            btn.style.color = C.textMuted;
            btn.title = PASTE_TITLE;
        }
    };
    node.pml_pasteCancel = cleanup;
    const onPaste = (event) => {
        const raw = pickImageFromDataTransfer(event.clipboardData);
        if (!raw) return;                      // 不是图片就不管（让前端按自己的逻辑处理）
        event.preventDefault();
        event.stopImmediatePropagation();
        cleanup();
        flashImageTip(node, "正在上传图片…");
        handleImageFile(node, asPasteFile(raw))
            .then(() => flashImageTip(node, "已从剪贴板粘贴图片", "ok"))
            .catch((err) => {
                console.error(err);
                flashImageTip(node, "粘贴失败：" + err.message, "error");
            });
    };
    window.addEventListener("paste", onPaste, true);
    timer = setTimeout(() => {
        cleanup();
        flashImageTip(node, "没收到 Ctrl+V，粘贴已取消", "error");
    }, PASTE_WAIT_MS);
    if (btn) {
        btn.style.color = "#f5b942";
        btn.title = PASTE_HINT_ARMED;
    }
    flashImageTip(node, "请按 Ctrl+V 粘贴图片");
    return false;
}

/** 鼠标停在图片区时，Ctrl+V 直接粘贴图片（比按钮更省事，也不受"按钮被上层元素挡住"影响）。
 *  只处理"剪贴板里真是图片、且鼠标正停在某个 H3MediaLoader 图片区上"的情况，其余一概不拦。 */
function installGlobalPasteShortcut() {
    if (window.__pmlGlobalPaste) return;
    window.__pmlGlobalPaste = true;
    window.addEventListener("paste", (event) => {
        const raw = pickImageFromDataTransfer(event.clipboardData);
        if (!raw) return;
        const node = (app.graph?._nodes || []).find((n) => n.pml_imageHovered);
        if (!node) return;                       // 鼠标不在任何图片区上 → 交给前端原本的逻辑
        event.preventDefault();
        event.stopImmediatePropagation();
        node.pml_pasteCancel?.();                // 若此前点过按钮在等 Ctrl+V，这里已经粘上了，撤掉等待态
        flashImageTip(node, "正在上传图片…");
        handleImageFile(node, asPasteFile(raw))
            .then(() => flashImageTip(node, "已从剪贴板粘贴图片", "ok"))
            .catch((err) => {
                console.error(err);
                flashImageTip(node, "粘贴失败：" + err.message, "error");
            });
    }, true);
}

/** 点「粘贴」按钮：先走 Clipboard API，拿不到再引导一次 Ctrl+V。 */async function pasteImageFromClipboard(node, btn) {
    if (node.pml_pasting) return;
    node.pml_pasting = true;
    node.pml_lastPasteAt = Date.now();      // 给"按钮自身 click"与"图片区坐标兜底"去重
    if (btn) btn.style.color = "#f5b942";
    try {
        const result = await readClipboardImage();
        if (result.file) {
            flashImageTip(node, "正在上传图片…");
            await handleImageFile(node, result.file);
            flashImageTip(node, "已从剪贴板粘贴图片", "ok");
            return;
        }
        if (result.reason === "no-image" || result.reason === "empty") {
            flashImageTip(node, "剪贴板里没有图片（先截图或复制一张图）", "error");
            return;
        }
        // unsupported / denied → 让用户按一次 Ctrl+V
        armPasteOnce(node, btn);
    } catch (err) {
        console.error(err);
        flashImageTip(node, "粘贴失败：" + err.message, "error");
    } finally {
        node.pml_pasting = false;
        if (btn && !node.pml_pasteArmed) btn.style.color = C.textMuted;
    }
}

/** 根据已保存文件名恢复图像预览。 */
function restoreImage(node) {
    const name = node.properties?.[PROP_IMAGE] || "";
    if (isEmptyImage(name)) showImageEmpty(node);
    else showImagePreview(node, name);
}

/** 打开全屏图像预览。 */
function openFullscreenImage(node, src) {
    if (!src) return;
    closeFullscreenImage(node);

    const overlay = document.createElement("div");
    overlay.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        box-sizing: border-box;
        background: rgba(0, 0, 0, 0.86);
        cursor: zoom-out;
    `;

    const image = document.createElement("img");
    image.src = src;
    image.alt = "fullscreen media image";
    image.style.cssText = `
        display: block;
        max-width: 100%;
        max-height: 100%;
        width: auto;
        height: auto;
        object-fit: contain;
        cursor: default;
        user-select: none;
    `;
    image.onclick = (e) => e.stopPropagation();

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.title = "Close fullscreen preview";
    closeBtn.style.cssText = `
        position: absolute;
        top: 16px;
        right: 16px;
        width: 32px;
        height: 32px;
        padding: 0;
        border: 1px solid rgba(255,255,255,0.35);
        border-radius: 50%;
        color: white;
        background: rgba(0,0,0,0.5);
        font-size: 24px;
        line-height: 26px;
        cursor: pointer;
    `;
    closeBtn.onclick = (e) => {
        e.stopPropagation();
        closeFullscreenImage(node);
    };

    overlay.appendChild(image);
    overlay.appendChild(closeBtn);
    overlay.onclick = () => closeFullscreenImage(node);
    document.body.appendChild(overlay);

    const onKeyDown = (e) => {
        if (e.key === "Escape") closeFullscreenImage(node);
    };
    document.addEventListener("keydown", onKeyDown);
    node.pml_fullscreenImage = { overlay, onKeyDown };
}

/** 关闭并清理全屏图像预览。 */
function closeFullscreenImage(node) {
    const preview = node.pml_fullscreenImage;
    if (!preview) return;
    document.removeEventListener("keydown", preview.onKeyDown);
    preview.overlay.remove();
    node.pml_fullscreenImage = null;
}

/** 显示图像空态。 */
function showImageEmpty(node) {
    const refs = node.pml_imageRefs;
    if (!refs) return;
    refs.empty.style.display = "flex";
    refs.preview.style.display = "none";
    refs.preview.removeAttribute("src");
    refs.preview.onload = null;
    refs.clearBtn.style.display = "none";
    if (refs.zoomBtn) refs.zoomBtn.style.display = "none";
    if (refs.sizeBadge) {
        refs.sizeBadge.style.display = "none";
        refs.sizeBadge.textContent = "";
    }
}

/** 显示已加载图像预览。 */
function showImagePreview(node, filename) {
    const refs = node.pml_imageRefs;
    if (!refs) return;
    refs.empty.style.display = "none";
    refs.preview.style.display = "block";
    refs.clearBtn.style.display = "flex";
    if (refs.zoomBtn) refs.zoomBtn.style.display = "flex";
    refs.preview.onload = () => {
        if (refs.sizeBadge) {
            refs.sizeBadge.textContent = `${refs.preview.naturalWidth} x ${refs.preview.naturalHeight}`;
            refs.sizeBadge.style.display = "block";
        }
        hideBuiltinImagePreview(node);
    };
    refs.preview.src = viewUrl(filename);
    hideBuiltinImagePreview(node);
}

/** 清空图像。 */
function clearImage(node, skipConfirm) {
    if (isEmptyImage(node.properties?.[PROP_IMAGE])) return;
    if (!skipConfirm && !confirm("Clear the loaded image?")) return;
    applyImageSelection(node, IMAGE_NONE);
}

/** 渲染音频空态。 */
function renderEmptyAudio(node) {
    const body = node.pml_body;
    if (!body) return;
    body.innerHTML = "";
    body.style.cssText = `
        display: flex;
        width: 100%;
        height: ${WAVEFORM_H}px;
        min-height: ${WAVEFORM_H}px;
        box-sizing: border-box;
        background: rgba(8, 12, 20, 0.28);
        border: 1px solid ${C.panelBorder};
        border-radius: 6px;
        align-items: center;
        justify-content: center;
        color: ${C.textMuted};
        font-size: 11px;
        flex: 0 0 auto;
    `;
    body.textContent = "拖入参考音色 / Drop upload audio";
    showFileControlsOnly(node);
    setAudioClearVisible(node, false);
    stopPlayheadLoop(node);
}

/** 显示或隐藏音频区域右上角的清除按钮。 */
function setAudioClearVisible(node, visible) {
    const btn = node.pml_audioClearBtn;
    if (!btn) return;
    btn.style.display = visible ? "flex" : "none";
}

/** 仅显示上传/录音按钮。 */
function showFileControlsOnly(node) {
    const refs = node.pml_refs;
    if (!refs) return;
    refs.tCur.style.display = "none";
    refs.tDur.style.display = "none";
    refs.playGroup.style.display = "none";
    refs.fileGroup.style.display = "flex";
}

/** 音频加载后显示播放与裁剪控件。 */
function showLoadedControls(node) {
    const refs = node.pml_refs;
    if (!refs) return;
    refs.tCur.style.display = "inline-block";
    refs.tDur.style.display = "inline-block";
    refs.playGroup.style.display = "flex";
    refs.fileGroup.style.display = "flex";
    node.pml_controls.style.justifyContent = "space-between";
    setAudioClearVisible(node, true);
    updateTrimVisuals(node);
}

/** 弹出系统文件选择器以上传音频。 */
function triggerAudioUpload(node) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.style.display = "none";
    input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            await handleAudioFile(node, file);
        } catch (err) {
            console.error(err);
            alert("Upload failed: " + err.message);
        }
    };
    document.body.appendChild(input);
    input.click();
    setTimeout(() => document.body.removeChild(input), 0);
}

/** 上传音频并重置裁剪范围为整段。 */
async function handleAudioFile(node, file) {
    let filename = file.name || "audio.wav";
    if (!/\.[a-z0-9]+$/i.test(filename)) filename += ".wav";
    const savedName = await uploadToInput(file, filename);
    setRequiredWidget(node, "audio_filename", savedName);
    setRequiredWidget(node, "trim_start", 0.0);
    setRequiredWidget(node, "trim_end", -1.0);
    node.properties[PROP_AUDIO] = savedName;
    node.properties[PROP_TRIM_START] = 0.0;
    node.properties[PROP_TRIM_END] = -1.0;
    setAudioMuted(node, false);
    applyMutedVisual(node);
    markGraphDirty(node);
    await loadAndRender(node, savedName);
}

/** 通过内容感知接口上传图像：同名同内容覆盖，同名不同内容递增编号。 */
async function uploadImageToInput(file, filename) {
    const formData = new FormData();
    formData.append("image", file, filename);
    const response = await fetch("/dn/asset_card/upload_image", {
        method: "POST",
        body: formData,
    });
    if (!response.ok) {
        let detail = "HTTP " + response.status;
        try {
            const payload = await response.json();
            if (payload && payload.error) detail = payload.error;
        } catch (e) {}
        throw new Error(detail);
    }
    const data = await response.json();
    if (data && data.error) throw new Error(data.error);
    const name = data.name || data.filename || filename;
    const sub = data.subfolder || "";
    return sub ? `${sub}/${name}` : name;
}

/** 通过 ComfyUI /upload/image 接口把音频写入 input 目录。 */
async function uploadToInput(file, filename) {
    const formData = new FormData();
    formData.append("image", file, filename);
    formData.append("type", "input");
    formData.append("overwrite", "true");
    const response = await fetch("/upload/image", { method: "POST", body: formData });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    const name = data.name || data.filename || filename;
    const sub = data.subfolder || "";
    return sub ? `${sub}/${name}` : name;
}

/** 构造 /view 预览地址，并将子目录作为独立参数传递。 */
function viewUrl(filename) {
    const normalized = String(filename || "").replace(/\\/g, "/");
    const separator = normalized.lastIndexOf("/");
    const subfolder = separator >= 0 ? normalized.slice(0, separator) : "";
    const name = separator >= 0 ? normalized.slice(separator + 1) : normalized;
    const params = new URLSearchParams({
        filename: name,
        type: "input",
        t: String(Date.now()),
    });
    if (subfolder) params.set("subfolder", subfolder);
    return "/view?" + params.toString();
}

/** 按名称或兜底索引写入控件值。 */
function setRequiredWidget(node, name, value) {
    if (!node.widgets || !node.widgets.length) return false;
    const named = node.widgets.find((w) => w && w.name === name);
    if (named) {
        named.value = value;
        return true;
    }
    const idx = REQUIRED_WIDGET_INDEX[name];
    if (idx !== undefined && node.widgets[idx]) {
        node.widgets[idx].value = value;
        return true;
    }
    return false;
}

/** 标记工作流已修改。 */
function markGraphDirty(node) {
    try { node.setDirtyCanvas?.(true, true); } catch (e) {}
    try { app.graph?.setDirtyCanvas?.(true, true); } catch (e) {}
}

/** 拉取音频、解码波形并进入已加载界面。 */
async function loadAndRender(node, filename) {
    const url = viewUrl(filename);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Cannot fetch " + filename);
    const arrayBuf = await resp.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AC();
    let audioBuf;
    try {
        audioBuf = await audioCtx.decodeAudioData(arrayBuf.slice(0));
    } finally {
        try { audioCtx.close(); } catch (e) {}
    }

    if (node.pml_cleanupPlayback) node.pml_cleanupPlayback();
    if (node.pml_cleanupInteraction) node.pml_cleanupInteraction();
    if (node.pml_wfRO) {
        try { node.pml_wfRO.disconnect(); } catch (e) {}
        node.pml_wfRO = null;
    }
    stopPlayheadLoop(node);
    if (node.pml_audioElement) {
        try { node.pml_audioElement.pause(); } catch (e) {}
        node.pml_audioElement.src = "";
    }

    const audio = new Audio();
    audio.src = url;
    audio.preload = "auto";
    audio.loop = false;
    node.pml_audioElement = audio;
    node.pml_audioBuffer = audioBuf;
    node.pml_duration = audioBuf.duration;
    node.pml_state = {
        selection: null,
        trimmed: false,
        isMuted: !!node.properties?.[PROP_AUDIO_MUTED],
    };
    restoreTrimSelection(node);
    renderLoadedAudio(node);
    applyMutedVisual(node);
}

/** 从已保存的 trim_start / trim_end 恢复波形选区。 */
function restoreTrimSelection(node) {
    const start = Number(node.properties?.[PROP_TRIM_START] ?? 0);
    const end = Number(node.properties?.[PROP_TRIM_END] ?? -1);
    const dur = node.pml_duration || 0;
    if (!node.pml_state || dur <= 0) return;
    if (end >= 0 && (start > 0 || end < dur - 0.01)) {
        node.pml_state.selection = {
            start: Math.max(0, Math.min(start, dur)),
            end: Math.max(0, Math.min(end, dur)),
        };
        node.pml_state.trimmed = true;
    }
}

/** 从音频路径中提取不含目录的文件名。 */
function audioBasename(path) {
    const text = String(path || "");
    const parts = text.split(/[\\/]/);
    return parts[parts.length - 1] || text;
}

/** 渲染波形画布、选区叠加层与播放指针。 */
function renderLoadedAudio(node) {
    const body = node.pml_body;
    if (!body) return;
    body.innerHTML = "";
    body.style.cssText = `
        display: flex;
        width: 100%;
        padding: 0;
        margin: 0;
        background: transparent;
        flex: 0 0 auto;
        min-height: ${WAVEFORM_H}px;
        height: ${WAVEFORM_H}px;
        max-height: ${WAVEFORM_H}px;
    `;

    const wfContainer = document.createElement("div");
    wfContainer.style.cssText = `
        position: relative;
        flex: 1 1 auto;
        min-height: ${WAVEFORM_H}px;
        width: 100%;
        box-sizing: border-box;
        background: rgba(8, 12, 20, 0.28);
        border: 1px solid ${C.panelBorder};
        outline: none;
        border-radius: 6px;
        overflow: hidden;
        cursor: crosshair;
        touch-action: none;
    `;
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width: 100%; height: 100%; display: block;";
    wfContainer.appendChild(canvas);

    const filenameLabel = document.createElement("div");
    filenameLabel.textContent = audioBasename(node.properties?.[PROP_AUDIO]);
    filenameLabel.title = filenameLabel.textContent;
    filenameLabel.style.cssText = `
        position: absolute;
        left: 0;
        top: 0;
        max-width: calc(100% - 16px);
        width: fit-content;
        box-sizing: border-box;
        padding: 2px 8px;
        overflow: hidden;
        color: rgba(255,255,255,0.92);
        background: rgba(0, 0, 0, 0.55);
        border-radius: 999px;
        font-size: 11px;
        line-height: normal;
        white-space: nowrap;
        text-overflow: ellipsis;
        pointer-events: none;
        user-select: none;
        z-index: 3;
    `;
    wfContainer.appendChild(filenameLabel);

    const selOverlay = document.createElement("div");
    selOverlay.style.cssText = `
        position: absolute; top: 0; bottom: 0; left: 0; width: 0;
        display: none; pointer-events: none; box-sizing: border-box;
        border: none; transition: background 0.2s, box-shadow 0.2s;
    `;
    wfContainer.appendChild(selOverlay);

    const selLabel = document.createElement("div");
    selLabel.textContent = "0.0s";
    selLabel.style.cssText = `
        /* 贴在波形区下边缘：上边缘被左上角的文件名标签占着，放上面会被挡住。 */
        position: absolute; bottom: 2px; transform: translateX(-50%);
        background: rgba(52, 211, 153, 0.20); color: ${C.primary};
        font-size: 9px; font-weight: 500; padding: 1px 6px;
        border-radius: 8px; border: 1px solid ${C.selectionBorder};
        display: none; pointer-events: none; white-space: nowrap;
        font-variant-numeric: tabular-nums;
        transition: background 0.2s, color 0.2s, border-color 0.2s; z-index: 2;
    `;
    wfContainer.appendChild(selLabel);

    const playhead = document.createElement("div");
    playhead.style.cssText = `
        position: absolute; top: 0; bottom: 0; width: 2px;
        background: ${C.primaryStrong}; box-shadow: 0 0 6px ${C.primary};
        display: none; pointer-events: none; left: 0; z-index: 1;
    `;
    wfContainer.appendChild(playhead);
    body.appendChild(wfContainer);

    const refs = node.pml_refs;
    refs.wfContainer = wfContainer;
    refs.canvas = canvas;
    refs.selOverlay = selOverlay;
    refs.selLabel = selLabel;
    refs.playhead = playhead;
    if (refs.tDur) refs.tDur.textContent = formatTime(node.pml_duration);

    showLoadedControls(node);
    setupWaveformInteraction(node);
    setupPlayback(node);
    startPlayheadLoop(node);

    if (node.pml_wfRO) {
        try { node.pml_wfRO.disconnect(); } catch (e) {}
        node.pml_wfRO = null;
    }
    if (window.ResizeObserver) {
        node.pml_wfRO = new ResizeObserver(() => {
            relayoutWaveform(node);
            node.pml_paintOverlay?.();
        });
        node.pml_wfRO.observe(wfContainer);
    }
    requestAnimationFrame(() => {
        relayoutWaveform(node);
        node.pml_paintOverlay?.();
    });
}

/** 按容器像素比重绘波形。 */
function relayoutWaveform(node) {
    const refs = node.pml_refs;
    const wf = refs?.wfContainer;
    const canvas = refs?.canvas;
    if (!wf || !canvas || !node.pml_audioBuffer) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(60, Math.round(wf.clientWidth * dpr));
    const h = Math.max(24, Math.round(wf.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        drawWaveform(canvas, node.pml_audioBuffer);
    }
}

/** 把 AudioBuffer 绘制为绿色波形。 */
function drawWaveform(canvas, audioBuf) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const numCh = audioBuf.numberOfChannels;
    const len = audioBuf.length;
    if (!len) return;
    const samplesPerPixel = Math.max(1, Math.floor(len / w));
    const mid = h / 2;
    ctx.fillStyle = C.wave;
    for (let x = 0; x < w; x++) {
        const start = x * samplesPerPixel;
        const end = Math.min(len, start + samplesPerPixel);
        let min = 1.0;
        let max = -1.0;
        for (let c = 0; c < numCh; c++) {
            const data = audioBuf.getChannelData(c);
            for (let i = start; i < end; i++) {
                const v = data[i];
                if (v < min) min = v;
                if (v > max) max = v;
            }
        }
        const y1 = mid - max * (mid - 1);
        const y2 = mid - min * (mid - 1);
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(0, mid, w, 1);
}

/** 绑定波形拖拽选区、双击重置与右键清除。 */
function setupWaveformInteraction(node) {
    if (node.pml_cleanupInteraction) node.pml_cleanupInteraction();
    const refs = node.pml_refs;
    const container = refs.wfContainer;
    const overlay = refs.selOverlay;
    const label = refs.selLabel;
    const audio = node.pml_audioElement;
    const state = node.pml_state;
    let dragging = null;
    let dragAnchor = 0;
    let downX = 0;
    let moved = false;

    const getMetrics = () => {
        const rect = container.getBoundingClientRect();
        const localW = container.clientWidth || rect.width || 1;
        const scale = rect.width ? rect.width / localW : 1;
        return { rect, localW, scale: scale || 1 };
    };
    const posToTime = (e) => {
        const { rect, localW, scale } = getMetrics();
        const x = Math.max(0, Math.min((e.clientX - rect.left) / scale, localW));
        const t = node.pml_duration > 0 ? (x / localW) * node.pml_duration : 0;
        return { x, t };
    };

    const onPointerDown = (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        try { container.setPointerCapture(e.pointerId); } catch (err) {}
        const p = posToTime(e);
        downX = p.x;
        moved = false;
        dragging = null;
        if (state.selection && node.pml_duration > 0) {
            const { localW } = getMetrics();
            const sl = (state.selection.start / node.pml_duration) * localW;
            const sr = (state.selection.end / node.pml_duration) * localW;
            if (Math.abs(p.x - sl) <= 6) { dragging = "left"; return; }
            if (Math.abs(p.x - sr) <= 6) { dragging = "right"; return; }
        }
        audio.currentTime = p.t;
    };

    const onPointerMove = (e) => {
        if (!(e.buttons & 1)) return;
        const p = posToTime(e);
        if (!dragging) {
            if (!moved && Math.abs(p.x - downX) > 3) {
                moved = true;
                dragging = "new";
                dragAnchor = (downX / (getMetrics().localW || 1)) * node.pml_duration;
                state.selection = { start: dragAnchor, end: dragAnchor };
                state.trimmed = false;
                updateTrimVisuals(node);
                paintOverlay();
            } else {
                return;
            }
        }
        if (!state.selection) state.selection = { start: p.t, end: p.t };
        if (dragging === "new") {
            state.selection.start = Math.min(dragAnchor, p.t);
            state.selection.end = Math.max(dragAnchor, p.t);
        } else if (dragging === "left") {
            state.selection.start = Math.min(p.t, state.selection.end - 0.05);
        } else if (dragging === "right") {
            state.selection.end = Math.max(p.t, state.selection.start + 0.05);
        }
        state.trimmed = false;
        updateTrimVisuals(node);
        paintOverlay();
    };

    const endDrag = (e) => {
        dragging = null;
        try { container.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    const clearSelection = () => {
        state.selection = null;
        state.trimmed = false;
        updateTrimVisuals(node);
        paintOverlay();
    };
    const onDblClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearSelection();
    };
    const onContextMenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearSelection();
    };

    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", endDrag);
    container.addEventListener("pointercancel", endDrag);
    container.addEventListener("dblclick", onDblClick);
    container.addEventListener("contextmenu", onContextMenu);
    container.addEventListener("dragstart", (e) => e.preventDefault());

    node.pml_cleanupInteraction = () => {
        container.removeEventListener("pointerdown", onPointerDown);
        container.removeEventListener("pointermove", onPointerMove);
        container.removeEventListener("pointerup", endDrag);
        container.removeEventListener("pointercancel", endDrag);
        container.removeEventListener("dblclick", onDblClick);
        container.removeEventListener("contextmenu", onContextMenu);
    };

    function paintOverlay() {
        if (!state.selection || node.pml_duration <= 0) {
            overlay.style.display = "none";
            label.style.display = "none";
            updateTrimVisuals(node);
            return;
        }
        const { localW } = getMetrics();
        const sl = (state.selection.start / node.pml_duration) * localW;
        const sr = (state.selection.end / node.pml_duration) * localW;
        overlay.style.left = `${sl}px`;
        overlay.style.width = `${Math.max(0, sr - sl)}px`;
        overlay.style.display = "block";
        const trimmed = !!state.trimmed;
        overlay.style.background = trimmed ? C.trimmedBg : C.selectionBg;
        overlay.style.boxShadow = `inset 0 0 0 2px ${trimmed ? C.trimmedBorder : C.selectionBorder}`;
        label.style.background = trimmed ? C.trimmedLabelBg : "rgba(52, 211, 153, 0.20)";
        label.style.color = trimmed ? C.trimmedBorder : C.primary;
        label.style.borderColor = trimmed ? C.trimmedBorder : C.selectionBorder;
        const dur = state.selection.end - state.selection.start;
        label.textContent = dur.toFixed(1) + "s";
        const cx = (sl + sr) / 2;
        const half = 22;
        label.style.left = `${Math.max(half, Math.min(cx, localW - half))}px`;
        label.style.display = "block";
        updateTrimVisuals(node);
    }
    node.pml_paintOverlay = paintOverlay;
    paintOverlay();
}

/** 同步播放按钮图标与 audio 元素状态。 */
function setupPlayback(node) {
    if (node.pml_cleanupPlayback) node.pml_cleanupPlayback();
    const audio = node.pml_audioElement;
    const playBtn = node.pml_refs.playBtn;
    const onPlay = () => { if (playBtn) playBtn.innerHTML = SVG.pause; };
    const onPause = () => { if (playBtn) playBtn.innerHTML = SVG.play; };
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    node.pml_cleanupPlayback = () => {
        audio.removeEventListener("play", onPlay);
        audio.removeEventListener("pause", onPause);
    };
}

/** 启动播放指针与当前时间刷新循环（不改节点尺寸）。 */
function startPlayheadLoop(node) {
    stopPlayheadLoop(node);
    const tick = () => {
        if (!node.pml_refs || !node.pml_audioElement) return;
        const refs = node.pml_refs;
        const audio = node.pml_audioElement;
        const state = node.pml_state || {};
        const t = audio.currentTime || 0;
        if (state.selection && !audio.paused && t >= state.selection.end - 0.01) {
            audio.pause();
            audio.currentTime = Math.max(state.selection.end, t);
            if (node.pml_state) node.pml_state.reachedTrimEnd = true;
        }
        if (refs.tCur) refs.tCur.textContent = formatTime(t);
        const playhead = refs.playhead;
        if (playhead && playhead.parentElement) {
            const w = playhead.parentElement.clientWidth || 1;
            const frac = node.pml_duration > 0 ? t / node.pml_duration : 0;
            playhead.style.left = `${frac * w}px`;
            playhead.style.display = audio.paused && t === 0 ? "none" : "block";
        }
        node.pml_rafId = requestAnimationFrame(tick);
    };
    node.pml_rafId = requestAnimationFrame(tick);
}

/** 停止播放指针刷新。 */
function stopPlayheadLoop(node) {
    if (node.pml_rafId) {
        cancelAnimationFrame(node.pml_rafId);
        node.pml_rafId = 0;
    }
}

/** 绑定静音、播放、还原、确认裁剪、上传与录音按钮。 */
function setupControls(node) {
    const refs = node.pml_refs;
    if (!refs) return;
    const { speakerBtn, playBtn, restoreBtn, cutBtn, uploadBtn, micBtn } = refs;

    speakerBtn.onclick = (e) => {
        e.stopPropagation();
        const audio = node.pml_audioElement;
        if (!audio) return;
        audio.muted = !audio.muted;
        if (node.pml_state) node.pml_state.isMuted = audio.muted;
        setAudioMuted(node, audio.muted);
        applyMutedVisual(node);
    };

    playBtn.onclick = (e) => {
        e.stopPropagation();
        const audio = node.pml_audioElement;
        if (!audio) return;
        const state = node.pml_state;
        if (audio.paused) {
            if (state && state.selection) {
                const cur = audio.currentTime || 0;
                const start = state.selection.start;
                const end = state.selection.end;
                // 到达 B 点附近时，下一次播放从 A 重新开始。
                if (cur < start - 0.01 || cur >= end - 0.05) {
                    audio.currentTime = start;
                }
            }
            audio.play().catch(() => {});
        } else {
            audio.pause();
        }
    };

    restoreBtn.onclick = (e) => {
        e.stopPropagation();
        restoreOriginal(node);
    };

    cutBtn.onclick = (e) => {
        e.stopPropagation();
        const state = node.pml_state;
        if (!state) return;
        if (!state.selection) {
            state.selection = { start: 0, end: node.pml_duration || 0 };
        }
        const ts = Number(state.selection.start.toFixed(3));
        const te = Number(state.selection.end.toFixed(3));
        const ok1 = setRequiredWidget(node, "trim_start", ts);
        const ok2 = setRequiredWidget(node, "trim_end", te);
        node.properties[PROP_TRIM_START] = ts;
        node.properties[PROP_TRIM_END] = te;
        markGraphDirty(node);
        try { app.graph?.afterChange?.(); } catch (err) {}
        state.trimmed = true;
        if (node.pml_paintOverlay) node.pml_paintOverlay();
        updateTrimVisuals(node);
        if (!ok1 || !ok2) alert("Failed to save trim values to widgets.");
    };

    uploadBtn.onclick = (e) => {
        e.stopPropagation();
        triggerAudioUpload(node);
    };
    micBtn.onclick = (e) => {
        e.stopPropagation();
        toggleRecord(node, micBtn);
    };
}

/** 把静音状态写入隐藏控件，使后端输出 audio 为 None。 */
function setAudioMuted(node, muted) {
    const value = !!muted;
    node.properties[PROP_AUDIO_MUTED] = value;
    setRequiredWidget(node, "audio_muted", value);
    markGraphDirty(node);
    try { app.graph?.afterChange?.(); } catch (e) {}
}

/** 恢复播放器静音图标；静音时按钮变红。 */
function applyMutedVisual(node) {
    const muted = !!node.properties?.[PROP_AUDIO_MUTED];
    const audio = node.pml_audioElement;
    if (audio) audio.muted = muted;
    if (node.pml_state) node.pml_state.isMuted = muted;
    const btn = node.pml_refs?.speakerBtn;
    if (!btn) return;
    btn.innerHTML = muted ? SVG.speakerMute : SVG.speaker;
    btn.style.color = muted ? C.record : C.text;
    btn.style.background = muted ? C.recordBg : "transparent";
    btn.title = muted ? "Unmute" : "Mute";
}

/** 一键清除裁剪，导出原始完整音频。 */
function restoreOriginal(node) {
    const state = node.pml_state;
    if (state) {
        state.selection = null;
        state.trimmed = false;
    }
    setRequiredWidget(node, "trim_start", 0.0);
    setRequiredWidget(node, "trim_end", -1.0);
    node.properties[PROP_TRIM_START] = 0.0;
    node.properties[PROP_TRIM_END] = -1.0;
    markGraphDirty(node);
    try { app.graph?.afterChange?.(); } catch (e) {}
    node.pml_paintOverlay?.();
    updateTrimVisuals(node);
}

/** 已确认裁剪时高亮剪刀按钮。 */
function updateTrimVisuals(node) {
    const refs = node.pml_refs;
    const state = node.pml_state;
    if (!refs?.cutBtn) return;
    const trimmed = !!(state && state.trimmed);
    refs.cutBtn.style.color = trimmed ? C.trimmedBorder : C.text;
    refs.cutBtn.title = trimmed ? "Trim confirmed" : "Confirm trim";
}

/** 开始或停止麦克风录音。 */
async function toggleRecord(node, micBtn) {
    if (node.pml_recorder && node.pml_recorder.state === "recording") {
        node.pml_recorder.stop();
        micBtn.innerHTML = SVG.mic;
        micBtn.style.color = C.primary;
        micBtn.style.background = "transparent";
        return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("This browser does not support audio recording.");
        return;
    }
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        alert("Microphone access denied or not available: " + err.message);
        return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        micBtn.innerHTML = SVG.mic;
        micBtn.style.color = C.primary;
        micBtn.style.background = "transparent";
        try {
            const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
            const wav = await blobToWav(blob);
            const file = new File([wav], "h3_recording_" + Date.now() + ".wav", {
                type: "audio/wav",
            });
            await handleAudioFile(node, file);
        } catch (err) {
            console.error(err);
            alert("Recording failed: " + err.message);
        }
        node.pml_recorder = null;
    };
    recorder.start();
    node.pml_recorder = recorder;
    micBtn.innerHTML = SVG.recording;
    micBtn.style.color = C.record;
    micBtn.style.background = C.recordBg;
}

/** 将录音 Blob 解码并编码为 WAV。 */
async function blobToWav(blob) {
    const arrayBuf = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    let audioBuf;
    try {
        audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
    } finally {
        try { ctx.close(); } catch (e) {}
    }
    return encodeWav(audioBuf);
}

/** 把 AudioBuffer 编码为 16-bit PCM WAV Blob。 */
function encodeWav(audioBuf) {
    const numCh = audioBuf.numberOfChannels;
    const sr = audioBuf.sampleRate;
    const len = audioBuf.length;
    const bytesPerSample = 2;
    const dataSize = len * numCh * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    writeStr(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(view, 8, "WAVE");
    writeStr(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * numCh * bytesPerSample, true);
    view.setUint16(32, numCh * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeStr(view, 36, "data");
    view.setUint32(40, dataSize, true);
    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(audioBuf.getChannelData(c));
    let off = 44;
    for (let i = 0; i < len; i++) {
        for (let c = 0; c < numCh; c++) {
            let s = Math.max(-1, Math.min(1, channels[c][i]));
            s = s < 0 ? s * 0x8000 : s * 0x7fff;
            view.setInt16(off, s | 0, true);
            off += 2;
        }
    }
    return new Blob([buffer], { type: "audio/wav" });
}

/** 向 DataView 写入 ASCII 字符串。 */
function writeStr(view, off, str) {
    for (let i = 0; i < str.length; i++) {
        view.setUint8(off + i, str.charCodeAt(i));
    }
}

/** 清空已加载音频并回到空态。 */
function clearAudio(node, skipConfirm) {
    if (!node.properties?.[PROP_AUDIO]) return;
    if (!skipConfirm && !confirm("Clear the loaded audio?")) return;
    node.properties[PROP_AUDIO] = "";
    node.properties[PROP_TRIM_START] = 0;
    node.properties[PROP_TRIM_END] = -1;
    setRequiredWidget(node, "audio_filename", "");
    setRequiredWidget(node, "trim_start", 0.0);
    setRequiredWidget(node, "trim_end", -1.0);
    setAudioMuted(node, false);
    applyMutedVisual(node);
    if (node.pml_cleanupPlayback) node.pml_cleanupPlayback();
    if (node.pml_cleanupInteraction) node.pml_cleanupInteraction();
    if (node.pml_wfRO) {
        try { node.pml_wfRO.disconnect(); } catch (e) {}
        node.pml_wfRO = null;
    }
    stopPlayheadLoop(node);
    if (node.pml_audioElement) {
        try { node.pml_audioElement.pause(); } catch (e) {}
        node.pml_audioElement.src = "";
        node.pml_audioElement = null;
    }
    node.pml_audioBuffer = null;
    node.pml_duration = 0;
    node.pml_state = { selection: null, trimmed: false, isMuted: false };
    markGraphDirty(node);
    renderEmptyAudio(node);
}

/** 把秒数格式化为 m:ss。 */
function formatTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ":" + sec.toString().padStart(2, "0");
}
