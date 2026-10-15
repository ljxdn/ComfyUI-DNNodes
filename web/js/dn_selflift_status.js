/**
 * SelfLift Sampler DN（DNSSelfLiftH3）前端
 * ---------------------------------------------------------------------------
 * 三件事：
 *
 * 1) 「高级选项」折叠 —— 两种模式都生效
 *    ComfyUI 后端那个 `"advanced": True` 标记，只有 Nodes 2.0（Vue 节点）才会渲染出
 *    展开按钮；普通（litegraph canvas）模式**什么都不显示**，参数直接被藏死。
 *    用户实测反馈后改成自实现：
 *      后端加一个 BOOLEAN 开关 advanced（显示名「高级选项」）
 *      本 JS 负责把下方那些很少用到的参数藏起来 / 放出来
 *    按钮名固定叫「高级选项」，普通模式与 Nodes 2.0 表现一致。
 *
 *    ⚠️ 只折叠**右侧可设置控件**；左侧接线口（model / positive / negative / vae /
 *    latent_image / sampler / sigmas / model_hires）一个都不动 —— 折叠输入口会让
 *    用户没法连线，这条是硬要求。
 *
 * 2) seed 的「生成后控制」默认值改成 fixed（只对**新建**节点生效；
 *    载入已有工作流时保留用户存下来的选择，不覆盖）。
 *
 * 3) 节点最下方一条状态条，显示一采缓存的命中 / 保存状态。
 *    ⚠️ 不依赖任何前端事件 API（onExecuted / app.on / K.addEventListener）——
 *       新版 litegraph 个别构建上事件回调不被调用、payload 结构不一致。
 *    改成**前端主动查后端**：
 *       后端 selflift_cache.py 在 sample() 末尾 record_status(cache_name, text)
 *       写进内存表，并注册 GET /dn/selflift_status?cache_name=xxx。
 *       前端每 2s 轮询一次 fetch 该路由，把 status 写进 node._last_status；
 *       statusText() 优先取 _last_status（后端最近一次真实状态），
 *       没有时按 cache_name 控件 + 二采开关给默认提示。
 *    这条路径**不依赖前端版本、不依赖事件转发**，经典 / Nodes 2.0 都能通。
 *
 * 说明：文件名叫 dn_selflift_status.js 是历史原因，现在它同时管折叠和状态条。
 */

import { app } from "../../../scripts/app.js";

const NODE_CLASS = "DNSSelfLiftH3";
const TOGGLE_WIDGET = "advanced";
const TOGGLE_TEXT = "高级选项";
const STATUS_WIDGET = "dn_selflift_status";
const STATUS_COLOR = "#c9a86a";

/** 默认折叠、点「高级选项」才出来的参数（全部是右侧控件，没有一个是接线口）。 */
const ADVANCED_WIDGETS = [
  "cfg",
  "rho",
  "w_min",
  "w_max",
  "upscaler_chunking",
  "highres_tiling",
  "upscaler_unload",
];

/* ------------------------------------------------------------------ 小工具 */

function isOurNode(node) {
  return Boolean(node) && (node.comfyClass === NODE_CLASS || node.type === NODE_CLASS);
}

function getWidget(node, name) {
  return node?.widgets?.find((w) => w?.name === name) || null;
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["", "0", "false", "off", "no"].includes(v)) return false;
    if (["1", "true", "on", "yes"].includes(v)) return true;
  }
  return value == null ? fallback : Boolean(value);
}

function isVueNodesMode() {
  return Boolean(globalThis.LiteGraph?.vueNodesMode);
}

/** 同时改 widget.options 与 Vue 那侧的 _state.options（少改一处 Vue 就不认）。 */
function setWidgetOption(widget, key, value) {
  if (!widget) return;
  widget.options = widget.options || {};
  if (value === undefined) delete widget.options[key];
  else widget.options[key] = value;
  if (widget._state?.options) {
    if (value === undefined) delete widget._state.options[key];
    else widget._state.options[key] = value;
  }
}

/* ------------------------------------------------- 控件显隐（两个模式都认） */

