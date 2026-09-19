import { app } from "../../../scripts/app.js";

/*
 * 资产卡 to Director Group —— 提示词富文本编辑器。
 *
 * 目标：把 prompt 从"一坨纯文本"变成"看得懂、改得动"的结构化视图。
 *
 * 出处与授权（均为「参考思路、未复制代码」）：
 * - ComfyUI-PainterNodes / web/js/PainterMiniMaxRefToVideo2.js
 *   （MIT，作者 princepainter）—— chip 化渲染、切镜、对话块、@ 菜单、自建撤销栈的整体思路
 * - ComfyUI-MiniMaxH3-Easy / web/minimax_h3_easy_ui.js
 *   （MIT，作者 nkxx188）—— 隐藏原生 widget + contenteditable + 原文切换的做法
 * 本文件为独立实现（自写的词法切分、光标换算、缩略图解析与样式）。
 * 完整出处与授权见仓库根目录 THIRD_PARTY_NOTICES.md。
 *
 * 铁律（跟本包其它扩展一致）：
 * 1. **原生 prompt widget 不删、只隐藏** —— 它仍参与 widgets_values 序列化，
 *    所以工作流文件格式一字不变（不会重演"位置错位"那次事故）。
 * 2. 编辑器里的内容实时写回 `widget.value`，任何时刻"文本"只有一个真相。
 * 3. 每个事件处理都包 try/catch：万一高亮出 bug，**打不了字**才是灾难，样式失效可以忍。
 * 4. chip 一律 `contentEditable=false` + `data-raw`，序列化时原样吐回，保证往返一致。
 */

const NODE_CLASS = "DNMediaToDirectorGroup";
const WIDGET_NAME = "prompt";
const UI_WIDGET = "dn_prompt_ui";
const ROOT_CLASS = "dnp-root";
const FILTER_WARN_CLASS = "dnp-filter-warn";
const EDITOR_CLASS = "dnp-editor";
const CHIP_CLASS = "dnp-chip";
const SHOT_CLASS = "dnp-shot";
const LANG_CLASS = "dnp-lang";
const DIALOGUE_CLASS = "dnp-dialogue";
const HEADING_CLASS = "dnp-heading";
const TIME_CLASS = "dnp-time";
const ASSET_CLASS = "dnp-asset";
const MENU_CLASS = "dnp-menu";
const RAW_CLASS = "dnp-raw";
const OFF_CLASS = "dnp-off";
const PREVIEW_ID = "dnp-hover-preview";
const RAW_PROP = "dn_prompt_raw_mode";

/* 六段式标题（H3 规范；Ref2VA 用前六个，T2V 用 integrated_multimodal_description） */
const HEADINGS = [
    "subject_definitions",
    "retention_analysis",
    "summary",
    "detailed_description",
    "integrated_multimodal_description",
    "overall_soundscape",
    "non_diegetic_music",
];
const HEADING_RE = new RegExp(`^(${HEADINGS.join("|")})\\s*:`, "m");
void HEADING_RE;

const TAG_RE = /<(Picture|Video|Audio)\s+(\d+)>/g;
/* H3 规范里 `<Subject N>` 是标准写法；`<Subject N> (Sx)` 只是"这个主体在说话"时的附带标记，
   所以 (Sx) 必须是**可选**的，且识别主体不能被它绑架。（用户反馈：只有带 (S1) 的才高亮） */
const SUBJECT_RE = /<Subject\s+(\d+)>(?:\s*\(\s*S(\d+)\s*\))?/g;
const DIALOGUE_RE = /<d>([\s\S]*?)<\/d>/gi;
const LANG_RE = /^\[([A-Za-z][A-Za-z0-9_\-]*)\]\s?/;
const SHOT_RE = /\[Shot\s+(\d+)\]/g;
const TIME_RE = /\bAt\s+\d{2}:\d{2}\.\d{3},?/g;
const TYPE_ICON_KIND = { Picture: "image", Video: "image", Audio: "audio" };
const TYPE_CN = { Picture: "图片", Video: "视频", Audio: "音频" };
const TYPE_KEY = { Picture: "image", Video: "video", Audio: "audio" };

/* 资产名配色：按「红 → 绿 → 蓝 → 三原色两两混合（青 / 品红 / 黄）→ 其余过渡色」的顺序取色，
   饱和度固定 0.70。颜色按资产在提示词里的出现顺序**依次分配**，前几个名字保证互相区分，
   不再靠哈希撞运气（用户反馈：哈希取色有时候区分不明显）。 */
const ASSET_HUES = [
    { h: 0, l: 58 },    // 红
    { h: 120, l: 52 },  // 绿
    { h: 240, l: 64 },  // 蓝
    { h: 185, l: 50 },  // 青（绿 + 蓝）
    { h: 305, l: 60 },  // 品红（红 + 蓝）
    { h: 55, l: 54 },   // 黄（红 + 绿）
    { h: 28, l: 58 },   // 橙
    { h: 268, l: 68 },  // 紫
    { h: 150, l: 46 },  // 春绿
    { h: 205, l: 58 },  // 天蓝
    { h: 332, l: 60 },  // 玫红
    { h: 88, l: 50 },   // 黄绿
];
const ASSET_SAT = 0.7;
const DEFAULT_LANG_MARK = "[Chinese] ";
/* 空对话块里的"光标占位"：零宽空格。
 *
 *  **为什么必须有**（2026-09-17 实测）：新建的对话块 body 里如果只有一个**空文本节点**，
 *  Chrome 会把选区"规范化"成**元素容器位置**（`SPAN.dnp-dialogue-body@1`），而这个位置
 *  算不出插入符号矩形 —— 探针实测 `getBoundingClientRect()` 返回 `{0,0,0,0}`，
 *  表现出来就是"打完「【」光标跑到对话块外面/看不见"。
 *  放一个零宽的**非空**文本节点进去，caret 才有布局可落，视觉上正好落在气泡图标右边。
 *  它只在 DOM 里存在，**序列化时被剥离**（见 stripZwsp），所以提示词与工作流一个字都不会变。 */
const ZWSP = "\u200B";
const stripZwsp = (value) => String(value ?? "").split(ZWSP).join("");

/** 这个节点里有没有"光标可以落的文字"——零宽占位不算，`is-hidden`（display:none）的元素也不算。 */
function hasCaretText(el) {
    for (const child of el.childNodes || []) {
        if (child.nodeType === 3) {
            if (stripZwsp(child.textContent).length) return true;
            continue;
        }
        if (child.nodeType !== 1) continue;
        if (child.classList?.contains("is-hidden")) continue;
        if (hasCaretText(child)) return true;
    }
    return false;
}
/* 认不出说话人时的对话底色：**0.7 饱和度的紫**（与色板里的"紫"同一个色相，一眼认得出是"没认出来"）。 */
const FALLBACK_DIALOGUE_COLOR = hslToHex(268, ASSET_SAT, 66);

/* 行内小图标一律用**内联 SVG**，不用 emoji —— emoji 在系统字体里形状/颜色不可控
   （对话那个 💬 就是深灰气球，实测在深色底上像"糊了一层暗的"）。currentColor 跟着上下文走。 */
const ICON_PATHS = {
    // 摄像机（主体 + 镜头）
    camera: "M1.6 5.2A1.6 1.6 0 0 1 3.2 3.6h4.4A1.6 1.6 0 0 1 9.2 5.2v3.6a1.6 1.6 0 0 1-1.6 1.6H3.2a1.6 1.6 0 0 1-1.6-1.6V5.2Zm9.1 1.3 2.9-1.7a.5.5 0 0 1 .8.4v4.6a.5.5 0 0 1-.8.4l-2.9-1.7V6.5Z",
    // 对话气泡
    bubble: "M3.4 2.6h7.2A2.4 2.4 0 0 1 13 5v3.2a2.4 2.4 0 0 1-2.4 2.4H7.6l-3.2 2.2a.45.45 0 0 1-.7-.37V10.6A2.4 2.4 0 0 1 1.6 8.2V5a2.4 2.4 0 0 1 1.8-2.31Z",
    // 图片（画框 + 山 + 太阳）
    image: "M2 3.4h12a.9.9 0 0 1 .9.9v7.4a.9.9 0 0 1-.9.9H2a.9.9 0 0 1-.9-.9V4.3A.9.9 0 0 1 2 3.4Zm.9 7.2 3.1-3.2 2.2 2.3 1.6-1.6 3.3 3.3V5.2H2.9v5.4Zm8.3-3.7a1.15 1.15 0 1 1 0-2.3 1.15 1.15 0 0 1 0 2.3Z",
    // 喇叭 + 声波
    audio: "M8.5 2.4a.5.5 0 0 1 .8.4v10.4a.5.5 0 0 1-.8.4L5.4 11.5H3.2a.9.9 0 0 1-.9-.9V5.4a.9.9 0 0 1 .9-.9h2.2l3.1-2.1Zm2.8 2.3a.55.55 0 0 1 .78 0 4.7 4.7 0 0 1 0 6.6.55.55 0 1 1-.78-.78 3.6 3.6 0 0 0 0-5.04.55.55 0 0 1 0-.78Z",
};

function makeIcon(kind) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", `dnp-icon dnp-icon-${kind}`);
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", ICON_PATHS[kind]);
    path.setAttribute("fill", "currentColor");
    svg.append(path);
    return svg;
}

function hashName(name) {
    // FNV-1a：只在色板里挑一个"保底"位置，分配表里没有的名字才走这里
    let hash = 0x811c9dc5;
    const text = String(name || "");
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash % 1000003;
}

function hslToHex(h, s, l) {
    // 入参 l 允许写百分数（如 58）或 0~1 的小数，两种都吃
    const light = l > 1 ? l / 100 : l;
    const hue = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * light - 1)) * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = light - c / 2;
    const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hue / 60) % 6];
    const to = (v) => Math.min(255, Math.max(0, Math.round((v + m) * 255))).toString(16).padStart(2, "0");
    return `#${to(seg[0])}${to(seg[1])}${to(seg[2])}`;
}

/** 名称 → 颜色：先查当前节点的分配表，查不到再按哈希从同一套色板里取一个。 */
let ASSET_COLOR_REGISTRY = new Map();

function buildAssetColors(assets) {
    const map = new Map();
    let index = 0;
    for (const name of assets || []) {
        if (!name || map.has(name)) continue;
        const spec = ASSET_HUES[index % ASSET_HUES.length];
        map.set(name, hslToHex(spec.h, ASSET_SAT, spec.l));
        index += 1;
    }
    ASSET_COLOR_REGISTRY = map;
    return map;
}

function assetColor(name, media) {
    if (!name) return null;
    const local = media?.colors?.get?.(name);
    if (local) return local;
    const known = ASSET_COLOR_REGISTRY.get(name);
    if (known) return known;
    const spec = ASSET_HUES[hashName(name) % ASSET_HUES.length];
    return hslToHex(spec.h, ASSET_SAT, spec.l);
}

function withAlpha(hex, alpha) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return FALLBACK_DIALOGUE_BG;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const warn = (...a) => console.warn("[DN prompt rich]", ...a);
const guard = (fn) => (...args) => {
    try { return fn(...args); } catch (error) { warn(error); }
};

/* ================================================================
 * 1. 上游素材解析：按"连接顺序"还原 <Picture N> / <Audio J> 的对应物
 * ================================================================ */

const VIRTUAL_LINK_KEYS = ["dn_media_to_group_links", "h3_media_to_prompt_links", "h3_media_to_video_links"];
const MEDIA_INPUT_RE = /^media_[1-9]$/;

function sourceOf(graph, link) {
    if (link == null) return null;
    if (typeof link === "number") link = graph?.links?.get?.(link) || graph?._links?.[link];
    if (!link) return null;
    const id = link.origin_id ?? link.originId;
    const slot = Number(link.origin_slot ?? link.originSlot ?? 0) || 0;
    const node = graph?.getNodeById?.(Number(id)) || link.origin_node || link.originNode;
    return node ? { node, slot } : null;
}

