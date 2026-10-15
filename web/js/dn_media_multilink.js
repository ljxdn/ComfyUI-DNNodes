import { app } from "../../../scripts/app.js";
import { addForegroundPainter, addHandleProvider, drawVirtualDot, PAINTER_TOP, VIRTUAL_DOT_INACTIVE, VIRTUAL_DOT_NO_AUDIO } from "./dn_overlay.js";
import { refreshPromptMedia, getLinkBadges, planCardSwap, applyCardSwap, isNoneName } from "./dn_prompt_rich.js";

/*
 * 资产卡镜头打包 —— medias 单端口多连线。
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
/* 跨图粘贴后，"连线救不回来"如果只是因为卡的身份还没落地（控件未实例化 / properties 未写入），
   这条连线要**挂起**等下一帧再试，而不是当场判死删掉（删了不可逆）。挂起的宽限期。 */
const PENDING_GRACE_MS = 6000;

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
    // 顺带把来源卡（若为资产卡）的两把稳定键记下来 —— 跨画布复制后 source_id 会失效，
    // 这两个字段是"不依赖旧图还开着"就能重映射的钥匙（图片指纹比资产名更早就绪）。
    const sourceRole = assetNameOf(graph, Number(sourceNode.id)) || "";
    const sourceImage = assetImageOf(graph, Number(sourceNode.id)) || "";
    return { sourceNode, sourceId: Number(sourceNode.id), sourceSlot, sourceType: link.type || sourceNode.outputs?.[sourceSlot]?.type || "H3_MEDIA", sourceRole, sourceImage };
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

/** 取一张资产卡（H3MediaLoader）的"资产名"—— 链路里唯一稳定的主键。
 *  资产名存在 `role_name` 控件里（asset_card.js 的 roleNameOf 同款逻辑）。
 *
 *  ⚠️ 必须**多路回退**，因为节点刚被复制/粘贴进新图那一刻，`node.widgets` 实例
 *  数组可能还是空的（控件要等渲染才重新实例化）—— 只读 widget 会拿到空串，
 *  导致按资产名重映射失败、连线被静默丢弃（实测"复制后只断某一条"的根因）。
 *  取值优先级：
 *  ① 已实例化的 widget（`node.widgets` 里有 role_name）
 *  ② `widgets_values_named.role_name`（序列化时按名字存的值，**不依赖 widget 实例**，
 *     粘贴后立即可用 —— 这是最稳的一路）
 *  ③ `properties.pml_role_name`
 *  ④ `node.title` */
function assetNameOf(graph, id) {
    const node = graph?.getNodeById?.(id);
    if (!node) return "";
    const widget = (node.widgets || []).find((w) => w?.name === "role_name");
    if (widget?.value != null && String(widget.value).trim()) return String(widget.value).trim();
    const named = node?.widgets_values_named?.role_name;
    if (named != null && String(named).trim()) return String(named).trim();
    const propRole = node?.properties?.pml_role_name;
    if (propRole != null && String(propRole).trim()) return String(propRole).trim();
    return String(node?.title ?? "").trim();
}

/** 节点是否资产卡（H3MediaLoader）。
 *  ⚠️ 三字段全兜：官方节点运行时带 `type`，自研节点带 `comfyClass`，
 *  个别版本序列化后还残留 `_comfy_node_type`。只看其中一个会漏判（真机踩过）。 */
function isMediaCard(node) {
    if (!node) return false;
    const t = node.comfyClass || node.type || node._comfy_node_type;
    return t === "H3MediaLoader";
}

/** 节点是否是 LGraphGroup（框选组）。 */
function isGraphGroup(node) {
    if (!node) return false;
    const t = node.comfyClass || node.type || node._comfy_node_type;
    return t === "LGraphGroup";
}

/** 取一张资产卡的**身份指纹** = 图片文件名。与 `assetNameOf` 同源（都由同一张卡派生），
 *  但它在**时间上更早可用**，是跨画布粘贴时真正靠得住的那把钥匙。
 *
 *  ⚠️ 为什么不能只靠资产名：粘贴那一刻资产名的两条来源**同时**不可用 ——
 *    - `node.widgets` 实例：ComfyUI 1.53 的控件由 Vue 组件挂载时才创建，粘贴后要等若干帧；
 *    - `widgets_values_named`：那是**保存工作流**时才写出的字段，Ctrl+C 的剪贴板
 *      （`node.serialize()`）根本不带它。
 *  于是"候选卡名读不出来"→ 按名匹配落空 → 连线被判失效丢弃（且不可逆）→ 整组线全断。
 *
 *  `properties.pml_image_filename` 没有这个时序问题：它在 `configure` 阶段就已写好
 *  （早于控件实例化），且 properties 一定会随剪贴板 / 存盘一起走。
 *  取值优先级（越靠前越早可用）：
 *  ① `properties.pml_image_filename` —— configure 期即在，**首帧就能读到**
 *  ② `widgets_values_named.image_filename`
 *  ③ 已实例化的 `image_filename` 控件
 *  ④ `widgets_values[0]`（该数组首项恒为图片名 —— 最后兜底） */
function assetImageOf(graph, id) {
    const node = graph?.getNodeById?.(id);
    if (!node) return "";
    const prop = node?.properties?.pml_image_filename;
    if (prop != null && String(prop).trim()) return String(prop).trim();
    const named = node?.widgets_values_named?.image_filename;
    if (named != null && String(named).trim()) return String(named).trim();
    const widget = (node.widgets || []).find((w) => w?.name === "image_filename");
    if (widget?.value != null && String(widget.value).trim()) return String(widget.value).trim();
    const values = node?.widgets_values;
    if (Array.isArray(values) && values.length && String(values[0] ?? "").trim()) return String(values[0]).trim();
    return "";
}