function hideWidget(widget) {
  if (!widget) return false;
  // 已经藏过（type=hidden + 折叠高度）就直接返回，避免每次刷新都改高度
  let compact = false;
  try {
    const measured = widget.computeSize?.();
    compact = Number(measured?.[0]) === 0 && Number(measured?.[1]) === -4;
  } catch { /* 控件还没量过尺寸 */ }
  const wasVisible = widget.hidden !== true || widget.type !== "hidden" || !compact;
  if (!wasVisible) return false;

  if (widget.type !== "hidden") widget.__dnOrigType = widget.type;
  if (!Object.prototype.hasOwnProperty.call(widget, "__dnOrigComputeSize")) {
    widget.__dnOrigComputeSize = widget.computeSize;
    widget.__dnHadComputeSize = Object.prototype.hasOwnProperty.call(widget, "computeSize");
    widget.__dnOrigHidden = widget.hidden;
    widget.__dnOrigOptionsHidden = widget.options?.hidden;
  }
  widget.hidden = true;
  if (widget.inputEl) widget.inputEl.style.display = "none";
  if (widget.element) widget.element.style.display = "none";
  widget.type = "hidden";
  widget.computeSize = () => [0, -4];   // -4：ComfyUI 对隐藏行仍会算 4px
  setWidgetOption(widget, "hidden", true);
  if (widget._state) {
    widget._state.hidden = true;
    widget._state.type = "hidden";
  }
  return true;
}

function showWidget(widget) {
  if (!widget) return false;
  const wasHidden = widget.type === "hidden"
    || widget.hidden === true
    || widget.options?.hidden === true
    || widget._state?.type === "hidden"
    || widget._state?.hidden === true;
  if (!wasHidden) return false;

  widget.hidden = widget.__dnOrigHidden ?? false;
  if (widget.inputEl) widget.inputEl.style.display = "";
  if (widget.element) widget.element.style.display = "";
  if (widget.type === "hidden") widget.type = widget.__dnOrigType || "combo";
  if (widget.__dnHadComputeSize) widget.computeSize = widget.__dnOrigComputeSize;
  else delete widget.computeSize;
  setWidgetOption(widget, "hidden", false);
  if (widget._state) {
    widget._state.hidden = widget.hidden;
    widget._state.type = widget.type;
  }
  return true;
}

/** Vue 节点模式：把 widgets 摘空再放回，逼前端重排一次（否则改了 type 不重绘）。 */
function refreshVueNodeWidgets(node) {
  if (!isVueNodesMode() || !Array.isArray(node?.widgets)) return;
  const widgets = [...node.widgets];
  try {
    node.widgets = [];
    node.widgets = widgets;
  } catch { /* 某些版本 widgets 是只读字段 */ }
}

/** 折叠/展开后把节点高度收一下（用 computeSize 重算，不会来回漂）。
 *  仅 syncAdvanced 手动触发；状态条/轮询绝不调用它，避免反复改尺寸把节点崩掉。 */
function relayout(node) {
  try {
    const size = node.computeSize?.();
    const width = Number(node.size?.[0]) || Number(size?.[0]) || 260;
    if (Array.isArray(size) && Number.isFinite(size[1])) {
      node.setSize?.([width, size[1]]);
    }
  } catch { /* 布局失败不影响功能 */ }
  refreshVueNodeWidgets(node);
  node.setDirtyCanvas?.(true, true);
  app.graph?.setDirtyCanvas?.(true, true);
}

/* ------------------------------------------------------------ 高级选项折叠 */

function syncAdvanced(node, { adjust = true } = {}) {
  const toggle = getWidget(node, TOGGLE_WIDGET);
  const expanded = asBoolean(toggle?.value, false);
  let changed = false;
  for (const name of ADVANCED_WIDGETS) {
    const widget = getWidget(node, name);
    if (!widget) continue;
    changed = (expanded ? showWidget(widget) : hideWidget(widget)) || changed;
  }
  if (toggle) toggle.label = expanded ? `${TOGGLE_TEXT} ▲` : `${TOGGLE_TEXT} ▼`;
  node.__dnAdvExpanded = expanded;
  if (changed && adjust) relayout(node);
}

function setupAdvanced(node) {
  const toggle = getWidget(node, TOGGLE_WIDGET);
  if (!toggle) return;
  if (!toggle.__dnWrapped) {
    const original = toggle.callback;
    toggle.callback = function () {
      const result = typeof original === "function" ? original.apply(this, arguments) : undefined;
      syncAdvanced(node);
      return result;
    };
    toggle.__dnWrapped = true;
  }
  // 首次同步要收高度：节点是按「全部参数都显示」算出来的尺寸建的，
  // 藏掉 9 行后不收一下，底部会留一大块空白。
  syncAdvanced(node, { adjust: true });
}

/* ---------------------------------------------------- seed 生成后控制 = fixed */

function applySeedControlDefault(node) {
  const widget = node?.widgets?.find((w) =>
    String(w?.name || "").includes("control_after_generate"));
  if (!widget) return;
  // 只对新建节点生效：载入工作流时 widgets_values 有值，保留用户存下的选择
  const fresh = !Array.isArray(node.widgets_values) || node.widgets_values.length === 0;
  if (!fresh) return;
  if (widget.value !== "fixed") {
    widget.value = "fixed";
    if (widget._state) widget._state.value = "fixed";
  }
}

