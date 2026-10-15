/**
 * 资产卡任务台（DNGroupDirector）前端（2026-10-15 由「资产卡导演台」改名，节点 id 不变）
 * ===========================================================================
 * 后端（director_core.py + nodes.py）是个**选段器**：N 段「资产卡镜头打包」接进来，
 * 按「运行段 current_index」只把第 k 段的分组原样吐出去，于是下游
 * 「资产卡Group拆分 → 参考生成 → 采样」只接一次线。本文件负责三件事：
 *
 * 1) **分段输入口不限段数**：后端 Schema 里只声明 group_1，另开了
 *    `accept_all_inputs=True`（没有它，我们动态加的口会被后端**静默忽略** ——
 *    症状是"连了 5 段只跑第 1 段"，不报错，最坑）。这里按连线自动加口：
 *    接满最后一个空口就自动多出一个空口；尾部多出来的**空口**自动收掉。
 *    ⚠️ 三条铁律：
 *      · 已连线的口**永不删**（删口会连带断掉用户的下游分支，不可逆）；
 *      · 只删"没有连线、且段号大于所需"的**尾部**空口 —— 绝不删中间的，
 *        删中间口会让后面所有口的位置前移，连线要跟着改 target_slot，是错位事故的源头；
 *      · **载入工作流期间一个口都不动**（configure 是逐节点跑的，连线要等整图
 *        configure 之后才注册；载入期改口 = 读到没落位的默认值 / 撞上"连线还没注册"）。
 *
 * 2) **分段面板**（节点内 DOM）：按运行顺序列出每一段 —— 拖动排序、逐段勾「运行」、
 *    逐段开关二采、显示时长 / 参考图缩略图（最多 3 张）/ 一采缓存状态。
 *    面板顺序 = **提交顺序**，它不碰任何连线；段号（group_k）才是接线口径。
 *    拖动排序后，左边**口上的显示名会跟着变成「第n段」**（n = 面板顺序），
 *    方便一眼对齐 —— 但那只改文字，**不改连线、也不改 group_k**：
 *    因为提交时写的是 `current_index = group_k`（绝对值），跟口排第几无关。
 *
 * 3) **队列调度器（流水线）**：点「▶ 运行」= 按面板顺序**一段一段**提交：
 *    同一时刻只有 1 段在飞（排队 / 运行中），它跑完自动提交下一段。
 *    （一次全排进队列也行，但 ComfyUI 队列是共享的，别人再排任务就会插到你
 *    的段与段之间；1 段流水线则始终紧跟当前段，且「停」的语义也更清楚。）
 *    每份只改三处（改的是**提交出去的那份快照**，画布上的控件一个字都不动 ——
 *    所以「二采开关是下游节点上的 required 控件、连不上线」根本不是障碍，
 *    也不需要给后端加隐藏输入）：
 *      · `任务台.inputs.current_index = 该段的段号`
 *      · `下游采样器.inputs.run_refine   = 该段的二采开关`
 *      · `下游采样器.inputs.cache_name   = 该段的专属缓存名`
 *    队列状态用 /queue + /history 查回来显示在行上。
 *
 * ⚠️ 为什么缓存名必须按段隔离（`{基础名}_s{打包节点id}`）：
 *    SelfLift 的一采缓存指纹只算 种子 / transition_step / 低res缩放 / cfg / latent 形状
 *    （见 selflift_cache.py 的 _cache_key_fingerprint），**不含提示词**。两段只要时长与
 *    分辨率一样就算出同一个指纹 —— 不隔离的话第 2 段会**直接命中第 1 段的一采缓存**，
 *    跳过一采、拿第 1 段的 latent 去跑二采，成片就是第 1 段的内容（静默串味）。
 *    用**打包节点 id** 而不是面板序号做后缀：序号会随排序变，一重排就串味；
 *    节点 id 是这一段的身份，排序 / 断线重连都不会变。
 *
 * 界面口径（改了要一起改）：
 *   · 面板行 = 已接线的段；行上的「#id」是上游打包节点号，「段k」才是接线口径。
 *   · 「运行」= 是否参与本次「全部运行」；不勾的段一根线都不动，只是不被提交。
 *   · 二采 = 该段提交时给下游采样器写的 run_refine（默认跟着采样器控件当前值走）。
 */

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { resolveMediaCounts } from "./dn_prompt_rich.js";

/* ================================================================
 * 0. 常量
 * ================================================================ */

const NODE_CLASS = "DNGroupDirector";
/** 每段状态存这里（JSON 串）。节点 properties 实测会随工作流存盘（本包 pml_* 同款）。 */
const STATE_PROP = "dn_director_state";
const INDEX_WIDGET = "current_index";
/** 段标签注入键：塞进 prompt 快照里任务台条目的这个隐藏键（画布上不出现任何输入口）。
 *  后端节点开了 accept_all_inputs，未声明的键也会原样送进 execute(**kwargs)。 */
const TAG_KEY = "tag_text";
const SLOT_RE = /^group_(\d+)$/;
const PANEL_WIDGET = "dn_director_panel";
const PANEL_TYPE = "dn_director";
/** 下游要检查的两个节点类（提示用，不是硬依赖）。 */
const SPLIT_CLASS = "DNGroupSplit";
/** 采样器识别口径：同时有 run_refine 与 cache_name 两个控件（= SelfLift Sampler DN）。 */
const SAMPLER_WIDGETS = ["run_refine", "cache_name"];

const THUMB_MAX = 3;
const ROW_H = 56;
const LIST_MAX_ROWS = 5;
const PANEL_MIN_W = 320;
const HEAD_H = 28;
const HINT_H = 16;
const PANEL_PAD = 6;

const SCAN_MS = 700;
const CACHE_MS = 3000;
const RUN_POLL_MS = 1500;

const C = {
  bg: "rgba(0,0,0,.30)",
  row: "rgba(255,255,255,.05)",
  rowOff: "rgba(255,255,255,.015)",
  line: "rgba(255,255,255,.12)",
  text: "#dcdcdc",
  dim: "#9a9a9a",
  faint: "#7c7c7c",
  ok: "#63c86f",
  warn: "#ffba50",
  bad: "#ff7a6b",
  accent: "#ffd54a",
  /** 「▶ 运行」按钮底色 —— 取自 ComfyUI 原生运行按钮的主色蓝（#0b8ce9），配白字。 */
  run: "#0b8ce9",
  runText: "#ffffff",
};

/* ================================================================
 * 1. 小工具
 * ================================================================ */

function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text != null) node.textContent = String(text);
  return node;
}

function getWidget(node, name) {
  return (node?.widgets || []).find((w) => w && w.name === name) || null;
}

function nodeClassName(node) {
  return String(node?.comfyClass || node?.type || "");
}

function isOurNode(node) {
  return Boolean(node) && nodeClassName(node) === NODE_CLASS;
}

function asBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["", "0", "false", "off", "no"].includes(text)) return false;
    if (["1", "true", "on", "yes"].includes(text)) return true;
  }
  return value == null ? fallback : Boolean(value);
}

function slotIndexOf(name) {
  const match = SLOT_RE.exec(String(name || ""));
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isFinite(index) && index >= 1 ? index : null;
}

function deepClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    console.warn("[DN director] 复制 prompt 失败:", error);
    return null;
  }
}

/* ================================================================
 * 2. 连线与上游（新旧两种前端都要取得到）
 *
 *    新版 litegraph 把连线从"口对象自己身上"挪到了图的拓扑表 graph.links（Map）里，
 *    口对象（NodeInputSlot / NodeOutputSlot）上**没有** links 属性。
 *    所以取连线一律走"图拓扑表反查"，口自己的 links 只当老前端兜底。
 * ================================================================ */