function virtualSources(node) {
    const props = node?.properties || {};
    const out = [];
    for (const key of VIRTUAL_LINK_KEYS) {
        if (!Array.isArray(props[key])) continue;
        for (const item of props[key]) {
            const id = Number(item?.source_id);
            const src = Number.isFinite(id) ? (node.graph || app.graph)?.getNodeById?.(id) : null;
            if (src) out.push({ node: src, slot: Number(item?.source_slot) || 0 });
        }
    }
    return out;
}

/** 按 build_r2v_group 的顺序把上游卡片展平成一个有序列。 */
function flattenCards(node) {
    const graph = node.graph || app.graph;
    const cards = [];
    const visited = new Set();
    const queue = [node];
    const seenNode = new Set([node.id]);
    while (queue.length) {
        const cur = queue.shift();
        const sources = [];
        if (cur === node) {
            for (const input of cur.inputs || []) {
                if (!input || input.link == null) continue;
                if (input.name !== "medias" && !MEDIA_INPUT_RE.test(String(input.name))) continue;
                const src = sourceOf(graph, input.link);
                if (src) sources.push(src);
            }
        }
        sources.push(...virtualSources(cur));
        for (const src of sources) {
            if (!src.node || visited.has(`${src.node.id}:${src.slot}`)) continue;
            visited.add(`${src.node.id}:${src.slot}`);
            cards.push({ node: src.node, slot: src.slot });
            // H3MediaPrompt / H3MediaToVideo 这类"汇总节点"：它自己的虚拟连线就是它吃进去的卡
            if (virtualSources(src.node).length && !seenNode.has(src.node.id)) {
                seenNode.add(src.node.id);
                queue.push(src.node);
            }
        }
    }
    return cards;
}

function widgetValue(node, name) {
    const w = (node?.widgets || []).find((item) => item && item.name === name);
    return w ? w.value : undefined;
}

/** 一张卡上的图 / 音 / 资产名。 */
function cardInfo(card) {
    const node = card.node;
    const props = node?.properties || {};
    const role = String(widgetValue(node, "role_name") ?? props.pml_role_name ?? "").trim();
    let image = props.pml_image_filename || "";
    let audio = props.pml_audio_filename || "";
    if (!image) {
        const w = (node.widgets || []).find((item) => item && /image|file/i.test(item.name || ""));
        const value = typeof w?.value === "object" ? w?.value?.filename : w?.value;
        if (typeof value === "string" && /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(value)) image = value;
    }
    if (!audio) {
        const w = (node.widgets || []).find((item) => item && /audio|sound/i.test(item.name || ""));
        const value = typeof w?.value === "object" ? w?.value?.filename : w?.value;
        if (typeof value === "string" && /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(value)) audio = value;
    }
    return { node, role, image: String(image || ""), audio: String(audio || "") };
}

function viewUrl(filename) {
    return filename ? `/view?filename=${encodeURIComponent(filename)}&type=input` : "";
}

/** 节点上提示词的纯文本（与后端 build_r2v_group 同口径：strip 过的字符串）。
 *  拿不到（widget 缺失 / 被转成了输入连线）→ 返回 null，此时前端不做过滤。 */
function promptTextOf(node) {
    const value = widgetValue(node, WIDGET_NAME);
    if (value === undefined || value === null) return null;
    return String(value).trim();
}

/** 解析出 { pictures, videos, audios, assets, filteredOut }，编号 1 起、与提示词里的标签一致。
 *
 *  这里**复刻后端 media_group_core.filter_unused_role_medias 的同一条规则**：
 *  资产名（role_name）非空、且没出现在提示词文本里的卡，后端在编号**之前**就会丢掉。
 *  前端以前不过滤 → 提示词里的 <Picture N> 与实际喂进模型的编号会错位
 *  （例：连 A、B、C，提示词只提到 A 和 C → 后端保留 [A,C]，C 是 <Picture 2>，编辑器却画成 3）。
 *  现在对齐后，编辑器显示的编号永远等于实际编号；被丢的卡不静默——放进 filteredOut，
 *  由编辑框上方的琥珀色提示条显形（updateFilterWarn）。
 *
 *  两个有意的偏差（改后端规则时要回头看这里）：
 *  ① 提示词为空时不过滤 —— 后端此时本来也跑不起来（"至少需要一段提示词…"），别让编辑器闪着吓人；
 *  ② 提示词拿不到（转成了输入连线）时不过滤 —— 无法判断就别装能判断。 */
function resolveMedia(node) {
    const promptText = promptTextOf(node);
    const entries = flattenCards(node).map((card) => ({ card, info: cardInfo(card) }));
    const kept = [];
    const filteredOut = [];
    for (const entry of entries) {
        const { info } = entry;
        if (promptText && info.role && !promptText.includes(info.role)) {
            filteredOut.push({ role: info.role, image: info.image, audio: info.audio, sourceNode: info.node });
            continue;
        }
        kept.push(entry);
    }
    const pictures = [];
    const audios = [];
    const assets = [];
    for (const { info } of kept) {
        if (info.image) {
            pictures.push({
                ordinal: pictures.length + 1,
                url: viewUrl(info.image),
                filename: info.image,
                role: info.role,
                sourceNode: info.node,
            });
        }
        if (info.audio) {
            audios.push({
                ordinal: audios.length + 1,
                filename: info.audio,
                role: info.role,
                sourceNode: info.node,
            });
        }
    }
    // 资产名清单取**全部**卡（含被过滤的）：@ 菜单里点一下名字写进提示词，这张卡就回来了。
    for (const { info } of entries) {
        if (info.role && !assets.includes(info.role)) assets.push(info.role);
    }
    return {
        pictures, videos: [], audios, assets,
        colors: buildAssetColors(assets),
        filteredOut,
        promptKnown: Boolean(promptText),
    };
}

/* ================================================================
 * 1.5 说话人识别（按 H3 官方规范）
 *
 * 规范出处：ref-en.txt §5.1 / §5.4 —— `<Subject N>` 是视觉引用标签，`(Sx)` 才是说话人编号，
 * 二者拼成 `<Subject N> (Sx)`；同一编号在整个提示词里保持不变、不重新编号。
 * 所以正确的推断路径是：
 *   ① 先建立 Sx → 资产名 的映射（资产名 = 第 N 张参考图的卡名）；
 *   ② 再看对话块**前面同一段**里最近出现的 (Sx)（拿映射查名）或 <Subject N>（拿图号查名）；
 *   ③ 都不行时，才退回"段内最近提到的资产名"。
 * 这样比原来的"前 60 字里搜名字"稳得多，也不会被别的角色名串了台。
 * ================================================================ */

function buildSpeakerMap(text, media) {
    const map = new Map();
    SUBJECT_RE.lastIndex = 0;
    for (let m; (m = SUBJECT_RE.exec(text)); ) {
        const n = Number(m[1]);
        const role = media.pictures?.[n - 1]?.role || "";
        if (!role) continue;
        const ids = [];
        if (m[2]) ids.push(`S${Number(m[2])}`);  // 规范里明确写了说话人编号
        ids.push(`S${n}`);                        // 没写时按"主体号 = 说话人号"的默认对齐
        for (const id of ids) if (!map.has(id)) map.set(id, role);
    }
    return map;
}

function speakerFromSegment(seg, media, speakerMap, allowLoose) {
    if (!seg) return null;
    // ① 规范写法：最近的 (Sx)
    const ids = [...seg.matchAll(/\(\s*S(\d+)\s*\)/g)];
    for (let i = ids.length - 1; i >= 0; i--) {
        const id = `S${Number(ids[i][1])}`;
        const mapped = speakerMap.get(id);
        if (mapped) return { name: mapped, via: id };
        // 「白娘子 (S1) 说：」这种手动写法 → (Sx) 前面直接就是资产名
        const head = seg.slice(Math.max(0, ids[i].index - 24), ids[i].index);
        for (const name of media.assets) if (name && head.endsWith(name)) return { name, via: id };
    }
    // ② `<Subject N>` → 第 N 张参考图的资产名
    const subs = [...seg.matchAll(/<Subject\s+(\d+)>/g)];
    for (let i = subs.length - 1; i >= 0; i--) {
        const role = media.pictures?.[Number(subs[i][1]) - 1]?.role;
        if (role) return { name: role, via: `<Subject ${subs[i][1]}>` };
    }
    // ③ 兜底：段内最近提到的资产名（只在同一段里用，避免跨段串台）
    if (allowLoose) {
        let best = null;
        let bestAt = -1;
        for (const name of media.assets) {
            if (!name) continue;
            const at = seg.lastIndexOf(name);
            if (at > bestAt) { bestAt = at; best = name; }
        }
        if (best) return { name: best, via: "段内最近的资产名" };
    }
    return null;
}

/** 对话块的说话人：优先同段，找不到再看"上一个对话块之后"那点文字（对话常另起一行写）。
 *  绝不跨过上一个 </d> —— 那些字是上一句话的归属，拿来当这一句的说话人会串台。 */
function speakerForDialogue(text, index, media, speakerMap) {
    const paraStart = text.lastIndexOf("\n", index - 1) + 1;
    const same = speakerFromSegment(text.slice(paraStart, index), media, speakerMap, true);
    if (same) return same;
    const head = text.slice(Math.max(0, paraStart - 300), paraStart);
    const cut = head.lastIndexOf("</d>");
    const tail = (cut >= 0 ? head.slice(cut + 4) : head).replace(/\s+$/, "");
    if (!tail.trim()) return null;
    return speakerFromSegment(tail, media, speakerMap, false);
}

/* ================================================================
 * 2. 文本 → DOM（渲染）
 * ================================================================ */

/** 收集所有 token 的区间，互不重叠（先到先得，对话块最优先）。 */
function collectRanges(text, media) {
    const ranges = [];
    const overlap = (start, end) => ranges.some((r) => start < r.end && end > r.start);
    const push = (start, end, kind, data) => {
        if (start >= end || overlap(start, end)) return;
        ranges.push({ start, end, kind, data });
    };

    const speakerMap = buildSpeakerMap(text, media);
    DIALOGUE_RE.lastIndex = 0;
    for (let m; (m = DIALOGUE_RE.exec(text)); ) {
        push(m.index, m.index + m[0].length, "dialogue", {
            inner: m[1],
            speaker: speakerForDialogue(text, m.index, media, speakerMap),
        });
    }
    TAG_RE.lastIndex = 0;
    for (let m; (m = TAG_RE.exec(text)); ) {
        push(m.index, m.index + m[0].length, "chip", { type: m[1], ordinal: Number(m[2]) });
    }
    SUBJECT_RE.lastIndex = 0;
    for (let m; (m = SUBJECT_RE.exec(text)); ) {
        push(m.index, m.index + m[0].length, "subject", { n: Number(m[1]), sid: m[2] ? Number(m[2]) : null });
    }
    SHOT_RE.lastIndex = 0;
    for (let m; (m = SHOT_RE.exec(text)); ) {
        push(m.index, m.index + m[0].length, "shot", { n: Number(m[1]) });
    }
    TIME_RE.lastIndex = 0;
    for (let m; (m = TIME_RE.exec(text)); ) {
        push(m.index, m.index + m[0].length, "time", { raw: m[0] });
    }
    for (const heading of HEADINGS) {
        const re = new RegExp(`(^|\\n)(${heading}\\s*:)(?=\\s|$)`, "g");
        for (let m; (m = re.exec(text)); ) {
            const start = m.index + m[1].length;
            push(start, start + m[2].length, "heading", { raw: m[2] });
        }
    }
    for (const name of media.assets) {
        if (!name) continue;
        let from = 0;
        for (;;) {
            const at = text.indexOf(name, from);
            if (at < 0) break;
            push(at, at + name.length, "asset", { raw: name });
            from = at + name.length;
        }
    }
    return ranges.sort((a, b) => a.start - b.start);
}