/* ------------------------------------------------------------ 底部状态条 */

function statusText(node) {
  const cacheName = getWidget(node, "cache_name")?.value;
  const refine = asBoolean(getWidget(node, "run_refine")?.value, true);
  const known = node.__dnKnownCacheCount || 0;

  // ① 最近一次执行状态（跑完才有；参数变了会追加提示）
  if (node._last_status) {
    let text = node._last_status;
    if (node.__dnStale) text += " · 参数已变（下次执行刷新）";
    return text;
  }

  // ② 没跑过：按 目录文件数 + 二采开关 给预提示
  if (!cacheName) {
    return refine ? "未设缓存命名 · 一采 + 二采" : "未设缓存命名 · 只跑一采";
  }

  if (known > 0) {
    const files = known === 1 ? "1 份" : known + " 份";
    const hit = refine ? " · 跳过一采" : " · 直接输出一采 latent";
    return `「${cacheName}」已有 ${files}缓存${hit}`;
  }

  // 没缓存文件：等待跑一采
  return refine
    ? `「${cacheName}」无缓存 · 等待运行（命中则跳过一采）`
    : `「${cacheName}」无缓存 · 等待运行（只跑一采并存盘）`;
}

function ensureStatusWidget(node) {
  // 已经挂过 DOM：补一次 z-index / position（某些前端主题会把节点内 DOM 盖住）
  if (node.__dnStatusEl) {
    const el = node.__dnStatusEl;
    el.style.position = "relative";
    el.style.zIndex = "10";
    el.style.display = "block";
    refreshStatus(node);
    return;
  }
  if (typeof node.addDOMWidget !== "function") return;
  const el = document.createElement("div");
  // 固定单行 28px、超出省略号。绝不量 scrollHeight / 改 el.width ——
  // 那些量高度又改宽度的操作会跟节点尺寸互相触发，把节点越撑越崩。
  el.style.cssText = [
    "box-sizing:border-box",
    "width:100%",
    "min-width:240px",
    "height:22px",
    "padding:2px 8px",
    "font-size:11px",
    "line-height:18px",
    "text-align:center",
    "color:#ffd54a",
    "background:#000",
    "border:1px solid rgba(255,213,74,0.45)",
    "border-radius:3px",
    "position:relative",
    "z-index:10",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "white-space:nowrap",
    "user-select:none",
  ].join(";");
  const widget = node.addDOMWidget(STATUS_WIDGET, "dn_state", el, {
    serialize: false,
    hideOnZoom: false,
  });
  if (!widget) return;
  // 固定返回 [width, 28]：只占一条 28px 的位，不碰节点本身尺寸
  widget.computeSize = (width) => [width || 0, 28];
  widget.serializeValue = () => undefined;
  node.__dnStatusEl = el;
  node.__dnStatusWidget = widget;
  refreshStatus(node);
}

function refreshStatus(node) {
  if (!node.__dnStatusEl) return;
  const text = statusText(node);
  const el = node.__dnStatusEl;
  if (el.textContent !== text) {
    el.textContent = text;
    el.title = text;
  }
}

/* --------------------------------------------------- 后端状态查询（HTTP） */

/** 参数变化检测：读当前节点的"影响缓存"参数，拼一个签名串；变了就要求再查一次后端。 */
function paramSignature(node) {
  const fields = ["cache_name", "run_refine", "seed", "transition_step",
                 "lowres_scale", "cfg"];
  const parts = fields.map((name) => {
    const w = getWidget(node, name);
    const v = w?.value;
    return name + "=" + (v == null ? "" : String(v));
  });
  return parts.join("|");
}

/** 查后端最近一次执行的状态 + 该 cache_name 下已有多少份缓存文件。
 *  两个请求都走 /dn/selflift_*（后端 selflift_cache.py 注册的轻量路由，只读内存表/
 *  数文件名，不读 GPU、不烧时间）。每 2s 轮询一次，参数一变立即重查。 */