function allLinks(graph) {
  const table = graph?.links;
  if (!table) return [];
  if (typeof table.values === "function") return [...table.values()];
  return Object.values(table);
}

function getLink(node, id) {
  const table = (node?.graph || app.graph)?.links;
  if (!table || id == null) return null;
  if (typeof table.get === "function") return table.get(id) ?? null;
  return table[id] ?? null;
}

/** 某个输入口上接着的上游节点（没接/取不到 → null）。 */
function sourceOf(node, input) {
  const graph = node?.graph || app.graph;
  if (!graph || !input || input.link == null) return null;
  const link = getLink(node, input.link);
  if (!link) return null;
  const id = Number(link.origin_id ?? link.originId);
  if (!Number.isFinite(id)) return null;
  return graph.getNodeById?.(id) || null;
}

/** 从某节点出发、沿连线往下游走一圈（广度优先，带环保护）。 */
function downstreamNodes(start) {
  const graph = start?.graph || app.graph;
  const out = [];
  if (!graph) return out;
  const adjacency = new Map();
  for (const link of allLinks(graph)) {
    const from = String(link?.origin_id ?? link?.originId ?? "");
    const to = Number(link?.target_id ?? link?.targetId);
    if (!from || !Number.isFinite(to)) continue;
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from).add(to);
  }
  const seen = new Set([String(start.id)]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    for (const targetId of adjacency.get(String(current.id)) || []) {
      const target = graph.getNodeById?.(targetId);
      if (!target || seen.has(String(target.id))) continue;
      seen.add(String(target.id));
      out.push(target);
      queue.push(target);
    }
  }
  return out;
}

/** 下游的采样器（SelfLift Sampler DN）：按"有没有 run_refine + cache_name 控件"认，
 *  不按类名认 —— 类名一改就静默失效，而控件名是它自己的契约。 */
function findSamplers(node) {
  return downstreamNodes(node).filter((item) =>
    SAMPLER_WIDGETS.every((name) => Boolean(getWidget(item, name))));
}

/** 下游的「资产卡Group拆分」。 */
function findSplit(node) {
  return downstreamNodes(node).find((item) => nodeClassName(item) === SPLIT_CLASS) || null;
}

/** 下游的「保存视频」（类名 SaveVideo / CreateVideo / SaveWEBM）。
 *  段标签（tag）走**连线**接它的 filename_prefix，调度器不动它。 */
function findSaveVideo(node) {
  return downstreamNodes(node).find((item) =>
    ["SaveVideo", "CreateVideo", "SaveWEBM"].includes(nodeClassName(item))) || null;
}

/* ================================================================
 * 3. 分段与每段状态
 *
 *    段状态存在 node.properties[STATE_PROP]（JSON 串）里，key 用**上游打包节点 id**：
 *      order   [key…]       面板顺序（= 提交顺序）
 *      enabled {key: bool}  这一段的「运行」勾选
 *      refine  {key: bool}  这一段的二采开关
 *    用节点 id 而不是面板序号：排序变化不该让某段的设置跑到别人身上。
 * ================================================================ */

function readState(node) {
  const raw = node?.properties?.[STATE_PROP];
  let data = null;
  try {
    if (typeof raw === "string" && raw.trim()) data = JSON.parse(raw);
    else if (raw && typeof raw === "object") data = raw;
  } catch (error) {
    console.warn("[DN director] 分段状态读不出来（按空的算）:", error);
  }
  if (!data || typeof data !== "object") data = {};
  return {
    order: Array.isArray(data.order) ? data.order.map(String) : [],
    enabled: data.enabled && typeof data.enabled === "object" ? { ...data.enabled } : {},
    refine: data.refine && typeof data.refine === "object" ? { ...data.refine } : {},
  };
}

function writeState(node, state) {
  if (!node) return;
  node.properties = node.properties || {};
  node.properties[STATE_PROP] = JSON.stringify({
    v: 1,
    order: state.order,
    enabled: state.enabled,
    refine: state.refine,
  });
}

/** 采样器控件上的二采默认值（新段没存过设置时拿它当默认）。 */
function samplerDefaultRefine(node) {
  const sampler = (node.__dnSamplers || [])[0];
  const widget = getWidget(sampler, "run_refine");
  return widget ? asBool(widget.value, true) : true;
}

function isEnabled(node, key) {
  const value = readState(node).enabled[key];
  return value === undefined ? true : asBool(value, true);
}

function isRefine(node, key) {
  const value = readState(node).refine[key];
  return value === undefined ? samplerDefaultRefine(node) : asBool(value, true);
}

function setFlag(node, field, key, value) {
  const state = readState(node);
  state[field][key] = Boolean(value);
  writeState(node, state);
}

/** 已接线的段（按 node.inputs 的顺序）。 */
function segmentsOf(node) {
  const out = [];
  (node.inputs || []).forEach((input, position) => {
    const index = slotIndexOf(input?.name);
    if (index == null) return;
    const source = sourceOf(node, input);
    if (!source) return;
    out.push({ key: String(source.id), index, position, input, source });
  });
  return out;
}

/**
 * 面板顺序 → 段列表，并把"新接上的段"并进 order。
 *
 * 排序稳定：order 里有的按 order；刚接上、order 里还没有的排在已有段之后（段号升序）；
 * **这次不在场的 key 按原相对位置保留在 order 末尾** —— 断线再连回来，它还在原来的位置。
 */
function orderedSegments(node) {
  const state = readState(node);
  const segments = segmentsOf(node);
  const rank = new Map();
  state.order.forEach((key, index) => rank.set(key, index));

  const known = [];
  const fresh = [];
  for (const segment of segments) {
    (rank.has(segment.key) ? known : fresh).push(segment);
  }
  known.sort((a, b) => rank.get(a.key) - rank.get(b.key));
  fresh.sort((a, b) => a.index - b.index);

  const here = new Set(segments.map((segment) => segment.key));
  const absent = state.order.filter((key) => !here.has(key));
  const nextOrder = [...known.map((s) => s.key), ...fresh.map((s) => s.key), ...absent];

  let seeded = false;
  for (const segment of segments) {
    if (state.enabled[segment.key] === undefined) {
      state.enabled[segment.key] = true;
      seeded = true;
    }
  }
  if (nextOrder.join("|") !== state.order.join("|")) {
    state.order = nextOrder;
    seeded = true;
  }
  if (seeded) writeState(node, state);

  return { list: [...known, ...fresh], state };
}

/**
 * 4. 每段的预览信息（时长 / 素材数 / 缩略图）
 * ================================================================ */

/** 这一段的「段标签」：`段k_一采/二采`（后端 tag 输出口同一口径）。
 *  一采/二采由该段面板上的二采开关（isRefine）决定。 */
function segmentTag(node, segment) {
  return `段${segment.index}_${isRefine(node, segment.key) ? "二采" : "一采"}`;
}

/** 资产卡的图片文件名（与 dn_prompt_rich.cardInfo 同一套取值口径，只取图那一半）。 */
function imageOf(card) {
  const props = card?.properties || {};
  const raw = props.pml_image_filename;
  const text = String(raw == null ? "" : raw).trim();
  if (text && text.toLowerCase() !== "(none)" && text.toLowerCase() !== "none") return text;
  const widget = (card?.widgets || []).find((item) => item && /image|file/i.test(item.name || ""));
  const value = typeof widget?.value === "object" ? widget?.value?.filename : widget?.value;
  if (typeof value === "string" && /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(value)) return value;
  return "";
}

