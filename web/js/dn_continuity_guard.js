/**
 * DN 段间引导守卫（Director Continuity Guard）
 * ---------------------------------------------------------------
 * 背景：MiniMax H3 Director 的「引用上段」（per-segment continuityFromPrev）
 * 在外接组同步时会被静默清空。
 *
 * 上游 `web/js/minimax_timeline.js` 的 `syncExternalGroupsTimeline()` 在外接组
 * 数据变化（改 Group 参数 / 连线变化 / 打开工作流时的首次同步）时会用
 * `newBatchSegment({...})`（约 2386 行）和 `newFl2vShot({...})`（约 2298 行）
 * 重建每一段，但重建对象里只挑着继承了一部分字段，**漏了 continuityFromPrev**。
 *
 * 而前后端对这个字段的口径都是「没设 = 开着」：
 *   - 前端 `isSegmentContinuityFromPrev()`：字段缺失 → true
 *   - 后端 `resolve_segment_continuity_from_prev()`：字段缺失 → True
 * 于是用户手动关掉的开关，会在任何一次重建后自己变回「开」。
 *
 * 连带影响：下游的段指纹（`director/segment_cache.py` 里含 continuity_from_prev）
 * 随之变化 → 首采 / 二采缓存都被判失效 → 明明什么都没改也要重跑二采。
 *
 * 本扩展的对策（完全不动上游文件）：
 *   1. 包一层 `MiniMaxH3DirectorEditor.prototype.syncExternalGroupsTimeline`，
 *      调用前按段身份快照各自的 continuity 值，调用后把被清空的补回，
 *      并把结果重新写回 timeline widget（否则下次打开工作流又会丢）。
 *   2. 首次接管时做一次「抢救」：若编辑器已经在接管前跑过一轮同步（字段已被
 *      清空），就从 timeline_data（widget 里那份 JSON）把原值捞回来。
 *
 * 上游如果哪天自己修了（重建时继承该字段），这里的补回会变成 no-op，
 * 不会产生任何副作用 —— 可以放心留着，也可以随时删掉本文件。
 *
 * ⚠️ 注册时机：**不要**在模块顶层裸用全局 `app`。ComfyUI 是并行 import 所有
 *    扩展脚本的，小文件会先编译完先执行，那时 `window.app` 可能还没赋值，
 *    顶层 `app.registerExtension(...)` 会直接 ReferenceError（本文件实测踩过）。
 *    所以这里先显式 import core 的 app，拿不到再轮询等待。
 */

const CONTINUITY_KEYS = ["continuityFromPrev", "continuity_from_prev"];
const FIX_LOG_LIMIT = 5;
const LOG_MAX = 200;

/* 扫描节奏：平时慢扫；一旦发现新的 Director 编辑器就切密集档，
   抢在它首次外接组同步「debounce 写盘」之前把补丁挂上去。 */
const SCAN_IDLE_MS = 500;
const SCAN_DENSE_MS = 50;
const SCAN_DENSE_TICKS = 80;   // ≈4 秒

let fixTotal = 0;
let logCount = 0;

const log = (message) => {
    try {
        const box = (globalThis.__dnCgLog = globalThis.__dnCgLog || []);
        box.push(String(message));
        if (box.length > LOG_MAX) box.splice(0, box.length - LOG_MAX);
    } catch (error) {
        /* 记录失败无所谓 */
    }
    if (logCount >= FIX_LOG_LIMIT) return;
    logCount += 1;
    try {
        console.info(`[DN 段间引导守卫] ${message}`);
    } catch (error) {
        /* 控制台不可用就算了，这只是提示 */
    }
};

/* ------------------------------------------------------------------ *
 * 1. 段身份 / 快照 / 补回
 * ------------------------------------------------------------------ */

/** 读出这一段的 continuity 值；两种命名都认。没设过就返回 undefined。 */
function readContinuity(item) {
    if (!item || typeof item !== "object") return undefined;
    for (const key of CONTINUITY_KEYS) {
        const value = item[key];
        if (value !== undefined && value !== null) return value;
    }
    return undefined;
}

/**
 * 一段可以有几个身份键：外接组节点 id（重建时保留）+ 段自身 id。
 * 两个都登记，是因为 timeline_data（widget 里那份 payload）**不带**
 * externalNodeId，只带段 id —— 抢救时要靠 id 才认得出来。
 */
function itemKeys(item) {
    const keys = [];
    if (!item || typeof item !== "object") return keys;
    const external = item.externalNodeId;
    if (external !== undefined && external !== null && String(external) !== "") {
        keys.push(`n:${String(external)}`);
    }
    const id = item.id;
    if (id !== undefined && id !== null && String(id) !== "") keys.push(`i:${String(id)}`);
    return keys;
}