function makeAtomic(className, raw, parts) {
    const el = document.createElement("span");
    el.className = className;
    el.contentEditable = "false";
    el.setAttribute("data-raw", raw);
    for (const part of parts || []) el.append(part);
    return el;
}

function makeChip(kind, media, ordinal) {
    const picture = kind === "Picture" ? media.pictures.find((p) => p.ordinal === ordinal) : null;
    const audio = kind === "Audio" ? media.audios.find((a) => a.ordinal === ordinal) : null;
    const iconSpan = document.createElement("span");
    iconSpan.className = "dnp-chip-icon";
    const url = picture?.url || "";
    const iconKind = TYPE_ICON_KIND[kind] || "image";
    const drawIcon = () => { iconSpan.textContent = ""; iconSpan.append(makeIcon(iconKind)); };
    if (url && kind !== "Audio") {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        img.draggable = false;
        img.className = "dnp-chip-thumb";
        img.addEventListener("error", () => {
            img.remove();
            drawIcon();
        });
        iconSpan.append(img);
    } else {
        drawIcon();
    }
    const label = document.createElement("span");
    label.className = "dnp-chip-label";
    label.textContent = `${TYPE_CN[kind] || kind} ${ordinal}`;
    const chip = makeAtomic(`${CHIP_CLASS} dnp-chip-${TYPE_KEY[kind] || "image"}`, `<${kind} ${ordinal}>`, [iconSpan, label]);
    if (picture?.role) chip.dataset.asset = picture.role;
    if (audio?.filename) chip.dataset.audio = audio.filename;
    const extra = picture?.role ? `资产：${picture.role}` : "";
    const missing = !picture && kind === "Picture" && !url ? "（画里没有对应卡片）" : "";
    chip.title = [
        `<${kind} ${ordinal}>`,
        extra,
        audio?.filename ? `音频：${audio.filename}` : "",
        missing,
    ].filter(Boolean).join("\n");
    chip.addEventListener("pointerdown", chipCaretHandler);
    return chip;
}

/** 点 chip：按点击的左右半边把光标吸附到 chip 前 / 后。
 *
 *  两个坑（都实测过）：
 *  ① 不能写"元素位置"（会被选区钳掉、caret 也没布局）→ 必须先换算成文本节点位置；
 *  ② pointerdown 阶段宿主**还没聚焦**，此时写影子选区会被浏览器丢掉 → 推迟到事件结束后，
 *     并且用"逻辑文本偏移"重算落点（期间可能已经发生 blur/重渲染，节点引用会失效）。
 *  另外**不阻止默认**：让浏览器自己把焦点放进编辑区，我们只做吸附。 */
function chipCaretHandler(event) {
    const chip = event.currentTarget;
    const editor = chip.closest?.(`.${EDITOR_CLASS}`);
    if (!editor) return;
    const rect = chip.getBoundingClientRect();
    const left = event.clientX < rect.left + rect.width / 2;
    const parent = chip.parentNode;
    const idx = Array.prototype.indexOf.call(parent.childNodes, chip);
    const spot = textPositionFor(parent, left ? idx : idx + 1);
    if (!spot) return;
    const probe = document.createRange();
    probe.selectNodeContents(editor);
    try { probe.setEnd(spot.node, spot.offset); } catch (error) { return; }
    const offset = probe.toString().length;
    setTimeout(() => {
        const back = locate(editor, offset);
        if (!back) return;
        try { editor.focus({ preventScroll: true }); } catch (error) { warn(error); }
        setCaretRange(editor, rangeAt(back.node, back.offset));
    }, 0);
}

/** `<Subject N>` / `<Subject N> (Sx)` 的显示元素：「S1 资产名」，缩写在前、空格隔开，颜色随资产名。 */
function makeSubjectEl(raw, n, sid, media) {
    const role = media?.pictures?.[n - 1]?.role || "";
    const abbrev = sid ? `S${sid}` : `S${n}`;
    const parts = [makeAtomic("dnp-subject-id", "", [document.createTextNode(abbrev)])];
    if (role) parts.push(document.createTextNode(` ${role}`));
    const el = makeAtomic("dnp-subject", raw, parts);
    const color = assetColor(role, media);
    if (color) el.style.color = color;
    el.title = role
        ? `<Subject ${n}>${sid ? ` (S${sid})` : ""} = 资产「${role}」（第 ${n} 张参考图）`
        : `<Subject ${n}>：没对上资产名（第 ${n} 张图的卡没填资产名）`;
    return el;
}

/** `[Shot N]` 的显示元素：摄像机图标 + 「镜头 N」；原始文本进 data-raw。 */
function makeShotEl(raw, n) {
    return makeAtomic(SHOT_CLASS, raw, [
        makeAtomic("dnp-shot-icon", "", [makeIcon("camera")]),
        document.createTextNode(`镜头 ${n}`),
    ]);
}

function makeDialogue(inner, speaker, media) {
    const el = document.createElement("span");
    el.className = DIALOGUE_CLASS;
    const info = typeof speaker === "string" ? { name: speaker, via: "" } : speaker;
    const name = info?.name || "";
    const color = assetColor(name, media) || FALLBACK_DIALOGUE_COLOR;
    el.style.background = withAlpha(color, 0.30);
    el.style.borderLeftColor = color;
    if (name) el.dataset.speaker = name;
    el.title = name
        ? `说话人：${name}${info?.via ? `（依据 ${info.via} 判定）` : ""}`
        : "未识别出说话人 → 紫色底（在对话前面写「资产名 (Sx) 说：」或 <Subject N> 就能对上）";
    const icon = makeAtomic("dnp-dialogue-icon", "", [makeIcon("bubble")]);
    icon.style.color = color;
    el.append(icon);
    const body = document.createElement("span");
    body.className = "dnp-dialogue-body";
    let rest = String(inner ?? "");
    const lang = rest.match(LANG_RE);
    const addLangMark = (raw, hidden) => {
        const mark = document.createElement("span");
        mark.className = hidden ? `${LANG_CLASS} is-hidden` : LANG_CLASS;
        mark.setAttribute("data-raw", raw);
        mark.textContent = raw.trim();
        body.append(mark);
    };
    if (lang) {
        rest = rest.slice(lang[0].length);
        // 中文标记默认藏起来；只有换成别的语言才显示
        addLangMark(lang[0], lang[1].toLowerCase() === "chinese");
    }
    // 原文里没有语言标记时**不在这里补**（否则打开旧工作流、随手敲一个字就会把没碰过的对话全改写）；
    // 手打对话的语言标记由 ensureDialogueLang() 在"正在编辑的那个块"里补。
    if (rest) body.append(document.createTextNode(rest));
    // 空对话块（含只有隐藏语言标记的）必须留一个可落光标的文本节点，否则 caret 无布局、显示到块外
    if (!hasCaretText(body)) body.append(document.createTextNode(ZWSP));
    el.append(body);
    return el;
}

/** 在当前光标所在的对话块补上默认语言标记（隐藏），只在真的在打字时调用。 */
function ensureDialogueLang(editor) {
    const block = dialogueBlockAtCaret(editor);
    if (!block) return false;
    const body = block.querySelector(".dnp-dialogue-body");
    if (!body || body.querySelector(`.${LANG_CLASS}`)) return false;
    // 注意要剥掉零宽占位再判空，否则空对话块会被误补上 [Chinese] 标记
    if (!stripZwsp(body.textContent).trim()) return false;
    const mark = document.createElement("span");
    mark.className = `${LANG_CLASS} is-hidden`;
    mark.setAttribute("data-raw", DEFAULT_LANG_MARK);
    mark.textContent = DEFAULT_LANG_MARK.trim();
    body.insertBefore(mark, body.firstChild);
    return true;
}

/** 给"没有任何可落光标文字"的对话块补回零宽占位。
 *  触发场景：用户退格/删除把占位删掉后，块内空了 → 再点回去光标又会跑出块外。 */
function ensureDialoguePlaceholders(editor) {
    let changed = false;
    for (const body of editor.querySelectorAll(".dnp-dialogue-body")) {
        if (hasCaretText(body)) continue;
        body.append(document.createTextNode(ZWSP));
        changed = true;
    }
    return changed;
}

function makeStyled(className, raw) {
    const el = document.createElement("span");
    el.className = className;
    el.textContent = raw;
    return el;
}

function appendText(container, text) {
    if (!text) return;
    container.append(document.createTextNode(text));
}

function renderInto(container, text, media) {
    container.textContent = "";
    const source = String(text ?? "");
    const ranges = collectRanges(source, media);
    let cursor = 0;
    for (const r of ranges) {
        appendText(container, source.slice(cursor, r.start));
        switch (r.kind) {
            case "chip":
                container.append(makeChip(r.data.type, media, r.data.ordinal));
                break;
            case "subject": {
                // `<Subject N>`（标准）或 `<Subject N> (Sx)`（说话时）→ 显示「S1 资产名」，缩写在前、空格隔开
                container.append(makeSubjectEl(source.slice(r.start, r.end), r.data.n, r.data.sid, media));
                break;
            }
            case "shot":
                container.append(makeShotEl(source.slice(r.start, r.end), r.data.n));
                break;
            case "time":
                container.append(makeStyled(TIME_CLASS, r.data.raw));
                break;
            case "heading":
                container.append(makeStyled(HEADING_CLASS, r.data.raw));
                break;
            case "asset": {
                const el = makeStyled(ASSET_CLASS, r.data.raw);
                const color = assetColor(r.data.raw, media);
                if (color) el.style.color = color;
                container.append(el);
                break;
            }
            case "dialogue":
                container.append(makeDialogue(r.data.inner, r.data.speaker, media));
                break;
            default:
                appendText(container, source.slice(r.start, r.end));
        }
        cursor = r.end;
    }
    appendText(container, source.slice(cursor));
}

/* ================================================================
 * 3. DOM → 文本（序列化，必须与原文逐字往返）
 * ================================================================ */

function serializeNode(el) {
    // 零宽占位（ZWSP）只服务于光标定位，绝不进提示词
    if (el.nodeType === Node.TEXT_NODE) return stripZwsp(el.textContent);
    if (el.nodeType !== Node.ELEMENT_NODE) return "";
    if (el.hasAttribute?.("data-raw")) return el.getAttribute("data-raw") || "";
    if (el.classList?.contains(DIALOGUE_CLASS)) {
        const body = el.querySelector(".dnp-dialogue-body");
        return `<d>${body ? serializeChildren(body) : ""}</d>`;
    }
    if (el.tagName === "BR") return "\n";
    return serializeChildren(el);
}

function serializeChildren(container) {
    let out = "";
    for (const child of container.childNodes || []) out += serializeNode(child);
    return out;
}

function serializeEditor(editor) {
    return serializeChildren(editor);
}

/** 对话块里"光标之后没有正文了"才让空格退出，正文中间照常打空格。 */
function exitDialogueWithSpace(node, editor) {
    const block = dialogueBlockAtCaret(editor);
    if (!block) return false;
    const sel = caretSelection(editor);
    if (!sel || !sel.rangeCount) return false;
    const caret = sel.getRangeAt(0);
    const body = block.querySelector(".dnp-dialogue-body") || block;
    const probe = document.createRange();
    probe.setStart(body, 0);
    try { probe.setEnd(caret.startContainer, caret.startOffset); } catch (error) { return false; }
    const after = body.textContent.slice(probe.toString().length);
    if (stripZwsp(after).trim().length) return false;     // 零宽占位不算"还有内容"
    // 退出对话：把空格直接写成文本节点插到块后面，光标落进这个文本节点 ——
    // 一定要落进**文本节点**，落到"元素位置"会被前端钳掉（见 textPositionFor 的说明）。
    const spaceNode = document.createTextNode(" ");
    block.parentNode.insertBefore(spaceNode, block.nextSibling);
    setCaretRange(editor, rangeAt(spaceNode, 1));
    syncToWidget(node);
    pushHistory(node);
    return true;
}