/** 卡的身份是否**还没就绪**（刚粘贴、控件与 properties 都还没落地的那几帧）。
 *  用来判断"连线救不回来"到底是"这张图确实没这张卡"还是"再等一帧就能救" ——
 *  后者必须保留连线，否则第一帧就把线删了，之后卡名可读了也回不来。
 *
 *  ⚠️⚠️ 判据必须是「**身份读得出来**」，绝不能是「role_name 控件存在」（2026-10-01 真机实测）。
 *  跨流粘贴后的第一帧：节点已经建好、`widgets` 数组里 `role_name` 控件也**已经存在**，
 *  但控件值是空的、`properties.pml_image_filename` 也还没写。旧判据看到"有控件"就判定
 *  "身份已就绪" → `grace = 0` → 悬空连线**当帧被删**（不可逆），而 `remapBrokenLink`
 *  在那一帧同样读不出身份、救不回来 → 复制到别的流后连线**全断**。
 *  真机诊断实录：`normalize node=5109 raw=3 kept=0 dropped=3`，且 removed 前后都没有 remap。 */
function identityPending(node) {
    if (!isMediaCard(node)) return false;
    const graph = node.graph || app.graph;
    // ① 图片指纹可读 → 真就绪（`properties.pml_image_filename` 在 configure 期就在）
    if (assetImageOf(graph, node.id)) return false;
    // ② 资产名有**实际值**（不是"控件在但值是空的"）→ 真就绪
    if (node?.properties?.pml_role_name) return false;
    if (node?.widgets_values_named?.role_name) return false;
    const widget = (node.widgets || []).find((w) => w?.name === "role_name");
    if (widget && String(widget.value ?? "").trim()) return false;
    return true;   // 三路都读不出 → 还没就绪，必须宽限
}

/* 最近一次「复制」时选中的资产卡：原 id → { name, image }。
 * 粘贴后连线记录里的 source_id 就是这里的**原 id**，所以拿它可以不依赖任何既有烙印地重映射。
 * ⚠️ 每次复制都**整体重置**（哪怕这次一张卡都没选）—— 否则上一次的旧指纹会被误用到
 * 下一次无关的粘贴上，把线接到错的卡。 */
let COPY_KEYS = null;

/* ===================== DIAG-BEGIN 真机诊断（临时，定位后整块删除）=====================
 * 把「复制 / 粘贴 / 丢线」的全过程落到磁盘，供离线分析 —— 不用用户开控制台。
 * 写到 ComfyUI 的 userdata：POST /userdata/dn_diag.json
 * 实际落盘：<comfy>/user/default/dn_diag.json */
const DN_DIAG = { startedAt: Date.now(), ua: navigator?.userAgent || "", events: [] };
let DN_DIAG_TIMER = null;
/** 真机取证开关 —— **默认关闭，零开销**。
 *  要抓"复制/粘贴丢线"这类跨画布时序问题时，在地址栏加 `?dn_diag=1` 刷新
 *  （或 `localStorage.dn_diag = "1"` 后刷新），事件会写进
 *  `<comfy>/user/default/dn_diag.json`，不用开控制台。*/
const DN_DIAG_ON = (() => {
    try {
        return new URLSearchParams(location.search).has("dn_diag")
            || localStorage.getItem("dn_diag") === "1";
    } catch (error) { return false; }
})();
function dnBrief(node) {
    if (!node) return null;
    return {
        id: node.id,
        type: node.type,
        comfyClass: node.comfyClass,
        title: node.title,
        role: node?.properties?.pml_role_name || node?.widgets_values_named?.role_name || "",
        image: node?.properties?.pml_image_filename || "",
        nWidgets: (node.widgets || []).length,
    };
}
function dnBriefLinks(node) {
    try { return getLinks(node).map((l) => ({ ...l })); } catch (error) { return []; }
}
function dnFlushDiag() {
    if (DN_DIAG_TIMER) return;
    DN_DIAG_TIMER = setTimeout(() => {
        DN_DIAG_TIMER = null;
        try {
            fetch("/userdata/dn_diag.json", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(DN_DIAG, null, 2),
            }).catch(() => { /* 静默 */ });
        } catch (error) { /* 静默 */ }
    }, 500);
}
function dnDiag(tag, extra) {
    if (!DN_DIAG_ON) return;
    try {
        const ev = { seq: DN_DIAG.events.length, ms: Date.now() - DN_DIAG.startedAt, tag };
        if (extra) for (const k of Object.keys(extra)) ev[k] = extra[k];
        DN_DIAG.events.push(ev);
        if (DN_DIAG.events.length > 300) DN_DIAG.events.splice(0, 150);
        dnFlushDiag();
    } catch (error) { /* 静默 */ }
}
/* ===================== DIAG-END ===================== */

/** 复制动作发生时（Ctrl+C / 右键 Copy / 菜单），把选中资产卡的身份抄一份下来。
 *  这一刻源图的卡一定是活的（用户正看着它、选中它），读它的属性最可靠。
 *
 *  读取顺序（覆盖各种选中形态）：
 *  ① `canvas.selectedItems` —— 1.53 里真正确定剪贴板内容的字段（`useCopy` →
 *     `canvas.copyToClipboard()` → `_serializeItems(selectedItems)` 就靠它）。
 *     这里面可能有两种"可选中"类型：
 *     - LGraphNode：直接当卡用；
 *     - LGraphGroup：**这就是你描述"先选资产卡 group 就丢"的坑** —— 框选的 group 在
 *       selectedItems 里只出现 group 本身，不会展开里面的卡。必须把它 group 的
 *       `_children`（框内所有子节点/子 group）递归展开，找到其中的 H3MediaLoader。
 *  ② 兜底 `canvas.selected_nodes` —— 1.53 里已 `@deprecated`，但老版本仍在用；
 *     同样要遍历其 values。
 *  只要一张卡命中就整体记录，避免下次粘贴时 COPY_KEYS 为空把线全断掉。 */