/** 这一段前几张资产卡的图（最多 THUMB_MAX 张）。
 *  优先顺着 medias 的连线（含前端注入的多连线隐藏槽 media_N）现取；
 *  取不够再用打包节点自己存的连线快照 dn_media_to_group_links 兜底。 */
function segmentThumbs(packing, max = THUMB_MAX) {
  const names = [];
  const push = (value) => {
    const text = String(value || "").trim();
    if (!text || text.toLowerCase() === "(none)") return;
    if (!names.includes(text)) names.push(text);
  };
  for (const input of packing?.inputs || []) {
    const name = String(input?.name || "");
    if (name !== "medias" && !/^media_\d+$/.test(name)) continue;
    const source = sourceOf(packing, input);
    if (source) push(imageOf(source));
  }
  if (names.length < max) {
    const saved = packing?.properties?.dn_media_to_group_links;
    if (Array.isArray(saved)) {
      const ordered = [...saved].sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0));
      for (const item of ordered) push(item?.source_image);
    }
  }
  return names.slice(0, max);
}

/** 缩略图地址：**不带**时间戳 —— 让浏览器按 URL 缓存住，列表滚动/重建都不再发请求。
 *  服务端用 preview=webp;45 把大图转小（质量 45 的 webp，字节数通常只有原图的十分之一）。 */
function thumbUrl(filename) {
  const normalized = String(filename || "").replace(/\\/g, "/");
  const separator = normalized.lastIndexOf("/");
  const subfolder = separator >= 0 ? normalized.slice(0, separator) : "";
  const name = separator >= 0 ? normalized.slice(separator + 1) : normalized;
  const params = new URLSearchParams({ filename: name, type: "input", preview: "webp;45" });
  if (subfolder) params.set("subfolder", subfolder);
  return "/view?" + params.toString();
}

/** 这一段的时长（打包节点上的 duration_sec 控件）。 */
function segmentDuration(packing) {
  const value = getWidget(packing, "duration_sec")?.value;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** 这一段现在能不能跑：能跑返回 null，不能跑返回人话原因（面板标红、运行时不提交）。 */
function blockReason(node, segment) {
  const media = resolveMediaCounts(segment.source);
  if (media.known && media.imageOverflow > 0) {
    return `参考图 ${media.imageRaw} 张 > 上限 9，后端会直接报错`;
  }
  if (media.known && media.image === 0 && media.audio === 0) {
    const promptWidget = getWidget(segment.source, "prompt");
    const text = promptWidget ? String(promptWidget.value || "").trim() : "";
    if (!text) return "提示词与素材都是空的，后端会直接报错";
  }
  return null;
}

/* ================================================================
 * 5. 分段口：按连线自动增删（段数不限）
 * ================================================================ */

function groupInputs(node) {
  const out = [];
  (node.inputs || []).forEach((input, position) => {
    const index = slotIndexOf(input?.name);
    if (index != null) out.push({ index, position, input });
  });
  return out;
}

function addSlot(node, index) {
  if (typeof node.addInput !== "function") return false;
  try {
    node.addInput(`group_${index}`, "MMX_DIR_GROUP");
    return true;
  } catch (error) {
    console.warn("[DN director] 增加分段口失败:", error);
    return false;
  }
}

/** 删掉第 position 个输入口。**只在我们确认它没有连线时调用**。 */
function removeSlotAt(node, position) {
  const before = (node.inputs || []).length;
  if (typeof node.removeInput === "function") {
    try {
      node.removeInput(position);
    } catch (error) {
      console.warn("[DN director] removeInput 抛错，改用原地删除:", error);
    }
    if ((node.inputs || []).length < before) return true;
  }
  // 兜底：直接 splice。安全前提 = 调用方只删"尾部、没连线"的口，
  // 所以不会动到任何已经挂在线上的 target_slot。
  try {
    node.inputs.splice(position, 1);
    return true;
  } catch (error) {
    console.warn("[DN director] 删除分段口失败（保持原样，不影响运行）:", error);
    return false;
  }
}

/**
 * 让分段口与连线对得上：**永远多留一个空口**给下一次接线。
 *
 *  - 一个都没接 → 只留 group_1 一个空口（新拖出来的节点干干净净）；
 *  - 接了 1..k 段 → 口开到 group_{最大段号+1}（第一个空口挂在最后）；
 *  - 尾部多出来的空口（段号 > 需要数、且没连线）收掉；**已连线的一个都不动**。
 *
 * 口上写「第n段」当显示名：n 是**面板顺序**（拖动排序后的顺序），
 * 让左边接线和右边分段行一眼对得起来。**段号口径仍然是 group_k**
 *（后端 current_index 用的是 k），显示名纯粹是给人看的，不参与任何逻辑。
 *
 * ⚠️ 名称前缀区分「已接线」与「空口」：
 *   · 已接线 → `第n段`
 *   · 空口   → `＋ 第n段`（提示这里是下一个可接的位）
 *
 * 返回口数是否变了（变了调用方要重新量高度）。
 */
function ensureSlots(node) {
  if (!node || node.__dnLoading) return false;
  const slots = groupInputs(node);
  if (!slots.length) return addSlot(node, 1);

  const present = new Map(slots.map((item) => [item.index, item]));
  const linked = slots.filter((item) => item.input.link != null).map((item) => item.index);
  const wanted = linked.length ? Math.max(...linked) + 1 : 1;

  let changed = false;
  // ① 补：段号有洞也补上（**名字才是口径**，位置无所谓，所以直接追加到末尾 ——
  //    往中间插口要改后面所有口的位置和连线的 target_slot，那是错位事故的源头）
  for (let index = 1; index <= wanted; index += 1) {
    if (present.has(index)) continue;
    changed = addSlot(node, index) || changed;
  }
  // ② 收：只收尾部"段号大于所需、且没连线"的空口（从后往前删，位置才不会被前面的删除带偏）
  const drop = groupInputs(node)
    .filter((item) => item.index > wanted && item.input.link == null)
    .map((item) => item.position)
    .sort((a, b) => b - a);
  for (const position of drop) changed = removeSlotAt(node, position) || changed;

  // ③ 显示名 = 面板顺序编号（见函数头说明）。这一步**不算"口数变了"** ——
  //    万一某个前端每次都把 localized_name 抹掉，也不该让面板每 700ms 重建一次。
  const order = new Map(orderedSegments(node).list.map((segment, i) => [segment.key, i + 1]));
  for (const item of groupInputs(node)) {
    const source = sourceOf(node, item.input);
    const rank = source ? order.get(String(source.id)) : null;
    const label = source && rank ? `第${rank}段` : `＋ 第${item.index}段`;
    if (item.input.localized_name !== label) item.input.localized_name = label;
  }
  return changed;
}

/* ================================================================
 * 6. 下游采样器：逐段写 run_refine / cache_name 的落点
 * ================================================================ */

/** 下游采样器（renderPanel 每轮会刷新一次这份缓存，别在别处直接 findSamplers）。 */
function cachedSamplers(node) {
  return node.__dnSamplers || [];
}

function samplerBaseName(node) {
  const sampler = cachedSamplers(node)[0];
  const value = getWidget(sampler, "cache_name")?.value;
  return String(value == null ? "" : value).trim();
}

/** 这一段的专属缓存名：基础名 + `_s{打包节点id}`（见文件头"为什么必须按段隔离"）。 */
function cacheNameFor(node, segment) {
  const base = samplerBaseName(node);
  if (!base) return "";
  return `${base}_s${segment.source.id}`;
}

/* ================================================================
 * 7. 面板 DOM
 * ================================================================ */

function panelHeight(rows) {
  const count = Math.max(1, Math.min(rows || 0, LIST_MAX_ROWS));
  // 根节点 padding 上下各 PANEL_PAD + 上下边框各 1px；head / hint / list 都用 border-box，
  // 所以它们的高度就是字面值（免得算出来的节点高度与真实内容差几个像素，底下留一条缝）。
  return HEAD_H + HINT_H + count * ROW_H + PANEL_PAD * 2 + 2;
}

function ensurePanel(node) {
  if (node.__dnPanel) return node.__dnPanel;
  if (typeof node.addDOMWidget !== "function") return null;

  const root = el("div", [
    "box-sizing:border-box",
    "width:100%",
    `min-width:${PANEL_MIN_W}px`,
    `background:${C.bg}`,
    "border:1px solid rgba(255,255,255,.10)",
    "border-radius:4px",
    `padding:${PANEL_PAD}px`,
    "font:11px/14px 'Microsoft YaHei',sans-serif",
    `color:${C.text}`,
    "user-select:none",
    "position:relative",
    "z-index:10",
    "overflow:hidden",
  ].join(";"));
  // 面板里的交互一律不许冒泡到画布（否则点一下勾选框会把整张图拖走 / 缩放画布）
  for (const type of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu"]) {
    root.addEventListener(type, (event) => event.stopPropagation(), false);
  }

  const head = el("div", [
    "display:flex", "align-items:center", "gap:4px", "box-sizing:border-box",
    `height:${HEAD_H}px`, `border-bottom:1px solid ${C.line}`, "padding-bottom:4px",
  ].join(";"));

  const sum = el("span", [
    "flex:1", "min-width:0", "overflow:hidden", "white-space:nowrap",
    "text-overflow:ellipsis", `color:${C.dim}`, "font-size:10px",
  ].join(";"));
  head.append(sum);   // 摘要在最左（后面的按钮按顺序往后排）

  const buttons = {};
  // bg 省略 = 原来的半透明灰底；给了 bg 就用它当实心底（边框同色，尺寸不变）。
  const makeButton = (label, title, onClick, color, bg) => {
    const button = el("button", [
      "flex:0 0 auto", "padding:1px 8px", "font-size:12px", "line-height:18px",
      "border-radius:3px", "cursor:pointer",
      `border:1px solid ${bg || C.line}`,
      `background:${bg || "rgba(255,255,255,.07)"}`,
      `color:${color || C.text}`,
    ].join(";"), label);
    button.title = title;
    if (bg) {   // 实心按钮给点悬停反馈，不然和普通灰底按钮一样没动静
      button.addEventListener("pointerenter", () => { button.style.filter = "brightness(1.12)"; });
      button.addEventListener("pointerleave", () => { button.style.filter = ""; });
    }
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick(button);
    });
    head.append(button);
    return button;
  };
  // 两组「全…」切换按钮：各自合二为一，标签随当前状态翻转
  //   · 选中态：有段勾选「运行」→ 显示「全不选」；否则「全选」
  //   · 二采态：有段开二采    → 显示「全关二采」；否则「全开二采」
  buttons.toggleAll = makeButton("全选", "把所有段都勾上「运行」", () => toggleAllEnabled(node), C.text);
  buttons.toggleRefine = makeButton("全开二采", "把所有段的二采开关都打开", () => toggleAllRefine(node), C.text);
  buttons.run = makeButton("▶ 运行", "按面板顺序跑：跑完一段自动提交下一段（同一时刻只跑一段）", () => runSelected(node), C.runText, C.run);
  buttons.stop = makeButton("■ 停", "中断正在跑的这一段，并放弃后面还没提交的段", () => stopRun(node), C.bad);

  const hint = el("div", [
    "box-sizing:border-box",
    `height:${HINT_H}px`, "line-height:16px", "font-size:10px",
    "overflow:hidden", "white-space:nowrap", "text-overflow:ellipsis",
    `color:${C.warn}`,
  ].join(";"));

  const list = el("div", [
    "box-sizing:border-box",
    "overflow-y:auto", "overflow-x:hidden",
    `height:${Math.min(LIST_MAX_ROWS, 3) * ROW_H}px`,   // 真实高度由 renderPanel 每轮写
    "margin-top:2px",
    "scrollbar-width:thin",
  ].join(";"));
  // 列表能滚时别让滚轮去缩放画布（不能滚时照常交给画布）
  list.addEventListener("wheel", (event) => {
    if (list.scrollHeight > list.clientHeight + 1) event.stopPropagation();
  }, { passive: true });

  root.append(head, hint, list);
  const widget = node.addDOMWidget(PANEL_WIDGET, PANEL_TYPE, root, {
    serialize: false,
    hideOnZoom: false,
  });
  if (widget) {
    widget.computeSize = (width) => [
      Math.max(PANEL_MIN_W, Math.round(Number(width) || 0)),
      panelHeight(node.__dnRowCount || 0),
    ];
    widget.serializeValue = () => undefined;
  }

  node.__dnPanel = { root, head, hint, list, sum, buttons, widget };
  return node.__dnPanel;
}