async function pollBackendStatus(node) {
  const cacheName = getWidget(node, "cache_name")?.value;

  // 无命名：直接清掉，不查
  if (!cacheName) {
    node._last_status = "";
    node.__dnStale = false;
    node.__dnKnownCacheCount = 0;
    ensureStatusWidget(node);
    refreshStatus(node);
    return;
  }

  // 最近一次执行的状态（按 cache_name 归档；不同参数配置会对应不同缓存文件，
  // 后端在 sample() 末尾 record_status，查这条不烧时间）
  try {
    const url = "/dn/selflift_status?cache_name=" + encodeURIComponent(String(cacheName));
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      const s = (data && typeof data.status === "string") ? data.status : "";
      if (s !== node._last_status) {
        node._last_status = s;
        // 刚拿到状态 → 不算"参数已变"（这次执行本身就是最新的）
        node.__dnStale = false;
      }
    }
  } catch { /* 路由未注册 / 网络异常：忽略 */ }

  // 该 cache_name 下有多少份缓存文件（数文件名，不读内容）
  try {
    const listUrl = "/dn/selflift_cache?cache_name=" + encodeURIComponent(String(cacheName));
    const res = await fetch(listUrl, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      node.__dnKnownCacheCount = Array.isArray(data?.fingerprints)
        ? data.fingerprints.length : 0;
    } else {
      node.__dnKnownCacheCount = 0;
    }
  } catch { node.__dnKnownCacheCount = 0; }

  // 参数变了立刻再查一次（不等下一轮轮询），状态条 <200ms 内更新
  const sig = paramSignature(node);
  if (sig !== node.__dnParamSig) {
    node.__dnParamSig = sig;
    node.__dnStale = Boolean(node._last_status);
    // 再查一次目录文件数 + 最近状态（立刻刷新，不靠 2s 轮询兜底）
    await refreshFromBackend(node, cacheName);
  }

  ensureStatusWidget(node);
  refreshStatus(node);
}

/** 纯查后端（不碰参数签名）；参数变化时由 pollBackendStatus 直接调。 */
async function refreshFromBackend(node, cacheName) {
  if (!cacheName) {
    node._last_status = "";
    node.__dnStale = false;
    node.__dnKnownCacheCount = 0;
    return;
  }
  try {
    const url = "/dn/selflift_status?cache_name=" + encodeURIComponent(String(cacheName));
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      const s = (data && typeof data.status === "string") ? data.status : "";
      if (s !== node._last_status) {
        node._last_status = s;
        node.__dnStale = false;
      }
    }
  } catch { /* 路由未注册 / 网络异常：忽略 */ }
  try {
    const listUrl = "/dn/selflift_cache?cache_name=" + encodeURIComponent(String(cacheName));
    const res = await fetch(listUrl, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      node.__dnKnownCacheCount = Array.isArray(data?.fingerprints)
        ? data.fingerprints.length : 0;
    } else {
      node.__dnKnownCacheCount = 0;
    }
  } catch { node.__dnKnownCacheCount = 0; }
}

function bootNode(node) {
  try {
    ensureStatusWidget(node);
    setupAdvanced(node);
    applySeedControlDefault(node);
    refreshStatus(node);
  } catch (err) {
    console.warn("[DN.SelfLiftH3] 前端初始化失败", err);
  }
}

app.registerExtension({
  name: "DN.SelfLiftH3.UI",

  setup() {
    // 轮询：每 2s 一次。两个目的：
    //   ① 把「跑完节点后」的状态从后端查回来（不依赖事件 API，任何前端版本都通）
    //   ② 折叠状态漂了（切工作流 tab / 前端重建控件）顺手纠正
    // 节点空闲时 fetch 很轻（后端直接读内存表，无 IO）。
    setInterval(() => {
      const nodes = app.graph?._nodes || app.canvas?.graph?._nodes || [];
      for (const node of nodes) {
        if (!isOurNode(node)) continue;
        pollBackendStatus(node);
        const toggle = getWidget(node, TOGGLE_WIDGET);
        if (toggle && asBoolean(toggle.value, false) !== node.__dnAdvExpanded) {
          syncAdvanced(node);
        }
        if (node.__dnStatusEl && node.__dnStatusEl.textContent !== statusText(node)) {
          refreshStatus(node);
        }
      }
    }, 500);
  },

  nodeCreated(node) {
    if (!isOurNode(node)) return;
    bootNode(node);
    // 控件（尤其 seed 的「生成后控制」）可能稍后才挂上，多补两次
    requestAnimationFrame(() => bootNode(node));
    setTimeout(() => bootNode(node), 120);
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS && nodeType?.comfyClass !== NODE_CLASS) return;

    // 节点配置载入：按存下来的「高级选项」值恢复折叠 + 建状态条 + 查一次后端状态
    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = originalConfigure?.apply(this, arguments);
      const node = this;
      setTimeout(() => {
        try {
          ensureStatusWidget(node);
          setupAdvanced(node);
          refreshStatus(node);
          pollBackendStatus(node);
        } catch (err) {
          console.warn("[DN.SelfLiftH3] 载入后初始化失败", err);
        }
      }, 0);
      return result;
    };
  },
});