function dialogueBlockAtCaret(editor) {
    const sel = caretSelection(editor);
    if (!sel || !sel.rangeCount) return null;
    const container = sel.getRangeAt(0).startContainer;
    const holder = container.nodeType === 1 ? container : container.parentElement;
    return holder?.closest?.(`.${DIALOGUE_CLASS}`) || null;
}

/** 光标前的文本 → 说话人（手动敲对话块时用）。 */
function speakerBeforeCaret(media, textBefore) {
    if (!media) return null;
    const text = String(textBefore || "");
    return speakerForDialogue(text, text.length, media, buildSpeakerMap(text, media));
}

/** 打「【」就地开一个对话块，光标放进去（之后用空格或「】」结束）。 */
function insertDialogueAtCaret(node, editor) {
    const sel = caretSelection(editor);
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    if (dialogueBlockAtCaret(editor)) return false;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const media = node.__dnpMedia || resolveMedia(node);
    const info = caretTextBefore(editor);
    const block = makeDialogue("", speakerBeforeCaret(media, info?.text), media);
    range.insertNode(block);
    // 光标放进 body 末尾的**非空文本节点**里（元素位置会被钳掉、空文本节点又没布局，见 ZWSP 与 ensureCaretTextNode）
    const body = block.querySelector(".dnp-dialogue-body") || block;
    const holder = ensureCaretTextNode(body);
    setCaretRange(editor, rangeAt(holder, holder.textContent.length));
    return true;
}

/** 在对话块内部把光标移到块后面（「】」结束对话用）。 */
function exitDialogue(node, editor, block) {
    caretAfterEl(block, editor);
    syncToWidget(node);
    pushHistory(node);
    return true;
}

/* ================================================================
 * 4. 编辑区
 * ================================================================ */

function getWidget(node, name) {
    return (node?.widgets || []).find((w) => w && w.name === name);
}

/** 焦点是否在编辑器里。编辑器住在 shadow root 里，此时 document.activeElement 只会是宿主。 */
function editorFocused(node) {
    const host = node?.__dnpWrap;
    const active = host?.shadowRoot?.activeElement ?? document.activeElement;
    return active === node?.__dnpEditor;
}

function hideNative(widget) {
    if (!widget) return;
    if (!widget.__dnpOrig) {
        widget.__dnpOrig = { type: widget.type, computeSize: widget.computeSize };
    }
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
}

function showNative(widget) {
    if (!widget) return;
    if (widget.__dnpOrig) {
        widget.type = widget.__dnpOrig.type;
        widget.computeSize = widget.__dnpOrig.computeSize;
    }
    widget.hidden = false;
}

function syncToWidget(node, markDirty = true) {
    const widget = getWidget(node, WIDGET_NAME);
    const editor = node.__dnpEditor;
    if (!widget || !editor) return;
    const text = serializeEditor(editor);
    if (widget.value === text) return;
    widget.value = text;
    if (widget._state) widget._state.value = text;
    if (markDirty) {
        node.setDirtyCanvas?.(true, true);
        try { app.graph?.change?.(); } catch (error) { /* 忽略 */ }
    }
}

function renderFromWidget(node) {
    const widget = getWidget(node, WIDGET_NAME);
    const editor = node.__dnpEditor;
    if (!widget || !editor) return;
    // 重排的是同一份文本，滚动位置不该被清掉：blur、延迟刷新、外部同步都会走到这里。
    // 0 也要写回（用户就在顶部），别用 keep > 0 守卫——那类守卫会让"顶部"这个合法位置被吞掉。
    const keep = editor.scrollTop || 0;
    sweepStrayNodes(node);
    node.__dnpMedia = resolveMedia(node);
    updateFilterWarn(node);
    renderInto(editor, String(widget.value ?? ""), node.__dnpMedia);
    editor.scrollTop = keep;
}

/** 把「被后端规则丢掉的卡」亮出来：编辑框上方一条琥珀色提示，不静默。
 *  没有被丢的卡 → 提示条收起，和以前长得一模一样。 */
function updateFilterWarn(node) {
    const el = node?.__dnpFilterWarn;
    const media = node?.__dnpMedia;
    if (!el || !media) return;
    const list = Array.isArray(media.filteredOut) ? media.filteredOut : [];
    if (!list.length) {
        el.classList.remove("dnp-show");
        el.textContent = "";
        return;
    }
    const names = [...new Set(list.map((item) => item.role))].join("、");
    el.textContent = `${list.length} 张卡不计入编号 —— 提示词里没提到资产名：${names}。`
        + "把资产名写进提示词就会回来，或者断开这条连线。";
    el.classList.add("dnp-show");
}

/** 供其它扩展在「连线 / 资产卡变了」时让编辑器重算编号（dn_media_multilink 在写回连线时调用）。
 *  没建过编辑器（比如还没打开过节点）就只重算数据，别去碰 DOM。 */
export function refreshPromptMedia(node) {
    try {
        if (!node) return;
        if (node.__dnpEditor) renderFromWidget(node);
        else {
            node.__dnpMedia = resolveMedia(node);
            updateFilterWarn(node);
        }
    } catch (error) {
        warn(error);
    }
}

/** 「资产名没出现在提示词里、后端不会收这张卡」的**来源节点 id 集合**（Number）。
 *
 *  给画布层用：连线与中点圆点据此压灰（dn_media_multilink / dn_upstream_highlight），
 *  与编辑器里的提示条、编号用的是**同一条规则**（见 resolveMedia），不会两边说得不一样。
 *  与 resolveMedia 同样保守：提示词为空 / 拿不到 → 空集合（不标灰）。 */
export function getFilteredSourceIds(node) {
    try {
        const promptText = promptTextOf(node);
        const ids = new Set();
        if (!promptText) return ids;
        for (const card of flattenCards(node)) {
            const info = cardInfo(card);
            if (info.role && !promptText.includes(info.role)) ids.add(Number(info.node.id));
        }
        return ids;
    } catch (error) {
        warn(error);
        return new Set();
    }
}

/** 把编辑器**外面**那些不该存在的节点扫掉。
 *  历史原因：以前光标定位出错时，字会掉在编辑框外的影子根里，视觉上就是"字跑框外了"。 */
function sweepStrayNodes(node) {
    const root = node.__dnpShadow;
    const editor = node.__dnpEditor;
    if (!root || !editor) return;
    let dirty = false;
    for (const child of Array.from(root.childNodes)) {
        if (child === editor || child.nodeType === 1 && (child.tagName === "STYLE" || child.classList?.contains("dnp-bar") || child.classList?.contains(RAW_CLASS) || child.classList?.contains(FILTER_WARN_CLASS))) continue;
        if (child.nodeType === 3 && !(child.textContent || "").trim()) continue;
        child.remove();
        dirty = true;
    }
    if (dirty) warn("已清理掉落在编辑框外的内容");
}

/** 建编辑器：原生 widget 隐藏但保留（序列化不变），DOM widget 追加在最后（不挪动已有下标）。
 *
 * 编辑区整个装在 **shadow root** 里，原因是实测发现：
 * 装了 ComfyUI-DD-Translation 之类的"扫 DOM 改文本"扩展时，它们会按字典把**整个文本节点**
 * 换掉（纯英文节点才会命中），而本编辑器的渲染会在 token 边界切出 ` is ` 这种短文本节点 ——
 * 结果提示词里的 `is` 被翻成「冰岛语」，再经 syncToWidget 写回工作流，**静默污染提示词**。
 * 影子树对挂在祖先上的 MutationObserver / querySelectorAll 完全不可见，从根上隔离。
 */
function ensureEditor(node) {
    if (node.__dnpEditor) return;
    const widget = getWidget(node, WIDGET_NAME);
    if (!widget || typeof node.addDOMWidget !== "function") return;

    // 宿主留在 light DOM（ComfyUI 要拿它做 DOM widget），内容全在影子里
    const wrap = document.createElement("div");
    wrap.className = `${ROOT_CLASS} nopan`;
    const root = wrap.attachShadow ? wrap.attachShadow({ mode: "open" }) : wrap;
    if (root !== wrap) root.append(shadowStyleEl());

    const bar = document.createElement("div");
    bar.className = "dnp-bar";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "dnp-toggle";
    toggle.textContent = "原文";
    toggle.title = "在富文本与纯文本之间切换（纯文本模式下就是原生的输入框）";
    const hint = document.createElement("span");
    hint.className = "dnp-hint";
    hint.textContent = "@ 引用素材 · 【 开对话，空格结束 · [Shot 2] 镜头 · <Picture 1> 图片";
    bar.append(toggle, hint);

    // 「不计入编号」提示条（琥珀色，默认收起）：有卡被后端规则丢掉时才亮，见 resolveMedia。
    const filterWarn = document.createElement("div");
    filterWarn.className = FILTER_WARN_CLASS;
    filterWarn.setAttribute("role", "status");

    const editor = document.createElement("div");
    editor.className = EDITOR_CLASS;
    editor.contentEditable = "true";
    editor.spellcheck = false;
    editor.tabIndex = 0;
    editor.setAttribute("role", "textbox");
    editor.__dnpPromptNode = node;

    // 原文模式用我们自己的 textarea（和美化状态同一个位置，都在节点下方）
    const rawBox = document.createElement("textarea");
    rawBox.className = `${RAW_CLASS} ${OFF_CLASS}`;      // 先按"隐藏"建，applyRawMode() 结尾会按存档状态纠正
    rawBox.spellcheck = false;
    rawBox.addEventListener("pointerdown", (event) => event.stopPropagation());
    rawBox.addEventListener("input", guard(() => {
        const target = getWidget(node, WIDGET_NAME);
        if (!target) return;
        target.value = rawBox.value;
        if (target._state) target._state.value = rawBox.value;
        node.setDirtyCanvas?.(true, true);
    }));

    // 有 shadow root 就装影子里（样式隔离 + 躲开扫 DOM 的扩展），退化时直接装宿主
    (root === wrap ? wrap : root).append(bar, filterWarn, editor, rawBox);
    node.__dnpEditor = editor;
    node.__dnpFilterWarn = filterWarn;
    node.__dnpRawBox = rawBox;
    node.__dnpWrap = wrap;
    node.__dnpShadow = root === wrap ? null : root;
    node.__dnpToggle = toggle;
    // 粘贴守卫要靠这三个标记反查节点（影子树里事件会被重定向到宿主）
    wrap.__dnpPromptNode = node;
    rawBox.__dnpPromptNode = node;

    wrap.addEventListener("pointerdown", (event) => event.stopPropagation());

    editor.addEventListener("keydown", guard((event) => {
        if (handleHistoryKey(node, event)) return;
        if (handleMenuKey(node, event)) return;
        if (event.key === " " && !node.__dnpComposing && exitDialogueWithSpace(node, editor)) {
            event.preventDefault();
            return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            insertTextAtCaret(editor, "\n");
            syncToWidget(node);
            pushHistory(node);
            return;
        }
        if (event.key === "Tab") return;
    }));

    editor.addEventListener("beforeinput", guard((event) => {
        if (node.__dnpComposing || event.isComposing) return;
        if (event.inputType !== "insertText" || !event.data) return;
        if (event.data === "【") {
            if (insertDialogueAtCaret(node, editor)) {
                event.preventDefault();
                syncToWidget(node);
                pushHistory(node);
            }
            return;
        }
        if (event.data === "】") {
            const block = dialogueBlockAtCaret(editor);
            if (block) {
                event.preventDefault();
                exitDialogue(node, editor, block);
            }
        }
    }));

    editor.addEventListener("input", guard((event) => {
        ensureDialogueLang(editor);
        syncToWidget(node);
        // 占位是零宽的，补它不影响提示词；延后到当前按键处理完再动 DOM（避免干扰输入法）
        if (!node.__dnpComposing) setTimeout(() => ensureDialoguePlaceholders(editor), 0);
        if (event?.isComposing || node.__dnpComposing) return;
        if (convertAtCaret(node, editor)) {
            syncToWidget(node);
        }
        openMenu(node, editor);
        pushHistory(node);
    }));

    editor.addEventListener("compositionstart", () => { node.__dnpComposing = true; closeMenu(); });
    editor.addEventListener("compositionend", guard(() => {
        node.__dnpComposing = false;
        syncToWidget(node);
        pushHistory(node);
    }));
    editor.addEventListener("blur", guard(() => {
        closeMenu();
        hideHoverPreview();
        renderFromWidget(node);
        pushHistory(node);
    }));
    editor.addEventListener("mousemove", guard((event) => updateHoverPreview(event)));
    editor.addEventListener("mouseleave", hideHoverPreview);
    editor.addEventListener("paste", guard((event) => pasteIntoEditor(node, editor, event)));

    toggle.addEventListener("pointerdown", (event) => { event.preventDefault(); event.stopPropagation(); });
    toggle.addEventListener("click", guard((event) => {
        event.preventDefault();
        event.stopPropagation();
        setRawMode(node, !node.__dnpRaw);
    }));

    const uiWidget = node.addDOMWidget(UI_WIDGET, "dnp_prompt", wrap, {
        serialize: false,
        hideOnZoom: false,
        getValue: () => String(widget.value ?? ""),
        setValue: (value) => {
            widget.value = value ?? "";
            if (!node.__dnpRaw) renderFromWidget(node);
        },
    });
    node.__dnpWidget = uiWidget;
    if (uiWidget) {
        // 高度跟着节点走：节点拉高，编辑区就变高
        uiWidget.computeSize = (width) => [width || node.size?.[0] || 380, freeHeight(node)];
    }

    hideNative(widget);
    applyRawMode(node, Boolean(node.properties?.[RAW_PROP]));
    renderFromWidget(node);
    node.__dnpMedia = resolveMedia(node);
    updateFilterWarn(node);
    fitHeight(node);
    [220, 900, 1800].forEach((delay) => setTimeout(() => {
        if (!node.__dnpEditor) return;
        if (!editorFocused(node)) renderFromWidget(node);
        fitHeight(node);
    }, delay));
}