function setAllEnabled(node, value) {
  const { list, state } = orderedSegments(node);
  for (const segment of list) state.enabled[segment.key] = Boolean(value);
  writeState(node, state);
  renderPanel(node, { force: true });
}

/** 全部段的「运行」当前状态：true = 全勾，false = 全不勾，null = 段数 0 或混合。 */
function allEnabledState(node) {
  const { list } = orderedSegments(node);
  if (!list.length) return null;
  let anyOn = false, anyOff = false;
  for (const segment of list) {
    if (isEnabled(node, segment.key)) anyOn = true;
    else anyOff = true;
  }
  return anyOn && !anyOff ? true : (!anyOn && anyOff ? false : null);
}

/** 全部段的「二采」当前状态：true = 全开，false = 全关，null = 段数 0 或混合。 */
function allRefineState(node) {
  const { list } = orderedSegments(node);
  if (!list.length) return null;
  let anyOn = false, anyOff = false;
  for (const segment of list) {
    if (isRefine(node, segment.key)) anyOn = true;
    else anyOff = true;
  }
  return anyOn && !anyOff ? true : (!anyOn && anyOff ? false : null);
}

/** 切换「全选/全不选」：全勾时变全不勾；否则（含部分勾）全勾。 */
function toggleAllEnabled(node) {
  setAllEnabled(node, allEnabledState(node) !== true);
}

/** 全部二采开关设成 value。 */
function setAllRefine(node, value) {
  const { list, state } = orderedSegments(node);
  for (const segment of list) state.refine[segment.key] = Boolean(value);
  writeState(node, state);
  renderPanel(node, { force: true });
}

/** 切换「全开二采/全关二采」：全开时变全关；否则（含部分开）全开。 */
function toggleAllRefine(node) {
  setAllRefine(node, allRefineState(node) !== true);
}

/* ---------- 行的骨架 ---------- */