function snapshotList(list, into) {
    if (!Array.isArray(list)) return;
    for (const item of list) {
        const value = readContinuity(item);
        if (value === undefined) continue;   // 本来就没设过 → 别硬塞一个值进去
        for (const key of itemKeys(item)) {
            if (!into.has(key)) into.set(key, value);
        }
    }
}

function lookup(snap, item) {
    if (!snap || snap.size === 0) return undefined;
    for (const key of itemKeys(item)) {
        if (snap.has(key)) return snap.get(key);
    }
    return undefined;
}

/** 把快照里的值补回 list（快照优先，不管现在是什么）。返回补回处数。 */
function restoreList(list, snap) {
    if (!Array.isArray(list) || !snap || snap.size === 0) return 0;
    let fixed = 0;
    for (const item of list) {
        const found = lookup(snap, item);
        if (found === undefined) continue;
        if (readContinuity(item) === found) continue;   // 已经一致，不动
        item[CONTINUITY_KEYS[0]] = found;
        fixed += 1;
    }
    return fixed;
}

/**
 * 只在「内存里完全没有这个字段」时才补 —— 用于从 timeline_data 抢救。
 * 这样绝不会覆盖用户刚手动改过的值（那时字段是有值的）。
 */
function restoreMissing(list, snap) {
    if (!Array.isArray(list) || !snap || snap.size === 0) return 0;
    let fixed = 0;
    for (const item of list) {
        const found = lookup(snap, item);
        if (found === undefined) continue;
        if (readContinuity(item) !== undefined) continue;
        item[CONTINUITY_KEYS[0]] = found;
        fixed += 1;
    }
    return fixed;
}

/* ------------------------------------------------------------------ *
 * 2. 抢救：从 timeline_data 里把被清空的值捞回来
 * ------------------------------------------------------------------ */

function rescueFromWidget(editor) {
    const raw = editor?.timelineWidget?.value;
    if (typeof raw !== "string" || raw.length < 2) return 0;
    let data;
    try {
        data = JSON.parse(raw);
    } catch (error) {
        return 0;   // 不是合法 JSON 就不碰
    }
    if (!data || typeof data !== "object") return 0;

    const segSnap = new Map();
    const shotSnap = new Map();
    snapshotList(data.segments, segSnap);
    snapshotList(data.shots, shotSnap);

    const fixed = restoreMissing(editor?.timeline?.segments, segSnap)
        + restoreMissing(editor?.timeline?.shots, shotSnap);
    if (fixed > 0) {
        fixTotal += fixed;
        log(`从 timeline_data 抢救回 ${fixed} 处「引用上段」`);
        try {
            editor.flushTimelineSync?.();
        } catch (error) {
            /* 写回失败也无妨，内存里已经是正确的了 */
        }
    }
    return fixed;
}

/* ------------------------------------------------------------------ *
 * 3. 包一层 syncExternalGroupsTimeline
 * ------------------------------------------------------------------ */

function wrapSync(original) {
    const wrapped = function syncExternalGroupsTimelineGuarded(...args) {
        const editor = this;
        if (!editor || typeof editor !== "object") return original.apply(editor, args);
        // 重入保护：补回后我们会再写一次 timeline，别让它卷回自己
        if (editor.__dnCgBusy) return original.apply(editor, args);

        const segSnap = new Map();
        const shotSnap = new Map();
        try {
            snapshotList(editor.timeline?.segments, segSnap);
            snapshotList(editor.timeline?.shots, shotSnap);
        } catch (error) {
            /* 快照拿不到就原样放行，绝不因为守卫本身而打断同步 */
        }

        editor.__dnCgBusy = true;
        let result;
        try {
            result = original.apply(editor, args);
        } finally {
            editor.__dnCgBusy = false;
        }

        try {
            const fixed = restoreList(editor.timeline?.segments, segSnap)
                + restoreList(editor.timeline?.shots, shotSnap);
            if (fixed > 0) {
                fixTotal += fixed;
                log(`重建时被清空的「引用上段」已补回 ${fixed} 处`);
                // 必须落回 timeline widget：buildTimelinePayload 缺字段时会写出
                // true（default true when unset），不重写的话下次打开又会丢。
                if (typeof editor.flushTimelineSync === "function") {
                    editor.flushTimelineSync();
                } else {
                    editor.updateSegmentContinuityUI?.();
                    editor._writeTimelineWidget?.();
                }
            }
        } catch (error) {
            console.warn("[DN 段间引导守卫] 补回失败（不影响其它功能）:", error);
        }
        return result;
    };
    wrapped.__dnCgWrapped = true;
    wrapped.__dnCgOriginal = original;   // 留个把手：排错 / 对照实验时能换回原函数
    return wrapped;
}