function applyRawMode(node, raw) {
    node.__dnpRaw = raw;
    const widget = getWidget(node, WIDGET_NAME);
    const wrap = node.__dnpWrap;
    const editor = node.__dnpEditor;
    const rawBox = node.__dnpRawBox;
    if (!wrap || !widget) return;
    const src = raw ? editor : rawBox;      // 即将隐藏的那块（滚动位置的来源）
    const dst = raw ? rawBox : editor;      // 即将露出来的那块
    const progress = scrollProgress(src);
    node.properties = node.properties || {};
    node.properties[RAW_PROP] = raw;
    // 原生输入框永远不露脸（它只负责 widgets_values 序列化）——原文模式用我们自己的 textarea，
    // 这样两个状态都在同一个位置（节点下方），切来切去不会"跳上去"。
    hideNative(widget);
    if (raw) {
        hideBox(editor);
        showBox(rawBox);
        // 改 value 会把 textarea 的 scrollTop 归零——没关系，下面统一按进度写回
        if (rawBox.value !== String(widget.value ?? "")) rawBox.value = String(widget.value ?? "");
    } else {
        hideBox(rawBox);
        showBox(editor);
        renderFromWidget(node);             // 清空重排，同样会把 scrollTop 归零，也由下面统一写回
    }
    if (node.__dnpToggle) node.__dnpToggle.textContent = raw ? "美化" : "原文";
    fitHeight(node);
    // 顺序不能提前：renderFromWidget 会清空重排、fitHeight 改高度，两者都会把 scrollTop 归零。
    syncScrollAfterSwitch(node, src, dst, progress);
    node.setDirtyCanvas?.(true, true);
}

/** 编辑器可用高度 = 节点高度 − 其它控件占掉的高度 − 标题栏等固定开销。 */
function freeHeight(node) {
    const self = node.__dnpWidget;
    const width = node.size?.[0] || 380;
    let used = 0;
    for (const other of node.widgets || []) {
        if (other === self || other.hidden) continue;
        let h = 20;
        try {
            if (other.computeSize) h = Number(other.computeSize(width)?.[1]) || 20;
        } catch (error) {
            h = 20;
        }
        used += Math.max(0, h);
    }
    return Math.max(150, Math.round((node.size?.[1] || 540) - used - 62));
}

/** 让编辑区跟着节点缩放（用户反馈：美化状态下不跟随节点大小）。 */
function fitHeight(node) {
    if (!node) return;
    const height = freeHeight(node);
    const inner = Math.max(90, height - 26);
    if (node.__dnpWrap) node.__dnpWrap.style.height = `${height}px`;
    if (node.__dnpEditor) node.__dnpEditor.style.height = `${inner}px`;
    if (node.__dnpRawBox) node.__dnpRawBox.style.height = `${inner}px`;
    if (node.__dnpWidget) node.__dnpWidget.last_y = node.__dnpWidget.last_y ?? 0;
}

function setRawMode(node, raw) {
    applyRawMode(node, raw);
}

/** 滑杆进度同步（原文 textarea ↔ 美化 contenteditable）。
 *
 *  两块是**各自独立滚动**的容器，同一时刻只显示一块，所以没法实时联动；
 *  但每次切换都该把"看到哪儿了"带过去，否则改一个字就要重新找位置。
 *
 *  ⚠️ **滚轮和拖滑杆不是一回事**（2026-09-18 用户反馈 + 实机实测）：
 *  - 拖滑杆由主线程驱动，scrollTop 是同步更新的 → 切换时读到的就是真值；
 *  - 滚轮走**合成器线程**，主线程的 scrollTop 要等这轮滚动落地才更新
 *    （实测：滚完立刻读还是旧值，约 1 帧后才对；真机开着平滑滚动会更久）。
 *    切换那一刻读到的可能是"滚动之前"的值（常常是 0）→ 表现成"滚轮滚的进度丢了"。
 *
 *  所以隐藏那一块**不能用 display:none**（会连 scrollTop 一起抹掉，之后就再也补读不回来），
 *  改用 `.dnp-off`（脱离布局 + visibility:hidden，排版和 scrollTop 都还在）；
 *  切换后由 syncScrollAfterSwitch() 继续盯一小段时间，等滚动落地再补齐一次。 */
function scrollProgress(el) {
    if (!el) return null;                                 // null = 没有来源，别去动目标
    const span = (el.scrollHeight || 0) - (el.clientHeight || 0);
    if (!(span > 0)) return 0;                            // 没有可滚区间 → 就是顶部
    return Math.min(1, Math.max(0, (el.scrollTop || 0) / span));
}

/** 把进度写回另一块，返回是否写成功。
 *
 *  ⚠️ **0 是合法进度**（滚到最顶端）。早期版本用 `if (!(progress > 0)) return` 做守卫，
 *  结果"滚到最上边再切模式"时这一写被吞掉，目标块保留上一次的 scrollTop
 *  → 看起来就是"跳回之前滑杆的高度"（2026-09-18 用户反馈：只有滚到最上边才异常）。
 *  "没有来源"改用 null 表示，与"进度为 0"彻底分开。
 *
 *  读 scrollHeight 会强制排版，所以调用点必须在内容/高度都定下来之后。 */
function applyScrollProgress(el, progress) {
    if (!el || progress === null || progress === undefined) return false;
    const span = (el.scrollHeight || 0) - (el.clientHeight || 0);
    if (!(span > 0)) return false;
    el.scrollTop = progress * span;
    return true;
}

function hideBox(el) { if (el) el.classList.add(OFF_CLASS); }
function showBox(el) { if (el) el.classList.remove(OFF_CLASS); }

/** 切换后把进度搬到目标，并**继续盯 0.8 秒**：滚轮那一下的偏移可能还在合成器里没回传，
 *  等它落地后按同一个比例再补一次。用户要是自己滚了目标，立刻收手。 */
const SCROLL_SYNC_WINDOW_MS = 800;

function syncScrollAfterSwitch(node, src, dst, progress) {
    if (node.__dnpSyncRaf) { cancelAnimationFrame(node.__dnpSyncRaf); node.__dnpSyncRaf = 0; }
    if (!src || !dst) return;
    let pending = !applyScrollProgress(dst, progress);   // 首写失败（目标这会儿还没有可滚区间）→ 下一帧再补
    let applied = dst.scrollTop;
    let lastSrc = src.scrollTop;
    const t0 = performance.now();
    const tick = () => {
        node.__dnpSyncRaf = 0;
        if (performance.now() - t0 > SCROLL_SYNC_WINDOW_MS) return;
        // 目标已经写好了、又被别人动了 → 用户自己在滚目标，收手别抢
        if (!pending && Math.abs(dst.scrollTop - applied) > 1) return;
        const st = src.scrollTop;
        if (pending || st !== lastSrc) {                 // 源的滚动落地了（滚轮那一下回传慢）→ 补一次
            lastSrc = st;
            pending = !applyScrollProgress(dst, scrollProgress(src));
            applied = dst.scrollTop;
        }
        node.__dnpSyncRaf = requestAnimationFrame(tick);
    };
    node.__dnpSyncRaf = requestAnimationFrame(tick);
}

/* ================================================================
 * 5. 输入时把 token 就地变成 chip（不整篇重排，光标不跳）
 * ================================================================ */

const CARET_RULES = [
    { re: /<(Picture|Video|Audio)\s+(\d+)>$/, make: (m) => ({ kind: "chip", type: m[1], ordinal: Number(m[2]) }) },
    { re: /<Subject\s+(\d+)>(?:\s*\(\s*S(\d+)\s*\))?$/, make: (m) => ({ kind: "subject", n: Number(m[1]), sid: m[2] ? Number(m[2]) : null }) },
    { re: /\[Shot\s+(\d+)\]$/, make: (m) => ({ kind: "shot", n: Number(m[1]) }) },
];

/** 取"编辑区里真正的那个选区"。
 *
 *  实测（本机前端 1.51 + Vue 的 .dom-widget 层）：**真实鼠标点击进编辑区之后，
 *  `document.getSelection()` 会被钳制成宿主外层** —— startContainer 落在 `.dom-widget`，
 *  `editor.contains()` 为 false；而编辑区自己的**影子选区才是真的**
 *  （`shadowRoot.getSelection()` → startContainer 是编辑区里的文本节点，位置也正确）。
 *  所有"读光标"的地方都必须走这里，否则会出现：@ 菜单不弹、粘贴被当成"光标在框外"而粘到末尾。
 *  写回仍用 document 的那个（已验证能把光标真的落进去）。 */
function caretSelection(editor) {
    const root = editor?.getRootNode?.();
    if (root && root !== document && typeof root.getSelection === "function") {
        const scoped = root.getSelection();
        if (scoped && scoped.rangeCount) return scoped;
    }
    return window.getSelection?.() || null;
}

function caretTextNode(editor) {
    const sel = caretSelection(editor);
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const container = range.startContainer;
    if (container.nodeType === Node.TEXT_NODE && editor.contains(container)) {
        return { range, container, offset: range.startOffset };
    }
    // 光标落在元素边界上（比如紧跟在 chip 后面、或行尾）时，用文本偏移定位。
    const info = caretTextBefore(editor);
    if (!info) return null;
    const spot = locate(editor, info.offset);
    if (!spot) return null;
    return { range, container: spot.node, offset: spot.offset };
}

/** 光标前的整段文本（不含元素内部的原子文本之外的东西）。 */
function caretTextBefore(editor) {
    const sel = caretSelection(editor);
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const caret = sel.getRangeAt(0);
    if (!editor.contains(caret.startContainer)) return null;
    const probe = document.createRange();
    probe.selectNodeContents(editor);
    try { probe.setEnd(caret.startContainer, caret.startOffset); } catch (error) { return null; }
    return { caret, offset: probe.toString().length, text: probe.toString() };
}