function captureCopyKeys(canvas) {
    const graph = canvas?.graph || app.graph;
    dnDiag("copy:in", {   /* DIAG */
        isAppCanvas: canvas === app.canvas,
        hookFlag: !!canvas?.__DnCopyKeysHooked,
        nSelectedItems: canvas?.selectedItems?.size ?? -1,
        selectedItems: DN_DIAG_ON ? (canvas?.selectedItems ? Array.from(canvas.selectedItems) : []).map(dnBrief) : [],
        selectedNodes: DN_DIAG_ON ? Object.values(canvas?.selected_nodes || {}).map(dnBrief) : [],
        graphNodes: DN_DIAG_ON ? (graph?._nodes || []).map(dnBrief) : [],
    });
    const map = {};
    const collectFromNode = (node) => {
        if (!isMediaCard(node)) return;
        const id = Number(node?.id);
        if (!Number.isFinite(id) || map[id]) return;
        map[id] = { name: assetNameOf(graph, id) || "", image: assetImageOf(graph, id) || "" };
    };
    /** 从 group 里挖出所有资产卡（含嵌套 group）。group 存子节点的字段按
     *  新→旧顺序探测，全拿不到再退回「按包围盒扫全图」这个**最稳**的路径。 */
    const sweepGroupByBounds = (group) => {
        // 包围盒 = [left, top, width, height]
        const pos = group?.pos ?? group?._pos;
        const size = group?.size ?? group?._size;
        if (!pos || !size || !Array.isArray(pos) || !Array.isArray(size)) return;
        const left = pos[0], top = pos[1], w = size[0], h = size[1];
        if (!Number.isFinite(left) || !Number.isFinite(top) || w <= 0 || h <= 0) return;
        for (const node of (graph?._nodes || [])) {
            if (!isMediaCard(node)) continue;
            const p = node.pos;
            if (!p || !Array.isArray(p) || p.length < 2) continue;
            // 卡中心点在包围盒内 → 视为组内（比逐字段存 children 可靠得多）
            const cx = p[0] + (node.size?.[0] / 2 || 0);
            const cy = p[1] + (node.size?.[1] / 2 || 0);
            if (cx >= left && cx <= left + w && cy >= top && cy <= top + h) collectFromNode(node);
        }
    };
    const walkGroupChildren = (group) => {
        // ① 新版字段 `_children`（Set<Positionable>，1.53 实际使用的集合）
        // ② 旧版 `_nodes`（LGraphNode[]，@deprecated 但仍可能残留）
        // ③ 都没有（或里面拿不到资产卡）→ 包围盒扫全图兜底
        const children = group?._children || group?._nodes;
        let found = 0;
        const scan = (item) => {
            if (isGraphGroup(item)) { walkGroupChildren(item); found++; }
            else if (isMediaCard(item)) { collectFromNode(item); found++; }
        };
        if (children instanceof Set) for (const item of children) scan(item);
        else if (Array.isArray(children)) for (const item of children) scan(item);
        if (!found) sweepGroupByBounds(group);
    };
    // ① selectedItems（1.53 真用的字段）
    if (canvas?.selectedItems) {
        for (const item of canvas.selectedItems) {
            if (isGraphGroup(item)) walkGroupChildren(item);
            else collectFromNode(item);
        }
    }
    // ② 兜底 selected_nodes
    for (const node of Object.values(canvas?.selected_nodes || {})) {
        if (isGraphGroup(node)) walkGroupChildren(node);
        else collectFromNode(node);
    }
    // ③ "只选中 资产卡镜头打包 节点"（B 场景，2026-10-01 用户实报）：
    //    selectedItems 里只有一个 DNMediaToDirectorGroup 节点，资产卡一张都没选中。
    //    此时从**该组节点自己连出的连线记录**里取 source_id，把这些卡一并记进指纹 ——
    //    这些卡的 id 与连线里的 source_id 一一对应，重映射时正好用得上。
    //    （资产卡本身不随剪贴板走，记指纹是**为组节点自己的连线重映射备钥匙**。）
    const isDNGroup = (n) => n?.comfyClass === NODE_CLASS || n?.type === NODE_CLASS;
    if (canvas?.selectedItems) {
        for (const item of canvas.selectedItems) {
            if (!isDNGroup(item)) continue;
            for (const link of getLinks(item)) collectFromNode(graph?.getNodeById?.(Number(link?.source_id)));
        }
    }
    for (const item of Object.values(canvas?.selected_nodes || {})) {
        if (!isDNGroup(item)) continue;
        for (const link of getLinks(item)) collectFromNode(graph?.getNodeById?.(Number(link?.source_id)));
    }
    COPY_KEYS = Object.keys(map).length ? map : null;
    // 🔧 焊钥匙：把指纹**直接写进源图连线自己的 properties**。
    //    剪贴板（`node.serialize()`）只带 properties，**不带本模块的内存变量** ——
    //    只记 COPY_KEYS 等于把钥匙留在源图的浏览器里；一旦粘贴后钩子没有重跑
    //    （换了 canvas 实例 / 用户换了工作流 tab），新流的节点身上一把钥匙都没有，
    //    线就只能被判失效丢弃。写到 link 上则随剪贴板一起过河，永不丢。
    //    范围 = 本图所有 DN 组节点（不限被选中的那个）：只要某条 link 的 source_id
    //    命中了本次抄下来的指纹表，就把它焊上去（map 由「选中的卡」+「选中组连出的卡」
    //    组成，没命中的 link 不碰，不会焊错）。
    for (const node of (graph?._nodes || [])) {
        if (!isDNGroup(node)) continue;
        for (const link of getLinks(node)) {
            const clip = map[Number(link?.source_id)];
            if (!clip) continue;
            if (!link.source_role && clip.name) link.source_role = clip.name;
            if (!link.source_image && clip.image) link.source_image = clip.image;
        }
    }
    dnDiag("copy:out", { copyKeys: COPY_KEYS });   /* DIAG */
    // 记录到 0 张卡时打一条（正常复制有卡时静默）。方便真机定位"复制那一刻选中集合里到底有什么"。
    if (!COPY_KEYS && (canvas?.selectedItems?.size || Object.keys(canvas?.selected_nodes || {}).length)) {
        const selTypes = (canvas?.selectedItems ? Array.from(canvas.selectedItems) : []).map((x) => x?.type || x?.comfyClass).join(",");
        console.warn("[DN multilink] 复制时选中集合里没有可识别的资产卡/H3MediaLoader，COPY_KEYS 为空。selectedItems 类型:", selTypes || "(无)");
    }
}