function buildRow(node, segment, orderIndex) {
  const row = el("div", [
    "display:flex", "align-items:center", "gap:4px", "box-sizing:border-box",
    `height:${ROW_H - 6}px`, `margin:3px 0`, "padding:0 4px",
    `border:1px solid ${C.line}`, "border-radius:3px",
    `background:${C.row}`,
    "cursor:grab",
  ].join(";"));
  row.draggable = true;
  row.dataset.key = segment.key;

  const grip = el("span", [
    "flex:0 0 auto", `color:${C.faint}`, "font-size:12px", "cursor:grab",
  ].join(";"), "⣿");
  grip.title = "按住拖动，改这一段的运行先后（只影响提交顺序；左边口上的「第n段」标号会跟着变，但连线和 group_k 不动）";

  const check = document.createElement("input");
  check.type = "checkbox";
  check.style.cssText = "flex:0 0 auto;margin:0 1px;cursor:pointer";
  check.title = "本段是否参与「▶ 运行」";
  // 行整体是 draggable：在勾选框上按下时，浏览器的默认动作会"开始拖这一行"。
  // 在 mousedown 上 preventDefault 正好掐掉这个默认动作，而 click / change 照常触发。
  check.addEventListener("mousedown", (event) => event.preventDefault());
  check.addEventListener("change", () => {
    setFlag(node, "enabled", segment.key, check.checked);
    renderPanel(node, { force: true });
  });

  const ord = el("span", [
    "flex:0 0 auto", "width:13px", "text-align:right",
    `color:${C.accent}`, "font-size:11px",
  ].join(";"));

  const thumbs = el("div", [
    "flex:0 0 auto", "display:flex", "gap:2px", "align-items:center",
  ].join(";"));

  const info = el("div", ["flex:1", "min-width:0", "display:flex", "flex-direction:column", "gap:1px"].join(";"));
  const line1 = el("div", [
    "overflow:hidden", "white-space:nowrap", "text-overflow:ellipsis", "font-size:11px",
  ].join(";"));
  const line2 = el("div", [
    "overflow:hidden", "white-space:nowrap", "text-overflow:ellipsis",
    "font-size:10px", `color:${C.dim}`,
  ].join(";"));
  info.append(line1, line2);

  const refine = el("button", [
    "flex:0 0 auto", "width:46px", "padding:1px 0", "font-size:11px", "line-height:15px",
    "border-radius:3px", "cursor:pointer", `border:1px solid ${C.line}`,
    "background:rgba(255,255,255,.07)",
  ].join(";"));
  refine.title = "本段的二采开关（提交时写到下游采样器的 run_refine；画布上的控件不动）";
  refine.addEventListener("mousedown", (event) => event.preventDefault());   // 同上：别让它变成"拖这一行"
  refine.addEventListener("click", (event) => {
    event.stopPropagation();
    setFlag(node, "refine", segment.key, !isRefine(node, segment.key));
    renderPanel(node, { force: true });
  });

  row.append(grip, check, ord, thumbs, info, refine);
  row.__dnRefs = { check, ord, thumbs, line1, line2, refine };
  bindRowDrag(node, row);
  return row;
}

/* ---------- 拖动排序 ---------- */

function bindRowDrag(node, row) {
  row.addEventListener("dragstart", (event) => {
    node.__dnDraggingKey = row.dataset.key;
    row.style.opacity = ".45";
    try {
      event.dataTransfer.setData("text/plain", row.dataset.key);
      event.dataTransfer.effectAllowed = "move";
    } catch (error) { /* 个别浏览器空 event 时忽略 */ }
    event.stopPropagation();
  });
  row.addEventListener("dragend", () => {
    node.__dnDraggingKey = null;
    row.style.opacity = "";
    renderPanel(node, { force: true });
  });
  row.addEventListener("dragover", (event) => {
    if (!node.__dnDraggingKey) return;
    event.preventDefault();
    event.stopPropagation();
    row.style.borderColor = C.accent;
  });
  row.addEventListener("dragleave", () => {
    row.style.borderColor = C.line;
  });
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    row.style.borderColor = C.line;
    const from = node.__dnDraggingKey;
    const to = row.dataset.key;
    if (from && to && from !== to) moveSegment(node, from, to);
  });
}

/** 把 from 挪到 to 的位置（面板顺序 = 提交顺序，一根线都不动）。 */
function moveSegment(node, from, to) {
  const { state } = orderedSegments(node);
  const order = [...state.order];
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) return;
  order.splice(fromIndex, 1);
  order.splice(toIndex, 0, from);
  state.order = order;
  writeState(node, state);
  renderPanel(node, { force: true });
}

/* ---------- 渲染 ---------- */

function rowStateText(node, segment) {
  const job = node.__dnJobByKey?.get(segment.key);
  if (!job) return null;
  if (job.state === "queued") return { text: "排队中", color: C.dim };
  if (job.state === "running") return { text: "运行中", color: C.accent };
  if (job.state === "done") return { text: "完成", color: C.ok };
  if (job.state === "error") return { text: job.text || "失败", color: C.bad };
  return null;
}

function cacheInfoText(node, segment) {
  const name = cacheNameFor(node, segment);
  if (!name) return { text: "未设缓存命名", color: C.faint, title: "下游采样器的「缓存命名」为空 → 不读也不写一采缓存。" };
  const info = node.__dnCache?.[name];
  const count = Number(info?.count || 0);
  const title = [
    `缓存命名：${name}`,
    count ? `已有 ${count} 份一采缓存` : "还没有一采缓存",
    info?.status ? `最近一次：${info.status}` : "",
    node.__dnCacheDir ? `目录：${node.__dnCacheDir}` : "",
  ].filter(Boolean).join("\n");
  if (!count) return { text: `${name} · 无缓存`, color: C.faint, title };
  return { text: `${name} · 缓存 ${count}`, color: C.ok, title };
}

/** 只在文字真的变了才写 DOM —— 面板是 700ms 一轮刷新的，无脑重写 textContent
 *  会一直触发排版；缩略图更是重建成 <img> 就要重新解码一次（哪怕命中浏览器缓存）。 */
function setText(element, text, color) {
  if (!element) return;
  const next = String(text == null ? "" : text);
  if (element.textContent !== next) element.textContent = next;
  if (color && element.style.color !== color) element.style.color = color;
}

function updateRow(node, row, segment, orderIndex) {
  const refs = row.__dnRefs;
  if (!refs) return;
  const enabled = isEnabled(node, segment.key);
  const blocked = blockReason(node, segment);
  const media = resolveMediaCounts(segment.source);
  const duration = segmentDuration(segment.source);
  const job = rowStateText(node, segment);

  if (refs.check.checked !== enabled) refs.check.checked = enabled;
  setText(refs.ord, String(orderIndex + 1));
  const background = enabled && !blocked ? C.row : C.rowOff;
  if (row.style.background !== background) row.style.background = background;
  const opacity = enabled && !blocked ? "1" : ".62";
  if (row.style.opacity !== opacity) row.style.opacity = opacity;

  // 第一行：段标签（形如「段2_二采」）+ 打包节点 + 时长 + 素材数（+ 运行状态 / 阻塞原因）
  const parts = [segmentTag(node, segment), `#${segment.source.id}`];
  if (duration != null) parts.push(`${duration}s`);
  if (media.known) parts.push(`${media.image}图${media.audio}音`);
  if (job) parts.push(job.text);
  setText(refs.line1, parts.join(" · "), blocked ? C.bad : (job?.color || C.text));
  const title1 = [
    `第 ${segment.index} 段（接线在 group_${segment.index}）`,
    `上游：${segment.source.title || nodeClassName(segment.source)} #${segment.source.id}`,
    blocked ? `⚠ ${blocked}` : "",
  ].filter(Boolean).join("\n");
  if (refs.line1.title !== title1) refs.line1.title = title1;

  // 第二行：一采缓存状态（调度器真正会用的那个缓存名）
  const cache = cacheInfoText(node, segment);
  setText(refs.line2, blocked ? `⚠ ${blocked}` : cache.text, blocked ? C.bad : cache.color);
  const title2 = blocked ? "" : cache.title;
  if (refs.line2.title !== title2) refs.line2.title = title2;

  // 二采按钮
  const refineOn = isRefine(node, segment.key);
  setText(refs.refine, refineOn ? "二采 开" : "二采 关", refineOn ? C.ok : C.faint);

  // 缩略图（最多 3 张）：**内容没变就不重建** —— 重建会让浏览器重新解码图片
  const wants = segmentThumbs(segment.source);
  const thumbKey = wants.join("|");
  if (row.__dnThumbKey !== thumbKey) {
    row.__dnThumbKey = thumbKey;
    refs.thumbs.textContent = "";
    if (!wants.length) {
      refs.thumbs.append(el("span", `color:${C.faint};font-size:10px;width:34px;text-align:center`, "无图"));
    } else {
      for (const name of wants) {
        const img = document.createElement("img");
        img.src = thumbUrl(name);
        img.loading = "lazy";
        img.decoding = "async";
        img.style.cssText = "width:34px;height:34px;object-fit:cover;border-radius:3px;background:rgba(255,255,255,.06)";
        img.title = name;
        img.addEventListener("error", () => { img.style.display = "none"; });
        refs.thumbs.append(img);
      }
    }
  }
}