/** 文本偏移 → {node, offset}。 */
function locate(editor, offset) {
    let acc = 0;
    let last = null;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const len = node.textContent.length;
        if (offset <= acc + len) return { node, offset: Math.max(0, offset - acc) };
        acc += len;
        last = node;
    }
    return last ? { node: last, offset: last.textContent.length } : null;
}

/** 光标前 len 个字符对应的 Range（跨文本节点）。 */
function rangeBeforeCaret(editor, len) {
    const info = caretTextBefore(editor);
    if (!info) return null;
    const start = info.offset - len;
    if (start < 0) return null;
    const a = locate(editor, start);
    const b = locate(editor, info.offset);
    if (!a || !b) return null;
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return range;
}

function convertAtCaret(node, editor) {
    const info = caretTextBefore(editor);
    if (!info) return false;
    const before = info.text;
    const media = node.__dnpMedia || resolveMedia(node);

    for (const rule of CARET_RULES) {
        const m = before.match(rule.re);
        if (!m) continue;
        const spec = rule.make(m);
        const range = rangeBeforeCaret(editor, m[0].length);
        if (!range) continue;
        const dialog = range.startContainer.parentElement?.closest?.(`.${DIALOGUE_CLASS}`);
        if (dialog && spec.kind === "shot") continue;
        range.deleteContents();
        let el = null;
        if (spec.kind === "chip") {
            el = makeChip(spec.type, media, spec.ordinal);
        } else if (spec.kind === "shot") {
            el = makeShotEl(m[0], spec.n);
        } else if (spec.kind === "subject") {
            el = makeSubjectEl(m[0], spec.n, spec.sid, media);
        } else {
            // 未知类型：把删掉的内容原样补回去，绝不弄丢用户的字
            el = document.createTextNode(m[0]);
            range.insertNode(el);
            caretAfterEl(el, editor);
            return false;
        }
        range.insertNode(el);
        caretAfterEl(el, editor);
        return true;
    }

    // 【对话】→ 对话块
    const bracket = before.match(/【([^】]{0,400})】$/);
    if (bracket) {
        const range = rangeBeforeCaret(editor, bracket[0].length);
        if (range && !range.startContainer.parentElement?.closest?.(`.${DIALOGUE_CLASS}`)) {
            range.deleteContents();
            const head = before.slice(0, before.length - bracket[0].length);
            const block = makeDialogue(bracket[1], speakerBeforeCaret(media, head), media);
            range.insertNode(block);
            caretAfterEl(block, editor);
            return true;
        }
    }
    return false;
}

/** 造一个 (文本节点, 偏移) 的 Range。 */
function rangeAt(node, offset) {
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    return range;
}

/** 把"元素容器 + 下标"的等价位置换算成**文本节点位置**；换算不出来返回 null。
 *
 *  **为什么必须这样**：实测本机前端下，`document` 级选区**不接受容器是元素**的位置
 *  （editor / 影子根的直接子元素）—— 写进去会被直接钳到 `.dom-widget`（等于没写），
 *  而**容器是文本节点**的位置两级选区都认。
 *  症状就是：光标其实没动 → 之后打的字/粘贴的内容全落到错误的地方（例如空格插进对话块里）。 */
function textPositionFor(node, offset) {
    if (!node) return null;
    if (node.nodeType === 3) return { node, offset };
    const kids = node.childNodes || [];
    const next = kids[offset];
    if (next && next.nodeType === 3) return { node: next, offset: 0 };
    const prev = kids[offset - 1];
    if (prev && prev.nodeType === 3) return { node: prev, offset: prev.textContent.length };
    return null;
}

/** 确保 el 末尾有一个**非空**（至少含零宽占位）的文本节点，并返回它。
 *
 *  不能用空文本节点：Chrome 会把"空文本节点上的位置"规范化成**元素容器位置**，
 *  而那类位置**算不出 caret 矩形**（实测 `{0,0,0,0}`）→ 光标显示到框外（见 ZWSP 的说明）。 */
function ensureCaretTextNode(el) {
    const last = el.lastChild;
    if (last && last.nodeType === 3) {
        if (!last.textContent.length) last.textContent = ZWSP;
        return last;
    }
    const filler = document.createTextNode(ZWSP);
    el.append(filler);
    return filler;
}

/** 编辑器的末尾（落在最后一个文本节点里；没有就补一个可落光标的）。 */
function caretToEnd(editor) {
    if (!editor) return;
    let last = null;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) last = n;
    if (!last) last = ensureCaretTextNode(editor);
    else if (!last.textContent.length) last.textContent = ZWSP;
    setCaretRange(editor, rangeAt(last, last.textContent.length));
}

/** 把光标放到 el 之后。el 若不在编辑器里（例如被插到影子根上）就退到编辑器末尾 ——
 *  **光标绝不允许留在编辑框之外**，否则后面敲的字、粘贴的字全都会掉到框外（用户实测报过）。
 *
 *  el 后面没有现成文本时（例如刚插完对话块、后面是空的），**补一个零宽占位当落点**：
 *  空文本节点没布局、元素位置又会被钳掉，两种都落不住光标 —— 结果是"光标原地不动，
 *  之后的字全跑进上一个块里"（实测：`【你好】` 写完再打「尾巴」会进对话块）。 */
function caretAfterEl(el, editor) {
    try {
        if (!el || !el.parentNode || (editor && !editor.contains(el))) { caretToEnd(editor); return; }
        const parent = el.parentNode;
        const idx = Array.prototype.indexOf.call(parent.childNodes, el);
        let spot = textPositionFor(parent, idx + 1);
        if (!spot) {
            const next = parent.childNodes[idx + 1];
            if (next && next.nodeType === 3) {
                spot = { node: next, offset: 0 };
            } else {
                const filler = document.createTextNode(ZWSP);
                parent.insertBefore(filler, next || null);
                spot = { node: filler, offset: ZWSP.length };
            }
        }
        setCaretRange(editor, rangeAt(spot.node, spot.offset));
    } catch (error) {
        warn(error);
    }
}

/** 把 range 写进选区：document 级和影子级都写一遍（同一个 range），
 *  保证浏览器自己的编辑命令（方向键、输入）与我们读到的位置一致。 */
function setCaretRange(editor, range) {
    const doc = window.getSelection?.();
    const root = editor?.getRootNode?.();
    if (doc) { try { doc.removeAllRanges(); doc.addRange(range); } catch (error) { warn(error); } }
    if (root && root !== document && typeof root.getSelection === "function") {
        const scoped = root.getSelection();
        if (scoped && scoped !== doc) {
            try { scoped.removeAllRanges(); scoped.addRange(range); } catch (error) { warn(error); }
        }
    }
}

/** 光标是否确实在编辑器内部（读的是影子选区，见 caretSelection）。 */
function caretInside(editor) {
    const sel = caretSelection(editor);
    if (!sel || !sel.rangeCount) return false;
    return Boolean(editor?.contains(sel.getRangeAt(0).startContainer));
}

/** 在光标处插入纯文本。**光标不在编辑器里就先把它拽回编辑器末尾**，
 *  否则粘贴/换行会掉到编辑框外面去（用户实测报过"字跑到框外"）。 */
function insertTextAtCaret(editor, text) {
    if (!caretInside(editor)) {
        caretAfterEl(null, editor);
        if (!caretInside(editor)) return;
    }
    const sel = caretSelection(editor);           // 读：必须用影子选区（document 级会被钳到框外）
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    caretAfterEl(node, editor);
}

/* ================================================================
 * 6. @ 提及菜单
 * ================================================================ */

function mentionOptions(node) {
    const media = node.__dnpMedia || resolveMedia(node);
    const out = [];
    for (const p of media.pictures) {
        out.push({
            id: `img${p.ordinal}`,
            type: "image",
            label: `图片 ${p.ordinal}`,
            sub: p.role || p.filename || "",
            url: p.url,
            token: `<Picture ${p.ordinal}>`,
            insert: "chip",
            kind: "Picture",
            ordinal: p.ordinal,
        });
    }
    for (const a of media.audios) {
        out.push({
            id: `aud${a.ordinal}`,
            type: "audio",
            label: `音频 ${a.ordinal}`,
            sub: a.role || a.filename || "",
            token: `<Audio ${a.ordinal}>`,
            insert: "chip",
            kind: "Audio",
            ordinal: a.ordinal,
        });
    }
    for (const name of media.assets) {
        out.push({ id: `asset:${name}`, type: "asset", label: name, sub: "资产名", token: name, insert: "text" });
    }
    return out;
}

function mentionQuery(editor) {
    const info = caretTextBefore(editor);
    if (!info) return null;
    const m = info.text.match(/@([^\s@<>{}\[\]]{0,12})$/);
    if (!m) return null;
    const range = rangeBeforeCaret(editor, m[0].length);
    if (!range) return null;
    return { query: m[1], range };
}

function closeMenu() {
    const menu = document.getElementById(MENU_CLASS);
    if (menu) menu.remove();
    activeMenu = null;
}

let activeMenu = null;

function openMenu(node, editor) {
    const q = mentionQuery(editor);
    if (!q) { closeMenu(); return; }
    const options = mentionOptions(node).filter((opt) => {
        if (!q.query) return true;
        const hay = `${opt.label} ${opt.sub || ""}`.toLowerCase();
        return hay.includes(q.query.toLowerCase());
    });
    if (!options.length) { closeMenu(); return; }

    let menu = document.getElementById(MENU_CLASS);
    if (!menu) {
        menu = document.createElement("div");
        menu.id = MENU_CLASS;
        menu.className = MENU_CLASS;
        document.body.append(menu);
    }
    menu.textContent = "";
    activeMenu = { node, editor, options, query: q, active: 0 };
    options.forEach((opt, index) => {
        const item = document.createElement("div");
        item.className = "dnp-menu-item";
        if (index === activeMenu.active) item.classList.add("is-active");
        const head = document.createElement("div");
        head.className = "dnp-menu-head";
        if (opt.url) {
            const img = document.createElement("img");
            img.src = opt.url;
            img.className = "dnp-menu-thumb";
            img.alt = "";
            head.append(img);
        } else {
            const icon = document.createElement("span");
            icon.className = "dnp-menu-icon";
            icon.textContent = opt.type === "audio" ? "🔊" : opt.type === "asset" ? "🏷" : "🖼";
            head.append(icon);
        }
        const title = document.createElement("span");
        title.className = "dnp-menu-title";
        title.textContent = opt.label;
        head.append(title);
        const sub = document.createElement("span");
        sub.className = "dnp-menu-sub";
        sub.textContent = opt.sub ? `· ${opt.sub}` : "";
        head.append(sub);
        item.append(head);
        item.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            insertMention(activeMenu, index);
        });
        menu.append(item);
    });

    // 定位到 @ 所在位置下方
    const rect = mentionCaretRect(q);
    menu.style.left = `${Math.round(Math.min(rect.left, window.innerWidth - 280))}px`;
    menu.style.top = `${Math.round(Math.min(rect.bottom + 4, window.innerHeight - 220))}px`;
}

function mentionCaretRect(q) {
    try {
        const rect = q.range.getBoundingClientRect();
        if (rect && (rect.width || rect.height)) return rect;
    } catch (error) {
        warn(error);
    }
    return { left: 80, bottom: 200 };
}

function insertMention(menuState, index) {
    if (!menuState) return;
    const opt = menuState.options[index];
    if (!opt) return;
    const editor = menuState.editor;
    const range = menuState.query.range.cloneRange();
    range.deleteContents();
    const el = opt.insert === "chip"
        ? makeChip(opt.kind, menuState.node.__dnpMedia, opt.ordinal)
        : document.createTextNode(opt.token);
    range.insertNode(el);
    caretAfterEl(el, editor);
    syncToWidget(menuState.node);
    pushHistory(menuState.node);
    closeMenu();
}