/** 给原型打补丁；返回 true 表示"这个编辑器已受保护"。 */
function patchPrototype(proto) {
    if (!proto || typeof proto !== "object") return false;
    if (proto.__dnCgPatched) return true;
    const original = proto.syncExternalGroupsTimeline;
    if (typeof original !== "function") return false;
    if (original.__dnCgWrapped) {
        proto.__dnCgPatched = true;
        return true;
    }
    proto.syncExternalGroupsTimeline = wrapSync(original);
    proto.__dnCgPatched = true;
    log("已接管 syncExternalGroupsTimeline（原型级）");
    return true;
}

/* ------------------------------------------------------------------ *
 * 4. 找编辑器实例（编辑器是上游模块内部类，只能在实例出现后打补丁）
 * ------------------------------------------------------------------ */

function collectEditors() {
    const graph = globalThis.app?.graph;
    const nodes = graph?._nodes || graph?.nodes || [];
    const found = [];
    for (const node of nodes) {
        const editor = node?._minimaxEditor;
        if (editor) found.push(editor);
    }
    return found;
}

/** 扫一轮；返回本轮"新接管"的编辑器数量（>0 就说明该切密集档了）。 */
function scanOnce() {
    let freshly = 0;
    let editors = [];
    try {
        editors = collectEditors();
    } catch (error) {
        return 0;
    }
    for (const editor of editors) {
        if (editor.__dnCgReady) continue;
        let ok = patchPrototype(Object.getPrototypeOf(editor));
        if (!ok) {
            // 极端情况：方法挂在实例自身上
            const own = Object.getOwnPropertyDescriptor(editor, "syncExternalGroupsTimeline");
            if (own && typeof own.value === "function" && !own.value.__dnCgWrapped) {
                editor.syncExternalGroupsTimeline = wrapSync(own.value);
                ok = true;
            }
        }
        if (!ok) continue;
        editor.__dnCgReady = true;
        freshly += 1;
        try {
            rescueFromWidget(editor);
        } catch (error) {
            /* 抢救失败不影响主逻辑 */
        }
    }
    return freshly;
}

function installPatch() {
    let denseLeft = 0;
    const loop = () => {
        let freshly = 0;
        try {
            freshly = scanOnce();
        } catch (error) {
            /* 单轮失败不能让循环断掉 */
        }
        if (freshly > 0) denseLeft = SCAN_DENSE_TICKS;
        const wait = denseLeft > 0 ? SCAN_DENSE_MS : SCAN_IDLE_MS;
        if (denseLeft > 0) denseLeft -= 1;
        setTimeout(loop, wait);
    };
    loop();
}

/* ------------------------------------------------------------------ *
 * 5. 注册（这一步必须等 app 就绪，见文件顶部说明）
 * ------------------------------------------------------------------ */

function buildExtension() {
    return {
        name: "DN.DirectorContinuityGuard",
        setup() {
            if (globalThis.__dnContinuityGuardInstalled) return;
            globalThis.__dnContinuityGuardInstalled = true;
            installPatch();
            globalThis.__dnContinuityGuard = {
                version: "1.0.0",
                patched() {
                    try {
                        return collectEditors().some((editor) => editor.__dnCgReady);
                    } catch (error) {
                        return false;
                    }
                },
                fixed() {
                    return fixTotal;
                },
                logs() {
                    return (globalThis.__dnCgLog || []).slice();
                },
            };
        },
    };
}

function registerExtensionWhenReady() {
    const extension = buildExtension();
    let registered = false;

    const doRegister = (api) => {
        if (registered || !api || typeof api.registerExtension !== "function") return;
        registered = true;
        try {
            api.registerExtension(extension);
        } catch (error) {
            registered = false;
            console.warn("[DN 段间引导守卫] 注册失败:", error);
            return;
        }
        // 若注册时 app 已经过了 setup 阶段，ComfyUI 不会回头调用 setup —— 自己补。
        // setup 内部有幂等保护，重复调用无副作用。
        const kick = () => {
            try {
                extension.setup();
            } catch (error) {
                console.warn("[DN 段间引导守卫] 初始化失败:", error);
            }
        };
        setTimeout(kick, 0);
        setTimeout(kick, 1200);
    };

    if (globalThis.app?.registerExtension) {
        doRegister(globalThis.app);
        return;
    }

    // ① 显式依赖 core 的 app 模块：ESM 会等 core 求值完成，天然没有竞态
    try {
        import("../../scripts/app.js")
            .then((mod) => doRegister(mod?.app ?? globalThis.app))
            .catch(() => { /* 落到 ② */ });
    } catch (error) {
        /* 落到 ② */
    }

    // ② 兜底轮询：万一当前前端版本没有 /scripts/app.js
    let tries = 0;
    const timer = setInterval(() => {
        if (registered) {
            clearInterval(timer);
            return;
        }
        doRegister(globalThis.app);
        tries += 1;
        if (registered || tries > 1200) clearInterval(timer);   // 约 20 秒后退场
    }, 16);
}

registerExtensionWhenReady();