/** 按资产名重映射：当 source_id 在当前图里查不到节点（节点被复制进新画布、
 *  id 被重新分配）时，用**资产卡资产名（role_name）**当主键，在本图里找到同名同类型
 *  的 H3MediaLoader，把 source_id 改指过去。
 *
 *  为什么能这样做：
 *  - 整条链路（prompt 过滤 / 上色 / 参考音频绑定）本来就全靠**资产名**当主键，
 *    一张资产卡的"身份"在图里就是它的资产名；复制进新流后资产名不变、节点 id 变。
 *  - 这是官方组节点（graphToGroup）做 id 重映射的同一思路：关系不靠裸 id 指针，
 *    靠一个**稳定键**（这里 = 资产名）在重建后重新绑定。
 *  - 找不到同名节点才放弃（返回 false），由 normalizeLinks 照常丢弃，不误连。
 *  - 同名有两张卡（新流里故意放了重名）不动，留给人处理 —— 避免把线连到错的卡。
 *
 *  资产名来源（按可靠性排序，第一个拿到的就用）：
 *  ① 连线自带的 `source_role` 字段（新版连线创建时写入）—— 最稳，不依赖旧图还在；
 *  ② 旧图（app.graph）里按旧 id 反查；
 *  ③ 本图里按旧 id 反查（正常加载时旧 id 仍有效）。
 *
 *  返回是否改了这条连线。`remapLog`（可选）收集 "旧id → 新id" 记录，供调用方写回/日志。
 *
 *  ⚠️ **不要**用「`graph.getNodeById(oldId)` 存在」当"连线还活着"的判据 —— 两流同开时，
 *  粘贴进来这组的 source_id（如 170）会撞上**当前流里另一张无关的 id=170 节点**，
 *  一查命中就 `return false` 不重映射 → 连线接到**错的那张卡**上。
 *  真正的"还活着"判据 = **source_id 指向的节点资产名 == 这条连线记录的 source_role**；
 *  对不上（含撞 id）就按资产名找本图里的**正确**那张，找不到才丢弃。 */
/** 用「资产名 / 图片指纹」在**本图**里找那张资产卡。找到**唯一**一张才返回它；
 *  找不到、或有歧义（多张同名/同图）返回 null —— 宁可不连，也不连到错的卡上。
 *
 *  先按资产名找：重名（本图故意放了两张同名卡）时**不立刻放弃**，
 *  再拿图片指纹区分 —— 两张卡重名但图片不同时仍能唯一定位到正确那张。 */
function findCardByKeys(graph, name, image) {
    const cards = (graph?._nodes || []).filter(isMediaCard);
    if (name) {
        const byName = cards.filter((n) => assetNameOf(graph, n.id) === name);
        if (byName.length === 1) return byName[0];
        if (byName.length > 1 && image) {
            const narrowed = byName.filter((n) => assetImageOf(graph, n.id) === image);
            if (narrowed.length === 1) return narrowed[0];
        }
        if (byName.length > 1) return null;   // 重名且指纹也分不开 → 留给人处理
    }
    if (image) {
        const byImage = cards.filter((n) => assetImageOf(graph, n.id) === image);
        if (byImage.length === 1) return byImage[0];
    }
    return null;
}

function remapBrokenLink(graph, link, remapLog) {
    if (!link || !Number.isFinite(Number(link.source_slot))) return false;
    const oldId = Number(link?.source_id);
    const cur = Number.isFinite(oldId) ? (graph?.getNodeById?.(oldId) || null) : null;
    const isCard = isMediaCard(cur);
    // 连线记录里的两把稳定键（新版有；老连线没有 → 依次在"当前图 / 旧图 / 复制时记下的指纹"里反查）。
    // 第三路（clip）是关键兜底：老工作流的连线里可能一把钥匙都没有，但用户**复制那一刻**
    // 源图的卡是活的，从它身上现取的指纹足以把线在目标流里接回来。
    const clip = COPY_KEYS?.[oldId] || null;
    // 第三把钥匙（2026-10-01 补）：连线自己烙印在 properties 里的 `source_role` /
    // `source_image`（每次渲染都会固化写入，随剪贴板一起走）—— 它是**跨画布**的键，
    // 不依赖旧图还开着、也不依赖本次复制时选中了谁。只有它拿不到时才退回
    // "当前图 / 旧图按 source_id 反查"（source_id 在别的流里指向的是别的节点，反查不可靠）。
    const stampName = String(link?.source_role || "").trim();
    const stampImage = String(link?.source_image || "").trim();
    const recordName = stampName
        || (isCard ? assetNameOf(graph, oldId) : assetNameOf(app.graph, oldId))
        || clip?.name || "";
    const recordImage = stampImage
        || (isCard ? assetImageOf(graph, oldId) : assetImageOf(app.graph, oldId))
        || clip?.image || "";
    // "还活着"真实判据：source_id 指向的是资产卡，且**身份对得上**（资产名或图片指纹任一命中）。
    // 撞 id（指向了当前流里另一张无关卡）→ 都对不上 → 不判活 → 触发重映射。
    if (isCard && ((recordName && assetNameOf(graph, oldId) === recordName)
        || (recordImage && assetImageOf(graph, oldId) === recordImage))) return false;
    if (!recordName && !recordImage) return false;   // 两把钥匙都拿不到 → 交给 normalizeLinks 丢弃
    const target = findCardByKeys(graph, recordName, recordImage);
    if (!target) return false;                        // 本图没这张卡 / 有歧义 → 不误连
    if (Number(target.id) === oldId) return false;    // 已经指向正确那张（老工作流 id 未变）
    link.source_id = Number(target.id);
    link.source_type = target.outputs?.[Number(link.source_slot)]?.type || link.source_type || "H3_MEDIA";
    link.source_role = recordName || assetNameOf(graph, target.id);
    link.source_image = recordImage || assetImageOf(graph, target.id);
    if (remapLog) remapLog.push({ from: oldId, to: Number(target.id), name: link.source_role, image: link.source_image });
    return true;
}