function updateHint(node, list) {
  const panel = node.__dnPanel;
  if (!panel) return;
  const samplers = cachedSamplers(node);
  const split = findSplit(node);
  const fixOn = asBool(getWidget(split, "fix_max")?.value, false);
  const blocked = list.filter((segment) => blockReason(node, segment));
  const messages = [];
  if (!samplers.length) {
    messages.push("⚠ 下游没找到 SelfLift Sampler DN → 逐段二采 / 缓存命名不会生效");
  }
  if (split && !fixOn) {
    messages.push("⚠ 下游「资产卡Group拆分」没开「固定 9+3+3」→ 各段素材数不同会错位");
  }
  if (blocked.length) {
    messages.push(`⚠ ${blocked.length} 段有问题（行内红字），运行时不会提交`);
  }
  const text = messages.join("　");
  setText(panel.hint, text);
  if (panel.hint.title !== messages.join("\n")) panel.hint.title = messages.join("\n");
}

function updateHeader(node, list) {
  const panel = node.__dnPanel;
  if (!panel) return;
  const picked = list.filter((segment) => isEnabled(node, segment.key) && !blockReason(node, segment));
  const running = (node.__dnJobs || []).filter((job) => job.promptId && !job.done);
  let text = `段 ${list.length} · 已选 ${picked.length}`;
  if (node.__dnRunning) text += " · 运行中";
  if (node.__dnSamplers?.length) text += ` · 采样器 #${node.__dnSamplers[0].id}`;
  setText(panel.sum, text);
  const title = [
    `一共接了 ${list.length} 段；本次会提交 ${picked.length} 段`,
    node.__dnSamplers?.length
      ? `逐段二采 / 缓存命名写到：#${node.__dnSamplers.map((item) => item.id).join("、")}`
      : "⚠ 下游没找到采样器（没有 run_refine + cache_name 两个控件的节点）",
  ].join("\n");
  if (panel.sum.title !== title) panel.sum.title = title;
  panel.buttons.run.disabled = !picked.length;
  panel.buttons.run.style.opacity = picked.length ? "1" : ".5";
  // 两个「全…」切换按钮：标签随当前状态翻转（全勾/全开时显示"关闭"那个）
  const enabledState = allEnabledState(node);
  setText(panel.buttons.toggleAll, enabledState === true ? "全不选" : "全选");
  const refineState = allRefineState(node);
  setText(panel.buttons.toggleRefine, refineState === true ? "全关二采" : "全开二采");
}

/**
 * 渲染面板。分两层：
 *   · **结构层**（有哪些行、什么顺序、行上静态内容）：签名变了才重建 DOM；
 *   · **动态层**（勾选态 / 二采 / 时长 / 素材数 / 缓存 / 运行状态）：每轮原地改文字，
 *     重建 DOM 会让正在拖拽的行丢掉、也让浏览器的缩略图缓存白费。
 */
function renderPanel(node, options = {}) {
  const panel = ensurePanel(node);
  if (!panel) return;
  node.__dnSamplers = findSamplers(node);
  const { list, state } = orderedSegments(node);

  const signature = list.map((segment) => `${segment.key}#${segment.index}@${segment.position}`).join("|");
  const needRebuild = Boolean(options.force)
    || signature !== node.__dnPanelSig
    || node.__dnPanelRows !== list.length;
  if (needRebuild) {
    panel.list.textContent = "";
    if (!list.length) {
      panel.list.append(el("div", [
        "display:flex", "align-items:center", "justify-content:center",
        `height:${ROW_H}px`, `color:${C.faint}`, "font-size:10px",
      ].join(";"), "把「资产卡镜头打包」的 group 接到左边的 group_1 / group_2 …"));
    } else {
      list.forEach((segment, index) => panel.list.append(buildRow(node, segment, index)));
    }
    node.__dnPanelSig = signature;
    node.__dnPanelRows = list.length;
  }

  const rows = panel.list.querySelectorAll("[data-key]");
  rows.forEach((row) => {
    const segment = list.find((item) => item.key === row.dataset.key);
    if (segment) updateRow(node, row, segment, list.indexOf(segment));
  });

  // 列表高度：行少时不留一大块空
  const count = Math.max(1, Math.min(list.length, LIST_MAX_ROWS));
  const wantHeight = `${count * ROW_H}px`;
  if (panel.list.style.height !== wantHeight) panel.list.style.height = wantHeight;

  updateHeader(node, list);
  updateHint(node, list);

  const changedRows = node.__dnRowCount !== list.length;
  node.__dnRowCount = list.length;
  if (changedRows) resizeToContent(node);
  if (needRebuild || options.force || changedRows) node.setDirtyCanvas?.(true, true);
}

/** 行数变了才把节点高度收到内容大小。
 *  用 __dnPanelHeight 记住"这个高度是我们自己设的"：
 *   · 用户手动拉过高度（当前高度 ≠ 我们上次设的）→ 一律不动，尊重他的尺寸；
 *   · 否则收到刚好装下面板的高度（换段数时不留空、也不裁掉）。 */
function resizeToContent(node) {
  if (node?.flags?.collapsed) return;
  if (typeof node.computeSize !== "function" || typeof node.setSize !== "function") return;
  try {
    const measured = node.computeSize();
    if (!Array.isArray(measured) || !Number.isFinite(Number(measured[1]))) return;
    const width = Math.max(PANEL_MIN_W, Number(node.size?.[0]) || 0, Number(measured[0]) || 0);
    const target = Math.max(1, Math.ceil(Number(measured[1])));
    const current = Number(node.size?.[1]) || 0;
    const ours = node.__dnPanelHeight;
    if (ours !== undefined && Math.abs(current - ours) > 2) return;   // 用户自己拉过 → 不插手
    if (Math.abs(current - target) <= 1) {
      node.__dnPanelHeight = current;
      return;
    }
    node.setSize([width, target]);
    node.__dnPanelHeight = target;
  } catch (error) {
    console.warn("[DN director] 调整节点高度失败（不影响功能）:", error);
  }
}

/* ================================================================
 * 8. 缓存状态轮询
 * ================================================================ */