function handleMenuKey(node, event) {
    if (!activeMenu || activeMenu.node !== node) return false;
    const { options } = activeMenu;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        activeMenu.active = (activeMenu.active + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
        document.querySelectorAll(`#${MENU_CLASS} .dnp-menu-item`).forEach((el, i) => {
            el.classList.toggle("is-active", i === activeMenu.active);
            if (i === activeMenu.active) el.scrollIntoView({ block: "nearest" });
        });
        return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
        insertMention(activeMenu, activeMenu.active);
        return true;
    }
    if (event.key === "Escape") {
        closeMenu();
        return true;
    }
    return false;
}

/* ================================================================
 * 7. 悬停放大缩略图
 * ================================================================ */

function hoverPreviewEl() {
    let el = document.getElementById(PREVIEW_ID);
    if (!el) {
        el = document.createElement("div");
        el.id = PREVIEW_ID;
        el.className = "dnp-hover-preview";
        const img = document.createElement("img");
        img.alt = "";
        const cap = document.createElement("div");
        cap.className = "dnp-hover-caption";
        el.append(img, cap);
        document.body.append(el);
        el.__img = img;
        el.__cap = cap;
    }
    return el;
}

function updateHoverPreview(event) {
    const target = event.target?.closest?.(`.${CHIP_CLASS}, .${SHOT_CLASS}, .${DIALOGUE_CLASS}`);
    const editor = event.currentTarget;
    if (target?.classList?.contains(SHOT_CLASS)) {
        showHoverText(target, editor, "镜头时间轴：模型会按 <Picture N> / 对话的顺序在这里切镜");
        return;
    }
    if (target?.classList?.contains(DIALOGUE_CLASS)) {
        showHoverText(target, editor, "对话块 → 输出为 <d>[语言] 台词</d>（H3 硬规则，语言标记别删）");
        return;
    }
    if (!target?.classList?.contains(CHIP_CLASS)) { hideHoverPreview(); return; }
    const img = target.querySelector(".dnp-chip-thumb");
    const url = img?.src;
    if (!url) {
        const label = target.querySelector(".dnp-chip-label")?.textContent || "";
        showHoverText(target, editor, target.title || label);
        return;
    }
    const el = hoverPreviewEl();
    el.__img.src = url;
    el.__img.style.display = "";
    el.__cap.textContent = (target.title || "").split("\n").join(" · ");
    el.classList.add("is-open");
    positionHoverPreview(el, target);
}

function showHoverText(target, editor, text) {
    const el = hoverPreviewEl();
    el.__img.removeAttribute("src");
    el.__img.style.display = "none";
    el.__cap.textContent = text || "";
    el.classList.add("is-open");
    positionHoverPreview(el, target);
}

function positionHoverPreview(el, target) {
    const rect = target.getBoundingClientRect();
    const width = el.offsetWidth || 264;
    const height = el.offsetHeight || 200;
    let left = rect.left;
    let top = rect.bottom + 8;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8);
    el.style.left = `${Math.round(Math.max(8, left))}px`;
    el.style.top = `${Math.round(top)}px`;
}

function hideHoverPreview() {
    const el = document.getElementById(PREVIEW_ID);
    if (el) el.classList.remove("is-open");
}

/* ================================================================
 * 8. 撤销栈（contenteditable + 局部改 DOM 会弄乱浏览器自带栈，自己来）
 * ================================================================ */

function pushHistory(node) {
    const editor = node.__dnpEditor;
    if (!editor) return;
    const state = { text: serializeEditor(editor), caret: caretOffset(editor) };
    const stack = node.__dnpHistory = node.__dnpHistory || [];
    const last = stack[stack.length - 1];
    if (last && last.text === state.text) return;
    stack.push(state);
    if (stack.length > 120) stack.shift();
    node.__dnpHistoryIndex = stack.length - 1;
}

function caretOffset(editor) {
    const sel = caretSelection(editor);       // 读光标一律走影子选区
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return null;
    const probe = range.cloneRange();
    probe.selectNodeContents(editor);
    probe.setEnd(range.endContainer, range.endOffset);
    return probe.toString().length;
}

function restoreOffset(editor, offset) {
    if (offset == null) return;
    let remaining = offset;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
        const len = node.textContent.length;
        if (remaining <= len) {
            const range = document.createRange();
            range.setStart(node, remaining);
            range.collapse(true);
            setCaretRange(editor, range);
            return;
        }
        remaining -= len;
        node = walker.nextNode();
    }
    // 一个文本节点都没走到（空文档 / 全是原子 token）→ 放回编辑器里，别让光标留在框外
    caretAfterEl(null, editor);
}

function handleHistoryKey(node, event) {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || String(event.key).toLowerCase() !== "z") return false;
    const stack = node.__dnpHistory || [];
    if (!stack.length) return false;
    let index = node.__dnpHistoryIndex ?? stack.length - 1;
    index = event.shiftKey ? index + 1 : index - 1;
    if (index < 0 || index >= stack.length) {
        event.preventDefault();
        return true;
    }
    node.__dnpHistoryIndex = index;
    const state = stack[index];
    const editor = node.__dnpEditor;
    renderInto(editor, state.text, node.__dnpMedia || { pictures: [], videos: [], audios: [], assets: [] });
    restoreOffset(editor, state.caret);
    syncToWidget(node);
    event.preventDefault();
    return true;
}

/* ================================================================
 * 9. 样式
 * ================================================================ */

const STYLE_ID = "dn-prompt-rich-style";

/* 全部样式：既注入 document.head（给挂在 body 上的 @菜单 / 悬停大图用），
   也塞进每个编辑器自己的 shadow root（样式不跨影子边界）。 */
const CSS_TEXT = `
.dnp-root { display:flex; flex-direction:column; gap:4px; width:100%; box-sizing:border-box; padding:2px 0 0; font-size:12px; position:relative; }
.dnp-bar { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
.dnp-toggle { font-size:11px; line-height:1.4; padding:1px 8px; border-radius:999px; cursor:pointer;
  border:1px solid var(--border-color,#4b5563); background:rgba(255,255,255,.06); color:var(--input-text,#e5e7eb); }
.dnp-toggle:hover { background:rgba(255,255,255,.14); }
.dnp-hint { font-size:10px; opacity:.55; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
/* 「不计入编号」提示条：默认不显示，updateFilterWarn() 按需点亮（规则见 resolveMedia） */
.dnp-filter-warn { display:none; flex:0 0 auto; padding:5px 9px; border-radius:6px;
  font-size:11px; line-height:1.6; border:1px solid rgba(245,185,66,.5);
  background:rgba(245,185,66,.14); color:#f5b942; }
.dnp-filter-warn.dnp-show { display:block; }
.dnp-editor, .dnp-raw { position:relative; width:100%; box-sizing:border-box; padding:6px 8px;
  border:1px solid var(--border-color,#4b5563); border-radius:6px;
  /* 底色与字号都对齐 ComfyUI 原生文本框（--comfy-input-bg 默认 #222，--comfy-textarea-font-size 本机 15px） */
  background:var(--comfy-input-bg,#222);
  color:var(--input-text,#e5e7eb); font-size:var(--comfy-textarea-font-size,12px); line-height:1.7;
  white-space:pre-wrap; word-break:break-word;
  overflow-wrap:anywhere; overflow-y:auto; outline:none; resize:none; font-family:inherit; }
.dnp-editor { cursor:text; }
.dnp-raw { display:block; }
/* 非当前模式的那一块：**绝对不能用 display:none**——那会把它的 scrollTop 抹掉，
   切换后就再也补读不回真实滚动位置（滚轮走合成器线程、偏移滞后于主线程，见 scrollProgress 一节）。
   这里改成「脱离布局 + 不可见」：仍在排版中、scrollTop 保留、也接不到鼠标。 */
.dnp-off { position:absolute; left:0; right:0; top:0; visibility:hidden; pointer-events:none; }
.dnp-editor:empty::before { content:"在这里写 H3 六段式提示词：subject_definitions / summary / detailed_description …";
  opacity:.35; pointer-events:none; }
.dnp-editor:focus, .dnp-raw:focus { border-color:#7dd3fc; box-shadow:0 0 0 1px rgba(125,211,252,.35); }
/* 图片 / 音频 / 视频 chip 统一浅蓝 */
/* 全篇统一用正文字体/字号：行内 token 一律 font-size:inherit、不指定 font-family，
   免得 chip / 镜头 / 对话 各用一种字体字号看着"乱七八糟"。 */
.dnp-chip { display:inline-flex; align-items:center; gap:4px; margin:0 1px; padding:0 6px 0 2px;
  border-radius:999px; font-size:inherit; line-height:1.5; vertical-align:baseline;
  border:1px solid rgba(125,211,252,.75); background:rgba(125,211,252,.22); color:#e0f2fe; cursor:default; }
.dnp-chip-icon, .dnp-shot-icon, .dnp-dialogue-icon { display:inline-flex; align-items:center; justify-content:center;
  width:1.1em; height:1.1em; flex:0 0 auto; }
.dnp-icon { width:100%; height:100%; display:block; }
.dnp-chip-thumb { width:1.1em; height:1.1em; border-radius:3px; object-fit:cover; display:block; }
.dnp-chip-label { white-space:nowrap; }
/* Subject 标签：**不加底色**，除了前面那个缩写，其余和资产名长得一模一样（同字重、同颜色） */
.dnp-subject { display:inline; padding:0; background:none; border:none;
  font-family:inherit; font-size:inherit; font-weight:700; }
.dnp-subject-id { opacity:.72; font-weight:600; }
.dnp-shot { display:inline-flex; align-items:center; gap:3px; padding:0 6px; border-radius:6px; font-weight:700;
  font-size:inherit; background:rgba(245,185,66,.20); border:1px solid rgba(245,185,66,.55); color:#f5b942; }
.dnp-time { color:#fbbf24; font-variant-numeric:tabular-nums; font-weight:600; }
/* 六段式标题：底色淡一档 + 左侧竖线回来（亮度与底色同档，不刺眼） */
.dnp-heading { font-weight:700; border-left:3px solid rgba(148,163,184,.5);
  padding:1px 8px 1px 6px; border-radius:3px;
  background:linear-gradient(90deg, rgba(148,163,184,.26), rgba(148,163,184,.10) 70%, rgba(148,163,184,.02)); }
.dnp-asset { font-weight:700; }
/* 对话：底色按说话人资产名着色；认不出说话人则紫色（0.7 饱和度）。气泡图标是内联 SVG，随说话人颜色 */
.dnp-dialogue { display:inline; padding:1px 6px 1px 5px; border-radius:6px;
  border-left:3px solid var(--border-color,#6b7280); }
.dnp-dialogue-icon { margin-right:4px; vertical-align:-0.12em; }
.dnp-lang { color:#93c5fd; font-weight:700; font-size:inherit; background:rgba(59,130,246,.22); border-radius:3px; padding:0 3px; margin-right:4px; }
.dnp-lang.is-hidden { display:none; }
#dnp-menu { position:fixed; z-index:100000; width:268px; max-height:220px; overflow:auto; padding:4px;
  border-radius:8px; background:#1b1f2a; border:1px solid rgba(148,163,184,.35); box-shadow:0 8px 24px rgba(0,0,0,.45); }
.dnp-menu-item { display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:6px; cursor:pointer; }
.dnp-menu-item.is-active, .dnp-menu-item:hover { background:rgba(245,185,66,.18); }
.dnp-menu-head { display:flex; align-items:center; gap:6px; min-width:0; }
.dnp-menu-thumb { width:26px; height:26px; border-radius:5px; object-fit:cover; }
.dnp-menu-icon { width:26px; text-align:center; }
.dnp-menu-title { font-size:12px; color:#e5e7eb; }
.dnp-menu-sub { font-size:10px; opacity:.6; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dnp-hover-preview { position:fixed; z-index:100001; display:none; padding:6px; border-radius:10px;
  background:rgba(12,16,24,.96); border:1px solid rgba(245,185,66,.5); box-shadow:0 12px 30px rgba(0,0,0,.55);
  pointer-events:none; max-width:280px; }
.dnp-hover-preview.is-open { display:block; }
.dnp-hover-preview img { display:block; max-width:264px; max-height:264px; border-radius:6px; }
.dnp-hover-caption { margin-top:4px; font-size:10px; color:#e5e7eb; opacity:.85; line-height:1.5; }
`;