/** 清理重复或来源节点已不存在的虚拟连接。
 *  失效连线（source_id 指向当前图里不存在的节点）在这里**先按资产名救回**，
 *  救不回的再丢弃。本函数每帧（onDrawForeground）与加载时（onConfigure）都会跑，
 *  是跨画布复制后 source_id 失效的自动重映射入口 —— 不依赖 onAddedToGraph（部分 LiteGraph
 *  版本原型上不存在该钩子），也无需等到"节点真正进图"的时机。 */
function normalizeLinks(node) {
    const graph = node?.graph || app.graph;
    // ① 先救：把 source_id 失效的连线按资产名（连线自带的 source_role 或旧图反查）重映射到本图同名卡。
    const links = getLinks(node);
    const diagRaw = DN_DIAG_ON ? links.map((l) => ({ ...l })) : [];   /* DIAG */
    const remapLog = [];
    for (const link of links) remapBrokenLink(graph, link, remapLog);
    if (remapLog.length) {
        node.__dnRemappedLinks = remapLog;
        dnDiag("remap", { nodeId: node.id, remapLog, from: diagRaw });   /* DIAG */
        console.info(`[DN multilink] 节点 ${node.id}：source_id 失效，按资产名重映射 ${remapLog.length} 条连线`, remapLog);
    }
    // ② 固化：对 source_id 仍指向**活的资产卡**、且连线已记录资产名（或反查得出）的连线，
    //    把 source_role 固化进 properties（老工作流没有这个字段，第一次渲染后永久自带键）。
    //    安全阀：若 source_id 撞上了"资产名与连线记录不符"的节点（撞 id），**不固化错名**，
    //    保持 source_role 原值，让 ① 重映射继续救 —— 否则会把"路人甲"写死成正确键。
    for (const link of links) {
        const sid = Number(link?.source_id);
        if (!Number.isFinite(sid)) continue;
        const cur = graph?.getNodeById?.(sid);
        if (!isMediaCard(cur)) continue;
        const name = assetNameOf(graph, sid);
        const image = assetImageOf(graph, sid);
        // 连线若已有 source_role 且与当前节点资产名不符 → 撞 id，不覆盖（保留原键给重映射）。
        if (link.source_role && name && link.source_role !== name) continue;
        if (name) link.source_role = name;
        // 图片指纹一并烙印：它比资产名**更早可用**（configure 期即在），
        // 复制到别的流后即使控件还没实例化，也能靠它把线接回正确的卡。
        if (image) link.source_image = image;
    }
    // ②b 补键：连线**既无 source_role 又无 source_image**（老工作流存的）时，
    //    本次复制若带了剪贴板指纹（COPY_KEYS），把键补进连线 —— 下次再复制就不需要指纹了。
    for (const link of links) {
        if (link.source_role || link.source_image) continue;
        const clip = COPY_KEYS?.[Number(link?.source_id)];
        if (!clip) continue;
        if (clip.name) link.source_role = clip.name;
        if (clip.image) link.source_image = clip.image;
    }
    // ③ 再丢：重映射/固化后仍指向**当前图里不存在节点**的（新图确实没这张同名卡）才丢弃。
    // ⚠️ 必须用上面同一个 `graph` 查 —— 不能退回 app.graph：当前流粘贴时，
    // source_id 已重映射到本图节点，若 app.graph 是另一张图，按 app.graph 查会误判"不存在"而丢线。
    const seen = new Set();
    // 刚粘贴进来的头几帧，卡的身份可能还没落地（控件没建、properties 也还没写）。
    // 此时"查不到 source 节点"**不等于**"本图没有这张卡" —— 当场删掉就再也回不来，
    // 所以先挂起（带超时），等下一帧身份可读了由 ① 救回。
    const hasDangling = links.some((link) => {
        const sid = Number(link?.source_id);
        return Number.isFinite(sid) && graph?.getNodeById && !graph.getNodeById(sid);
    });
    const pending = (node.__dnPendingLinks ||= {});
    const now = Date.now();
    // 宽限窗口：两条独立来源，任一成立就给满额时间。
    //  ① 图里还有卡的身份读不出来（控件值空 / properties 未写）= 粘贴后的典型首帧；
    //  ② **本节点刚 Configure 完**（跨流粘贴 / 打开工作流）—— 无条件给窗口，
    //     因为"这一帧读不出身份"≠"这张图没有这张卡"，而删掉是**不可逆**的。
    const recentlyConfigured = Number.isFinite(node.__dnConfiguredAt)
        && (now - node.__dnConfiguredAt) < PENDING_GRACE_MS;
    const grace = hasDangling
        && ((graph?._nodes || []).some(identityPending) || recentlyConfigured)
        ? PENDING_GRACE_MS : 0;
    const valid = links.filter((link) => {
        const sourceId = Number(link?.source_id);
        const sourceSlot = Number(link?.source_slot);
        const key = `${sourceId}:${sourceSlot}`;
        if (!Number.isFinite(sourceId) || !Number.isFinite(sourceSlot) || seen.has(key)) return false;
        if (graph?.getNodeById && !graph.getNodeById(sourceId)) {
            const deadline = pending[key] ?? (grace ? now + grace : 0);
            if (deadline > now) {
                pending[key] = deadline;
                seen.add(key);
                return true;   // 挂起：连线先留着，下一帧再试
            }
            delete pending[key];
            return false;
        }
        delete pending[key];
        seen.add(key);
        return true;
    });
    valid.forEach((link, index) => { link.order = index + 1; });
    node.properties[LINKS_PROPERTY] = valid.slice(0, MAX_MEDIA);
    /* DIAG：只在最终结果变化时上报一次，避免每帧刷屏（默认关闭时整块不执行） */
    if (DN_DIAG_ON) try {
        const sig = JSON.stringify([links.length, valid.length, links.map((l) => `${l.source_id}:${l.source_slot}`), valid.map((l) => `${l.source_id}:${l.source_slot}`)]);
        if (node.__dnDiagSig !== sig) {
            node.__dnDiagSig = sig;
            dnDiag("normalize", {
                nodeId: node.id,
                graphIsApp: graph === app.graph,
                graphLinkCount: graph?.links?.size ?? (graph?._links ? Object.keys(graph._links).length : -1),
                rawLinks: diagRaw,
                kept: valid.map((l) => ({ ...l })),
                dropped: diagRaw.filter((r) => !valid.some((v) => Number(v.source_id) === Number(r.source_id) && Number(v.source_slot) === Number(r.source_slot))),
                copyKeys: COPY_KEYS,
                graphNodes: (graph?._nodes || []).map(dnBrief),
                pendingCards: (graph?._nodes || []).filter(identityPending).map(dnBrief),
            });
        }
    } catch (error) { /* 静默 */ }
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
        source_role: source.sourceRole,
        source_image: source.sourceImage,
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
        pending.push({ source_id: stash.source_id, source_slot: stash.source_slot, source_type: stash.source_type, source_role: stash.source_role || assetNameOf(graph, stash.source_id), source_image: stash.source_image || assetImageOf(graph, stash.source_id), order: 0 });
        seen.add(`${stash.source_id}:${stash.source_slot}`);
    }
    const incoming = `${source.sourceId}:${source.sourceSlot}`;
    if (!seen.has(incoming)) {
        pending.push({ source_id: source.sourceId, source_slot: source.sourceSlot, source_type: source.sourceType, source_role: source.sourceRole || assetNameOf(graph, source.sourceId), source_image: source.sourceImage || assetImageOf(graph, source.sourceId), order: 0 });
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

/**
 * 把「画虚拟连线」挂到画布上。**三条钩子各自独立判定 —— 任何一条缺了都不影响其它两条。**
 *
 * 血泪史（2026-10-14 13:55 首次发现、2026-10-15 用户再次追问"这块的连线怎么又不显示"）：
 *   以前这四条（drawConnections 补丁 / onDrawForeground 补丁 / DOM 覆盖层绘制 / 可点把手）
 *   共用**同一个 guard** —— `typeof canvas.drawConnections === "function"`。后果：只要
 *   那一个方法一时不在（前端换代、`app.canvas` 还没就绪、或**画布实例后来被整个换掉**），
 *   四条**一起静默跳过** —— 线一条都不画、圆点也点不到，而且控制台一声不响。
 *   现在改成：
 *     · drawConnections 在 → 挂它（它在图变换**里头**被调用，坐标天然正确，首选）；
 *     · 它不在、但 drawBackCanvas 在 → 挂 drawBackCanvas（1.53.x 的 drawFrontCanvas
 *       必定走它）；代价是要自己补一次 `ds.toCanvasContext()` —— 因为它内部
 *       `save/restore` 是成对的，返回时图变换已经被还原了；
 *     · onDrawForeground 在 → 挂它（选中时再画一份到节点层之上，见文件头说明）。
 *   真的一条都挂不上才放弃，并且打一条 console.warn（绝不静默）。
 */
function installDrawHooks(canvas) {
    if (!canvas) return [];
    const installed = [];
    if (!canvas.__DnMultiLinkPatched && typeof canvas.drawConnections === "function") {
        canvas.__DnMultiLinkPatched = true;
        const originalDraw = canvas.drawConnections;
        canvas.drawConnections = function (ctx) {
            const result = originalDraw.apply(this, arguments);
            drawVirtualLinks(this, ctx || this.bgctx || this.ctx);
            return result;
        };
        installed.push("drawConnections");
    }
    if (!canvas.__DnMultiLinkPatched && !canvas.__DnBackPatched
        && typeof canvas.drawBackCanvas === "function") {
        canvas.__DnBackPatched = true;
        const originalBack = canvas.drawBackCanvas;
        canvas.drawBackCanvas = function () {
            const result = originalBack.apply(this, arguments);
            try {
                const ctx = this.bgctx || this.ctx;
                if (ctx) {
                    // 见函数头：drawBackCanvas 内部 save/restore 成对，返回时变换已还原，
                    // 必须重新套一遍图变换，否则线会画到画布坐标系之外（看着像"没画"）。
                    ctx.save();
                    this.ds?.toCanvasContext?.(ctx);
                    drawVirtualLinks(this, ctx);
                    ctx.restore();
                }
            } catch (error) {
                console.warn("[DN multilink] drawBackCanvas 补绘失败:", error);
            }
            return result;
        };
        installed.push("drawBackCanvas");
    }
    if (!canvas.__DnForegroundPatched) {
        canvas.__DnForegroundPatched = true;
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
        installed.push("onDrawForeground");
    }
    if (installed.length) {
        console.info(`[DN multilink] 画布绘制钩子已装：${installed.join(" + ")}`);
    }
    if (!canvas.__DnMultiLinkPatched && !canvas.__DnBackPatched && !canvas.__DnDrawWarned) {
        canvas.__DnDrawWarned = true;
        console.warn("[DN multilink] 画布上找不到 drawConnections / drawBackCanvas"
            + " —— 虚拟连线补绘挂不上（看门狗会每秒重试）");
    }
    return installed;
}

/**
 * 看门狗：前端可能把整个画布实例换掉（Vue 重挂 / 切工作流 / 节点上刚挂 DOM 控件那一下），
 * 新画布上一个标记都没有，而 `installPatches` 的 12×250ms 早就放弃了 ——
 * 于是"线不显示"而且**永远不会自己好**。
 * 这里每秒比一次对象引用：没换就只是一次 `===`，开销可忽略；换了就把补丁重挂一遍
 * （`patchCanvas` 内部每条钩子都自带 guard，幂等，不会越套越深）。
 */
function startCanvasWatchdog() {
    if (extension.__dnWatchdog) return;
    extension.__dnWatchdog = true;
    let last = null;
    setInterval(() => {
        let canvas = null;
        try { canvas = app?.canvas; } catch (error) { return; }
        if (!canvas) return;
        const ready = canvas.__DnForegroundPatched
            && (canvas.__DnMultiLinkPatched || canvas.__DnBackPatched)
            && canvas.__DnMousePatched
            && canvas.__DnPointerPatched;
        if (canvas === last && ready) return;
        last = canvas;
        try {
            patchCanvas();
        } catch (error) {
            console.warn("[DN multilink] 看门狗补装失败:", error);
        }
    }, 1000);
}

/** 覆盖画布连接层，补绘虚拟连接并恢复其菜单交互。 */
function patchCanvas() {
    // ① 「盖在节点之上」的覆盖层绘制 + 可点把手：**与画布实例无关**，先登记。
    //    dn_overlay.js 自己会轮询等 app.canvas 就绪，所以这里不需要 canvas 就能挂。
    //    ⚠️ 以前这两条被挡在 drawConnections 的 guard 后面 —— 那个方法一缺，
    //    连"选中才画一份到最上层"的这份也跟着没了，症状就是"连线一条都不显示"。
    //    幂等：同名重复登记只是覆盖，看门狗每秒重挂也不会有副作用。
    addForegroundPainter("dn.multilink.selected", (ctx, mainCanvas) => {
        drawVirtualLinks(mainCanvas, ctx, { selectedOnly: true, linesOnly: true });
    });
    addForegroundPainter("dn.multilink.dots", (ctx, mainCanvas) => {
        drawVirtualLinks(mainCanvas, ctx, { selectedOnly: true, dotsOnly: true });
    }, PAINTER_TOP);
    addHandleProvider("dn.multilink.handles", virtualLinkHandles);

    const canvas = app.canvas;
    if (!canvas) { dnDiag("patchCanvas:noCanvas"); return; }   /* DIAG */
    if (!canvas.__dnDiagPatchReported) {   /* DIAG */
        canvas.__dnDiagPatchReported = true;
        dnDiag("patchCanvas", {
            hasCopyFn: typeof canvas.copyToClipboard === "function",
            alreadyHooked: !!canvas.__DnCopyKeysHooked,
            hasPasteFn: typeof canvas.pasteFromClipboard === "function",
            canvasCtor: canvas?.constructor?.name || "",
        });
    }
    // 粘贴入口也记一笔：粘贴前后各拍一次图，用来判断"线是在粘贴瞬间就没了，还是粘贴后几帧被丢的"。
    if (!canvas.__DnPasteHooked && typeof canvas.pasteFromClipboard === "function") {   /* DIAG */
        canvas.__DnPasteHooked = true;
        const originalPaste = canvas.pasteFromClipboard;
        canvas.pasteFromClipboard = function () {
            dnDiag("paste:before", { graphNodes: (app.graph?._nodes || []).map(dnBrief) });
            const result = originalPaste.apply(this, arguments);
            setTimeout(() => dnDiag("paste:after", {
                graphNodes: (app.graph?._nodes || []).map(dnBrief),
                groups: (app.graph?._nodes || []).filter((n) => n?.comfyClass === NODE_CLASS || n?.type === NODE_CLASS)
                    .map((n) => ({ id: n.id, links: dnBriefLinks(n) })),
            }), 200);
            return result;
        };
    }
    // ⚠️ 复制钩子（captureCopyKeys）必须**独立**于 drawConnections 那个 guard 安装：
    // 真机上 `copyToClipboard` 是 canvas 的原生方法（随 canvas 一起出生），而
    // `drawConnections` 在某些时序下也可能暂缺；若把复制钩子跟绘图钩子绑在一起、
    // 被绘图那条 guard 挡掉，复制那一刻就记不下指纹（COPY_KEYS 永远 null），
    // 老连线一粘贴仍全断 —— 且完全静默、最难查。
    if (!canvas.__DnCopyKeysHooked && typeof canvas.copyToClipboard === "function") {
        canvas.__DnCopyKeysHooked = true;
        const originalCopy = canvas.copyToClipboard;
        canvas.copyToClipboard = function () {
            try { captureCopyKeys(canvas); } catch (error) { /* 静默：记不下指纹不影响复制本身 */ }
            return originalCopy.apply(this, arguments);
        };
    }
    if (!canvas.__DnCopyListenerHooked) {
        canvas.__DnCopyListenerHooked = true;
        const onCopy = () => { try { captureCopyKeys(canvas); } catch (error) { /* 静默 */ } };
        try { document.addEventListener("copy", onCopy, true); } catch (error) { /* 非浏览器环境 */ }
    }
    // ② 画线有关的钩子：三条独立判定，谁能装就装谁（见 installDrawHooks 的头注释）。
    installDrawHooks(canvas);
    // ③ 点线中点 → 弹菜单。⚠️ 这两条各自带 guard：看门狗每秒都会调 patchCanvas，
    //    没有 guard 就会一层层套下去（processMouseDown 越包越深、pointerdown 监听器越挂越多）。
    if (!canvas.__DnMousePatched) {
        canvas.__DnMousePatched = true;
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
    }
    if (!canvas.__DnPointerPatched) {
        canvas.__DnPointerPatched = true;
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
        // 打时间戳：跨流粘贴 / 打开工作流的"刚落地"时刻。
        // normalizeLinks 靠它给悬空连线一个无条件宽限窗口 —— 粘贴首帧读不出
        // 资产卡身份是**正常现象**，不能当"这张图没有这张卡"处理（删了不可逆）。
        this.__dnConfiguredAt = Date.now();
        normalizeLinks(this);
        syncNative(this);
        this.setDirtyCanvas?.(true, true);
        return result;
    };

    // ⚠️ 跨画布复制的 source_id 重映射**不**挂在这里 —— 挂在 `onAddedToGraph` 上看似更"权威"，
    // 但实测本 ComfyUI 版本（秋叶预构建）的 `LGraphNode.prototype.onAddedToGraph` 是 undefined，
    // 框架根本不调它，挂上去是空壳。真正可靠的触发点是 `normalizeLinks` 本身：它被
    // `onDrawForeground`（每帧渲染）+ `onConfigure`（图加载）高频调用，节点一在新画布里被画过，
    // 失效的 source_id 就会被按资产名救回（见 normalizeLinks 内的 remapBrokenLink 调用）。
    // 若未来升级到带 onAddedToGraph 的 LiteGraph，可在此补一份前置重映射，但**不要删掉
    // normalizeLinks 里的那份**——它是兜底，onAddedToGraph 只是更早的触发点。

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

    // ② 节点右键菜单：一键清空 / 反转顺序（比逐个去点线中点方便得多）。
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

/** 安装一张图的事件监听：节点一被 add 进图（Ctrl+V / graph.add / loadGraphData）就
 *  立即对该图里所有 DN 组跑一次 normalizeLinks → 重映射按资产名救回失效连线。
 *  这是比"等渲染才触发"更早、更可靠的入口 —— 复制粘贴那一刻连线就被救回，
 *  不用等到画布画出来。同一张图只挂一次（幂等）。 */
function installGraphWatcher(graph) {
    if (!graph || graph.__DnMultiLinkWatched) return;
    graph.__DnMultiLinkWatched = true;
    // LiteGraph 的图事件：LGraph.prototype.on(event, cb)。
    // 节点被 graph.add() 时触发 "node_added"（本版本实测存在；若个别版本没有也不报错）。
    const fixupAll = () => {
        for (const node of graph._nodes || []) {
            if (node?.comfyClass === NODE_CLASS || node?.type === NODE_CLASS) {
                try { normalizeLinks(node); } catch (error) { /* 静默：下一帧 onDrawForeground 会再跑 */ }
            }
        }
    };
    const addListener = (event, cb) => {
        if (typeof graph.on !== "function") return;
        try { graph.on(event, cb); } catch (error) { /* 旧版 LiteGraph 可能不支持，忽略 */ }
    };
    addListener("node_added", (newNode) => {
        // 只关心"新增的是 DN 组"或"新增的是资产卡（可能是组的来源）"；
        // 统一对全图 DN 组扫一遍，简单且幂等。
        setTimeout(fixupAll, 0);
    });
    // 图 configure（loadGraphData 后）也跑一次，兜底 loadGraphData 路径。
    addListener("node_removed", () => { setTimeout(fixupAll, 0); });
}

/** 给 app 里所有现存图 + 未来切到的新图挂上监听（app.setGraph / 新建时调用）。 */
function watchAllGraphs() {
    try {
        if (app.graph) installGraphWatcher(app.graph);
    } catch (error) { /* app 还没就绪 */ }
    // 钩 app.setGraph：用户切工作流 / 新建流时给新图也挂上。
    if (typeof app.setGraph === "function" && !app.__DnMultiLinkSetGraphHooked) {
        app.__DnMultiLinkSetGraphHooked = true;
        const originalSetGraph = app.setGraph;
        app.setGraph = function (graph, ...rest) {
            const result = originalSetGraph.apply(this, arguments);
            try { installGraphWatcher(graph); } catch (error) { /* 静默 */ }
            // ⚠️ 切工作流时 `app.canvas` 可能被整个换掉（新 canvas 上没有任何我们的
            //    钩子：复制不抓指纹、虚拟连线不画）。这里补一次幂等的重装 ——
            //    patchCanvas 内部每一条都有自己的 guard，重复调用只做"缺哪条补哪条"。
            try { patchCanvas(); } catch (error) { /* 静默 */ }
            return result;
        };
    }
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
            // 给当前图 + 未来切到的新图挂 node_added 监听：复制粘贴那一刻就救回失效连线。
            try { watchAllGraphs(); } catch (error) { /* app.graph 可能还没就绪，下轮再挂 */ }
            // ⚠️ 这段轮询只负责"开跑头几秒"的追赶，**长期由看门狗兜底**（前端会整个换掉
            //    画布实例，而这里 12×250ms 就结束了）。判据改成"画线钩子里任意一条装上了"，
            //    不再死盯 drawConnections —— 否则它一直缺，这里就一直白转、最后什么都没有。
            const canvasReady = !!(app.canvas?.__DnForegroundPatched
                && (app.canvas?.__DnMultiLinkPatched || app.canvas?.__DnBackPatched)
                && app.canvas?.__DnCopyKeysHooked);
            if (attempt < 12 && (!app.__DnMultiLinkPromptPatched || !canvasReady)) {
                setTimeout(() => installPatches(attempt + 1), 250);
            }
        };
        installPatches();
        // 画布被换掉（Vue 重挂 / 切工作流 / 刚给节点挂上 DOM 控件那一下）时自动补装。
        try { startCanvasWatchdog(); } catch (error) { /* 静默：下一帧 onDrawForeground 还会试 */ }
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