async function pollCache(node) {
  const { list } = orderedSegments(node);
  const names = list.map((segment) => cacheNameFor(node, segment)).filter(Boolean);
  if (!names.length) {
    node.__dnCache = {};
    return;
  }
  try {
    const url = `/dn/selflift_cache_batch?names=${encodeURIComponent(names.join(","))}`;
    const res = await api.fetchApi(url);
    if (!res.ok) return;
    const data = await res.json();
    node.__dnCache = data?.items || {};
    node.__dnCacheDir = data?.cache_dir || node.__dnCacheDir;
  } catch (error) {
    /* 路由没起来 / 网络异常：面板照常显示，只是没有缓存数字 */
  }
}

/* ================================================================
 * 9. 队列调度（流水线）：跑完一段才自动提交下一段
 *    同一时刻只有 1 段在飞（排队 / 运行中），跑完自动提交下一段。
 * ================================================================ */

function clientId() {
  return api?.clientId || app?.canvas?.clientId || "dn-director";
}

async function postPrompt(prompt, workflow) {
  const body = { prompt, client_id: clientId() };
  if (workflow) body.extra_data = { extra_pnginfo: { workflow } };
  try {
    const res = await api.fetchApi("/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) return { error: data?.error || { message: `HTTP ${res.status}` }, nodeErrors: data?.node_errors };
    return data;
  } catch (error) {
    return { error: { message: String(error?.message || error) } };
  }
}

function setJob(node, key, patch) {
  node.__dnJobByKey = node.__dnJobByKey || new Map();
  node.__dnJobs = node.__dnJobs || [];
  const job = { key, ...(node.__dnJobByKey.get(key) || {}), ...patch };
  node.__dnJobByKey.set(key, job);
  // 数组与 Map 必须指向**同一个对象**：tickRun 是原地改 job.state 的，
  // 两处各存一份就会"地图变了、行上的字没变"。
  const at = node.__dnJobs.findIndex((item) => item.key === key);
  if (at >= 0) node.__dnJobs[at] = job;
  else node.__dnJobs.push(job);
  return job;
}

function errorText(data) {
  const first = data?.error;
  if (!first) return "";
  const nodeErrors = data.nodeErrors || {};
  const nodeId = Object.keys(nodeErrors)[0];
  if (nodeId) {
    const detail = nodeErrors[nodeId];
    const messages = (Array.isArray(detail) ? detail : detail?.errors) || [];
    const message = messages?.[0]?.message;
    if (message) return `${message}（节点 #${nodeId}）`;
  }
  return first.message || first.type || "提交失败";
}

/** 取当前面板顺序里、启用且无阻塞、从 position 开始的第一段。 */
function pickNext(node, position) {
  const { list } = orderedSegments(node);
  for (let i = position; i < list.length; i += 1) {
    const segment = list[i];
    if (isEnabled(node, segment.key) && !blockReason(node, segment)) return { segment, position: i };
  }
  return null;
}

/** 构造某一版的 prompt 快照（整图只取一次 base，逐段克隆改三处）。 */
async function buildSegmentPrompt(node, segment, base) {
  const prompt = deepClone(base);
  if (!prompt) return null;
  const entry = prompt[String(node.id)];
  if (!entry) return null;
  entry.inputs = entry.inputs || {};
  entry.inputs[INDEX_WIDGET] = segment.index;
  const cacheName = cacheNameFor(node, segment);
  const refine = isRefine(node, segment.key);
  for (const sampler of findSamplers(node)) {
    const samplerEntry = prompt[String(sampler.id)];
    if (!samplerEntry) continue;
    samplerEntry.inputs = samplerEntry.inputs || {};
    samplerEntry.inputs.run_refine = refine;
    if (cacheName) samplerEntry.inputs.cache_name = cacheName;
  }
  // 段标签（段k_一采/二采）：塞进 prompt 快照里任务台条目的隐藏键 TAG_KEY。
  // 后端节点开了 accept_all_inputs，未声明的键会原样送进 execute(**kwargs)，
  // tag 输出口就吐出它 —— **画布上不新增任何输入口、也完全不碰 SaveVideo**。
  // 你只需把任务台的 tag 输出连到 SaveVideo 的文件名前缀。
  entry.inputs[TAG_KEY] = segmentTag(node, segment);
  return prompt;
}

/** 流水线入口：把下一段排进队列，启动轮询。 */
async function startNext(node) {
  if (node.__dnSubmitting || !node.__dnRunning) return;
  const next = pickNext(node, node.__dnQueuePos || 0);
  if (!next) return finishRun(node);
  node.__dnSubmitting = true;
  try {
    const built = await app.graphToPrompt();
    const base = built?.output || built;
    if (!base) throw new Error("graphToPrompt 没给出 prompt");
    const prompt = await buildSegmentPrompt(node, next.segment, base);
    if (!prompt) {
      setJob(node, next.segment.key, { state: "error", text: "没进 prompt" });
      node.__dnQueuePos = next.position + 1;
      startNext(node);
      return;
    }
    const result = await postPrompt(prompt, built?.workflow);
    if (result?.error) {
      const text = errorText(result);
      setJob(node, next.segment.key, { state: "error", text: "提交失败", detail: text });
      node.__dnQueuePos = next.position + 1;
      startNext(node);
      return;
    }
    setJob(node, next.segment.key, { state: "queued", promptId: result.prompt_id, done: false, text: "排队中" });
    node.__dnQueuePos = next.position + 1;
    renderPanel(node, { force: true });
    setTimeout(() => tickRun(node), RUN_POLL_MS);
  } catch (error) {
    console.error("[DN director] 提交失败:", error);
  } finally {
    node.__dnSubmitting = false;
  }
}

/** 轮询队列 / 历史，把"排队中 / 运行中 / 完成 / 失败"写回行上；完成后自动提交下一段。 */
async function tickRun(node) {
  if (!node.__dnRunning) return;
  const jobs = (node.__dnJobs || []).filter((job) => job.promptId && !job.done);
  if (!jobs.length) {
    // 没有在飞的段了：如果还有下一段 → 提交；否则收工
    if (pickNext(node, node.__dnQueuePos || 0)) {
      startNext(node);
    } else {
      finishRun(node);
    }
    return;
  }
  let runningId = null;
  try {
    const res = await api.fetchApi("/queue");
    if (res.ok) {
      const data = await res.json();
      runningId = data?.queue_running?.[0]?.[1] ?? null;
    }
  } catch (error) { /* 队列查不到就先不标"运行中" */ }

  for (const job of jobs) {
    if (job.promptId === runningId) {
      job.state = "running";
      job.text = "运行中";
    } else if (job.state !== "running") {
      job.state = "queued";
      job.text = "排队中";
    }
    try {
      const res = await api.fetchApi(`/history/${job.promptId}`);
      if (!res.ok) continue;
      const data = await res.json();
      const entry = data?.[job.promptId];
      if (!entry) continue;
      const status = entry?.status || {};
      const ok = status.status_str !== "error" && status.completed !== false;
      job.done = true;
      job.state = ok ? "done" : "error";
      job.text = ok ? "完成" : "失败";
      if (!ok) {
        const messages = status.messages || [];
        const first = messages.find((item) => Array.isArray(item) && item[1]?.message);
        job.detail = first?.[1]?.message || "执行出错（详见 ComfyUI 控制台）";
        console.error("[DN director] 段执行失败，完整信息：", entry);
      }
    } catch (error) { /* 单次查询失败就下一轮再试 */ }
  }
  renderPanel(node, { force: true });

  // 还有在飞的段 → 继续轮询；否则自动提交下一段（或收工）
  if ((node.__dnJobs || []).some((job) => job.promptId && !job.done)) {
    setTimeout(() => tickRun(node), RUN_POLL_MS);
  } else {
    startNext(node);   // 内部 pickNext 返回 null 时自动 finishRun
  }
}

/** 流水线跑完（或没下一段）：收工。 */
function finishRun(node) {
  node.__dnRunning = false;
  node.__dnQueuePos = 0;
  renderPanel(node, { force: true });
}

/** 启动流水线。 */
async function runSelected(node) {
  const { list } = orderedSegments(node);
  if (!list.length) {
    console.warn("[DN director] 一段都没接：先把「资产卡镜头打包」的 group 接到左边的 group_1 / group_2 …");
    return;
  }
  if (node.__dnSubmitting || node.__dnRunning) return;
  const picked = list.filter((segment) => isEnabled(node, segment.key) && !blockReason(node, segment));
  if (!picked.length) {
    console.warn("[DN director] 勾上的段都是空的 / 都有问题，没有可提交的段。");
    return;
  }
  if (!findSamplers(node).length) {
    console.warn("[DN director] 下游没找到 SelfLift Sampler DN："
      + "本次仍按段提交（运行段照旧切换），但**逐段二采与缓存命名不会生效**。");
  }
  node.__dnJobByKey = new Map();
  node.__dnJobs = [];
  node.__dnQueuePos = 0;
  node.__dnRunning = true;
  renderPanel(node, { force: true });
  startNext(node);
}

/** 停：中断正在跑的那一段，并放弃还没提交的段。 */
async function stopRun(node) {
  const pending = (node.__dnJobs || []).filter((job) => job.promptId && !job.done);
  if (pending.length) {
    try {
      await api.fetchApi("/interrupt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch (error) {
      console.warn("[DN director] 中断请求失败:", error);
    }
    const ids = pending.map((job) => job.promptId);
    if (ids.length) {
      try {
        await api.fetchApi("/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ delete: ids }),
        });
      } catch (error) {
        console.warn("[DN director] 撤队列失败:", error);
      }
    }
    for (const job of pending) {
      job.done = true;
      job.state = "error";
      job.text = "已停";
    }
  }
  finishRun(node);
}

/* ================================================================
 * 10. 安装
 * ================================================================ */

/** 载入工作流期间**不许动分段口**：configure 逐节点跑，连线要等整图 configure 之后
 *  才注册 —— 载入中途按"已连线"收敛，会把还没注册上线的口当成空口删掉（不可逆）。 */
function releaseAfterLoad(node) {
  const release = () => {
    if (!node?.__dnLoading) return;
    node.__dnLoading = false;
    try {
      ensureSlots(node);
      renderPanel(node, { force: true });
    } catch (error) {
      console.warn("[DN director] 载入后对账失败（分段口保持工作流里的原样）:", error);
    }
  };
  setTimeout(release, 0);
  setTimeout(release, 300);   // 兜底：个别前端把整图 configure 拆到多个宏任务里
}

function setup(node) {
  if (!node || node.__dnSetup) return;
  node.__dnSetup = true;
  ensurePanel(node);
  if (!node.__dnLoading) {
    ensureSlots(node);
    renderPanel(node, { force: true });
  }
}

function installNode(nodeType, nodeData) {
  if (nodeData?.name !== NODE_CLASS) return;
  if (nodeType.prototype.__dnDirectorInstalled) return;
  nodeType.prototype.__dnDirectorInstalled = true;

  const originalCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function onNodeCreatedDnDirector() {
    const result = originalCreated?.apply(this, arguments);
    setup(this);
    // 控件/输入口可能稍后才挂全，多补两次
    requestAnimationFrame(() => setup(this));
    setTimeout(() => setup(this), 150);
    return result;
  };

  const originalConfigure = nodeType.prototype.configure;
  nodeType.prototype.configure = function configureDnDirector() {
    this.__dnLoading = true;
    const result = originalConfigure?.apply(this, arguments);
    releaseAfterLoad(this);
    return result;
  };

  const originalConfigureLoad = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function onConfigureDnDirector() {
    const result = originalConfigureLoad?.apply(this, arguments);
    const node = this;
    setTimeout(() => {
      try {
        setup(node);
      } catch (error) {
        console.warn("[DN director] 载入后初始化失败:", error);
      }
    }, 0);
    return result;
  };

  const originalConnections = nodeType.prototype.onConnectionsChange;
  nodeType.prototype.onConnectionsChange = function onConnectionsChangeDnDirector() {
    const result = originalConnections?.apply(this, arguments);
    if (!this.__dnLoading) {
      try {
        ensureSlots(this);
        renderPanel(this, { force: true });
      } catch (error) {
        console.warn("[DN director] 接线变化后对账失败:", error);
      }
    }
    return result;
  };
}

/** 轻扫描：上游改提示词 / 换卡 / 加删段这类"不碰本节点"的变化靠它跟上。
 *  稳态下只是重新读一遍几个控件，很便宜；页面切后台时整个跳过。 */
function scan() {
  if (typeof document !== "undefined" && document.hidden) return;
  for (const node of app.graph?._nodes || []) {
    if (!isOurNode(node)) continue;
    if (node.__dnLoading) continue;
    try {
      const slotsChanged = ensureSlots(node);
      renderPanel(node, slotsChanged ? { force: true } : undefined);
    } catch (error) {
      console.warn("[DN director] 扫描失败（下次再来）:", error);
    }
  }
}

/** 拖完一条线松手 → 多半是接线变了：立刻对一次账，不必等下一轮扫描。 */
function bindPointerTrigger() {
  if (extension.__pointerBound) return;
  const canvas = app.canvas?.canvas || app.canvasEl || null;
  if (!canvas || typeof canvas.addEventListener !== "function") return;
  extension.__pointerBound = true;
  canvas.addEventListener("pointerup", () => scan(), true);
}

const extension = {
  name: "DN.Nodes.Director",

  beforeRegisterNodeDef(nodeType, nodeData) {
    installNode(nodeType, nodeData);
  },

  setup() {
    if (extension.__setupDone) return;
    extension.__setupDone = true;
    setTimeout(() => scan(), 0);
    setTimeout(() => scan(), 800);
    setInterval(scan, SCAN_MS);
    // 缓存状态轮询（后端只 listdir + 读内存表，很轻）
    setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      for (const node of app.graph?._nodes || []) {
        if (!isOurNode(node)) continue;
        pollCache(node);
      }
    }, CACHE_MS);
    pollCacheKick();
    setTimeout(bindPointerTrigger, 0);
    setTimeout(bindPointerTrigger, 1500);
  },
};

function pollCacheKick() {
  for (const node of app.graph?._nodes || []) {
    if (isOurNode(node)) pollCache(node);
  }
}

function registerWhenAppReady() {
  let registered = false;
  const doRegister = (target) => {
    if (registered || !target || typeof target.registerExtension !== "function") return;
    registered = true;
    try {
      target.registerExtension(extension);
    } catch (error) {
      registered = false;
      console.warn("[DN director] 注册失败:", error);
      return;
    }
    const kick = () => {
      try {
        extension.setup();
      } catch (error) {
        console.warn("[DN director] 初始化失败:", error);
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
    import("../../../scripts/app.js")
      .then((mod) => doRegister(mod?.app ?? globalThis.app))
      .catch(() => {});
  } catch (error) { /* 落到下面的轮询 */ }
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