function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS_TEXT;
    document.head.append(style);
}

/** shadow root 专用的样式元素（同一个 <style> 不能同时挂在两棵树里）。 */
function shadowStyleEl() {
    const style = document.createElement("style");
    style.textContent = CSS_TEXT;
    return style;
}

/** 剪贴板里是"复制的节点 / 工作流"的 JSON 吗（那种一大坨不能塞进提示词）。 */
function looksLikeGraphJson(text) {
    const at = String(text || "").indexOf("{");
    if (at < 0) return false;
    try {
        const data = JSON.parse(text.slice(at));
        return Boolean(data && data.nodes && (data.version || data.extra));
    } catch (error) {
        return false;
    }
}

/** 统一入口：把剪贴板纯文本插到光标处。
 *  历史坑：前端 `usePaste` 挂在 document 上、忽略条件只认 textarea/input，contenteditable 不在名单里
 *  → 粘贴会顺手把"之前复制的节点"贴进画布。所以这里一律 preventDefault 自己处理。
 *  注意：`paste` 事件**不是 composed**，编辑器搬进影子树后 window/document 都收不到它，
 *  真正生效的是**挂在编辑器自身**上的那个监听；window 上那个只是给 light-DOM 情形的保险。 */
function pasteIntoEditor(node, editor, event) {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (looksLikeGraphJson(text)) return;
    insertTextAtCaret(editor, text);
    syncToWidget(node);
    pushHistory(node);
}

/** 从粘贴事件里找出"落在哪个编辑器上"（影子树里 composedPath 才看得到真身）。 */
function pasteTargetFromEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    const byClass = (cls) => path.find((n) => n?.nodeType === 1 && n.classList?.contains(cls));
    const editorEl = byClass(EDITOR_CLASS);
    if (editorEl) return { node: editorEl.__dnpPromptNode, editorEl, rawEl: null };
    const rawEl = byClass(RAW_CLASS);
    if (rawEl) return { node: rawEl.__dnpPromptNode, editorEl: null, rawEl };
    const hostEl = byClass(ROOT_CLASS);
    if (hostEl) {
        const scope = hostEl.shadowRoot || hostEl;
        return {
            node: hostEl.__dnpPromptNode,
            editorEl: scope.querySelector?.(`.${EDITOR_CLASS}`) || null,
            rawEl: scope.querySelector?.(`.${RAW_CLASS}`) || null,
        };
    }
    const el = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    const fallback = el?.closest?.(`.${EDITOR_CLASS}, .${RAW_CLASS}`);
    if (fallback) {
        return fallback.classList.contains(RAW_CLASS)
            ? { node: fallback.__dnpPromptNode, editorEl: null, rawEl: fallback }
            : { node: fallback.__dnpPromptNode, editorEl: fallback, rawEl: null };
    }
    return null;
}

/** 粘贴守卫：前端 usePaste 挂在 document 上，忽略条件只认 textarea/input，
 *  contenteditable 不在名单里 → 粘贴会顺手把之前复制的节点贴进画布。
 *  这里在 window 的"捕获阶段"抢先处理（早于 document 的冒泡监听）并掐断后续监听。
 *  注意：编辑器在 shadow root 里，宿主之外看到的 event.target 会被重定向，所以走 composedPath 找真身。 */
function installPasteGuard() {
    if (window.__dnpPasteGuard) return;
    window.__dnpPasteGuard = true;
    window.addEventListener("paste", (event) => {
        const info = pasteTargetFromEvent(event);
        if (!info) return;
        event.stopImmediatePropagation?.();
        // 隐藏的那块用 .dnp-off（visibility），它的 offsetParent 依然非空，不能再拿 offsetParent 判可见
        const rawEl = info.rawEl && !info.rawEl.classList.contains(OFF_CLASS) ? info.rawEl : null;
        if (rawEl) {
            event.preventDefault();
            const text = event.clipboardData?.getData("text/plain") ?? "";
            const start = rawEl.selectionStart ?? rawEl.value.length;
            const end = rawEl.selectionEnd ?? start;
            rawEl.value = `${rawEl.value.slice(0, start)}${text}${rawEl.value.slice(end)}`;
            rawEl.selectionStart = rawEl.selectionEnd = start + text.length;
            rawEl.dispatchEvent(new Event("input", { bubbles: true }));
            return;
        }
        const node = info.node || info.editorEl?.__dnpPromptNode;
        const editor = info.editorEl || node?.__dnpEditor;
        if (!node || !editor) { event.preventDefault(); return; }
        pasteIntoEditor(node, editor, event);
    }, true);
}

/* ================================================================
 * 10. 注册
 * ================================================================ */

function installNode(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS || nodeType.prototype.__dnpInstalled) return;
    nodeType.prototype.__dnpInstalled = true;

    const originalCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        const result = originalCreated?.apply(this, arguments);
        try { installStyles(); ensureEditor(this); } catch (error) { warn(error); }
        return result;
    };

    const originalConfigured = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
        const result = originalConfigured?.apply(this, arguments);
        try {
            installStyles();
            ensureEditor(this);
            this.__dnpMedia = resolveMedia(this);
            updateFilterWarn(this);
            if (!this.__dnpRaw) renderFromWidget(this);
            else applyRawMode(this, true);
            this.__dnpHistory = [];
            pushHistory(this);
        } catch (error) { warn(error); }
        return result;
    };

    const originalResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function () {
        const result = originalResize?.apply(this, arguments);
        try { fitHeight(this); } catch (error) { warn(error); }
        return result;
    };

    const originalRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
        const result = originalRemoved?.apply(this, arguments);
        try {
            closeMenu();
            hideHoverPreview();
        } catch (error) { warn(error); }
        return result;
    };
}

/** 选区守卫（编辑器住在 shadow root 里必须要有这一层）：
 *
 *  ① **把 document 级选区同步进编辑区**。本机前端把 DOM widget 包在 Vue 的 `.dom-widget` 层里，
 *     真实鼠标点击之后 `document.getSelection()` 会被**钳制到宿主外层**（startContainer = `.dom-widget`），
 *     而浏览器的编辑命令（方向键、Home/End）认的是这个 document 级选区 —— 它不在可编辑区里，
 *     于是**方向键完全推不动光标**（打字还能进是因为聚焦的可编辑元素在影子树里）。
 *     这里用影子选区（真光标）把它纠正回去。
 *  ② 光标要是落到了影子树里、却在编辑区之外，直接拽回编辑区末尾。
 *  只在影子宿主聚焦时检查，开销可忽略。 */
function installCaretGuard() {
    if (window.__dnpCaretGuard) return;
    window.__dnpCaretGuard = true;
    /* 鼠标按下期间（正在拖选）绝不碰选区：否则会把浏览器正在进行的"反向拖选"打断
       —— 实测右→左、下→上拖不动，左→右正常，就是这个原因。 */
    let selecting = false;
    const pathHasEditor = (event) => {
        try {
            const path = typeof event.composedPath === "function" ? event.composedPath() : [];
            return path.some((n) => n?.nodeType === 1 && n.classList?.contains(EDITOR_CLASS));
        } catch (error) { return false; }
    };
    window.addEventListener("pointerdown", (event) => { if (pathHasEditor(event)) selecting = true; }, true);
    window.addEventListener("pointercancel", () => { selecting = false; }, true);
    window.addEventListener("pointerup", () => {
        if (!selecting) return;
        selecting = false;
        setTimeout(run, 0);
    }, true);

    const run = () => {
        try {
            if (selecting) return;
            const host = document.activeElement;
            const root = host?.shadowRoot;
            if (!root || !host.classList?.contains(ROOT_CLASS)) return;
            const node = host.__dnpPromptNode;
            const editor = node?.__dnpEditor;
            if (!editor || node.__dnpRaw) return;          // 原文模式用的是 textarea，不干预

            /* 只做一件事：光标要是落在"本宿主的影子树里、却在编辑区之外"（历史 bug 会把字丢到框外），
               立刻把它拽回编辑区末尾。
               ⚠️ 这里**故意不去改 document 级选区** —— 早先加那一步是为了修方向键，
               但方向键真正的病根是外层画布快捷键吞键（已由 installNavKeyGuard 解决），
               而"拖选过程中反复改写选区"会把浏览器正在进行的**反向拖选**打断
               （实测右→左 / 下→上选不中，左→右正常）。 */
            const doc = window.getSelection?.();
            const docRange = doc && doc.rangeCount ? doc.getRangeAt(0) : null;
            const container = docRange ? docRange.startContainer : null;
            if (container && root.contains(container) && !editor.contains(container)) {
                caretAfterEl(null, editor);
            }
        } catch (error) { /* 静默：这只是兜底 */ }
    };
    document.addEventListener("selectionchange", run);
    document.addEventListener("focusin", run, true);   // focusin 是 composed 的，能带影子树的焦点上来
}

/** 光标 / 选区相关的按键：这些键必须"只掐冒泡、不 preventDefault"才能正常动光标。 */
const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** 让方向键在编辑区里真的能推得动光标。
 *
 *  **实测根因**：外层（LiteGraph / 前端的画布快捷键）在**冒泡阶段**对 Arrow* 调 `preventDefault()`
 *  来防"画布操作被打断"。它按 `e.target` 判断"是不是输入框"，而我们的编辑器在 shadow root 里 ——
 *  **事件跨影子边界后 `e.target` 被重定向成宿主 div**（`isContentEditable === false`），
 *  于是判断失败 → 当成画布按键吃掉 → 光标一动不动（打字正常是因为输入走的是编辑命令，不是 keydown 默认动作）。
 *  对照组：同样一段文字放在 light-DOM 的 contenteditable 里，方向键完全正常。
 *
 *  做法：在 **window 捕获阶段**（比 document/canvas 那层更早）认出"落在我们编辑器上的导航键"，
 *  **只 `stopPropagation()`、绝不 `preventDefault()`** —— 浏览器默认的光标移动保留，
 *  外层那套画布快捷键再也看不到这些事件。@ 菜单打开时放行，键盘才能上下选。
 */
function installNavKeyGuard() {
    if (window.__dnpNavGuard) return;
    window.__dnpNavGuard = true;
    window.addEventListener("keydown", (event) => {
        try {
            if (!NAV_KEYS.has(event.key)) return;
            const path = typeof event.composedPath === "function" ? event.composedPath() : [];
            const editor = path.find((n) => n?.nodeType === 1 && n.classList?.contains(EDITOR_CLASS));
            if (!editor) return;
            const node = editor.__dnpPromptNode;
            if (node && activeMenu && activeMenu.node === node) return;   // 菜单开着 → 留给菜单导航
            event.stopPropagation();
        } catch (error) { /* 静默：这只是按键放行 */ }
    }, true);
}

/* 注册必须「等 app 就绪」再调：ComfyUI 会**并行** import 所有扩展脚本，
   文件越小越先执行，那时 window.app 可能还没赋值 —— 顶层直接 `app.registerExtension(...)`
   会 ReferenceError，而且会被 ComfyUI 静默吞掉（界面上完全看不出来，像没装一样）。
   详见 skill `comfyui-custom-node-authoring` §5.11。 */
const extension = {
    name: "DN.PromptRich",
    setup() {
        if (extension.__setupDone) return;   // 幂等：注册晚于 app.setup 时会自己补调一次
        extension.__setupDone = true;
        installStyles();
        installPasteGuard();
        installCaretGuard();
        installNavKeyGuard();
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
            console.warn("[DN PromptRich] 注册失败:", error);
            return;
        }
        const kick = () => {
            try { extension.setup(); } catch (error) { console.warn("[DN PromptRich] 初始化失败:", error); }
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
