"""DN 节点：SelfLift Sampler DN（MiniMax H3 渐进采样 + 一采缓存）。

兄弟包 comfyui-SelfLift 的原节点把「低分辨率前缀 → 提升 → 全分辨率收尾」写死在
一次函数调用里，没法「只跑前缀、存盘、回头再收尾」。本节点把这两半拆开：

- 一采 run_lowres  ：低分辨率前缀 N 步（transition_step），产出低分辨率状态。
- 二采 run_highres ：提升（SelfLift-zero / 外部 upscaler）+ 全分辨率收尾。
- 中间用缓存文件接上（<输出目录>/selflift_cache/<缓存命名>__<指纹>.pt）。

行为契约（用户口径）：
- 二采开关 = 关：跑一采 → 有缓存命名就存盘 → 输出（低分辨率前缀的）latent。
- 二采开关 = 开：命中缓存 → 读缓存 → 只跑二采 → 输出 latent。
- 二采开关 = 开 + 未命中：跑一采（存盘）→ 接着跑二采 → 输出 latent。

⚠️ 两段引擎是 comfyui-SelfLift/nodes.py 里 `progressive_sample` 在本文件标注的
「接缝」处的**忠实拆分**（对齐 2026-09-24 那版 nodes.py）。接缝 = 原函数中
`low_timer.finish()` 那一行：上一行是低分辨率采样，下一行开始进入提升。
上游算法若更新，把改动照抄进 run_lowres / run_highres 这两个函数即可，
接缝位置不变；纯工具函数（_streams/_pack/_euler_step/_validate_*/_resize_keyframes/
_mask_blend_fn/_debug_dump）直接从兄弟包 import，不复制。

⚠️ 包加载期零副作用：顶层不 import torch / comfy.* / 引擎子模块，全部惰性到
首次真正跑节点时才加载——否则在 SimpAI 的 PyInstaller 打包环境里包加载就炸，
节点注册不进去（用户搜不到节点）。

界面约定（前端 web/js/dn_selflift_status.js 配合）：
- 「高级选项」是个 BOOLEAN 控件，默认收起；收起时把 cfg / rho / w_min / w_max /
  时间分块放大 / 高分辨率分块 / 放大后卸载 这些很少用的参数藏起来。不用后端
  `"advanced": True`：那个标记只在 Nodes 2.0 显示展开按钮，普通 litegraph 模式
  什么都不显示、参数被藏死。前端自实现两种模式都生效。**只折叠右侧控件，
  左侧接线口一个都不动（折叠接线口会让人没法连线）。**
- 节点最底部一条状态条，显示一采缓存命中 / 保存状态；后端把状态放进
  `{"ui": {"dn_selflift_status": [...]}}`，前端 onExecuted 取出来显示。

节点 id DNSSelfLiftH3，显示名 SelfLift Sampler DN，分类「DN Nodes」。
"""

from __future__ import annotations

import hashlib
import logging
import os
import sys

_CATEGORY = "DN Nodes"

#: 缓存目录（默认落在 ComfyUI 的输出目录下，跟导演台的 minimax_seg_cache 一个路子），
#: 可用环境变量 DN_SELFLIFT_CACHE_DIR 覆盖。
_CACHE_SUBDIR = "selflift_cache"


def _cache_dir() -> str:
    override = os.environ.get("DN_SELFLIFT_CACHE_DIR")
    if override:
        return override
    try:
        import folder_paths
        return os.path.join(folder_paths.get_output_directory(), _CACHE_SUBDIR)
    except Exception:
        # 兜底：<本包>/../../users/ComfyUI/selflift_cache
        return os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
            "users", "ComfyUI", _CACHE_SUBDIR)


def _sanitize_name(name: str, fallback: str = "selflift") -> str:
    name = (name or "").strip()
    if not name:
        return fallback
    safe = "".join(ch for ch in name if ch.isascii() and (ch.isalnum() or ch in "._-"))
    safe = safe.strip("._-")[:64]
    return safe or fallback


def _cache_key_fingerprint(seed, transition_step, lowres_scale, cfg, latent_image) -> str:
    """一采缓存指纹：只算「稳定且会影响一采结果」的量。

    - 含 latent 形状：换了分辨率 / 时长就对不上，必须重跑一采。
    - 不含 upscaler_model / highres_tiling / rho：那些只在二采起作用，
      换它们不该让一采缓存失效。
    - **不含提示词**：cond 是浮点张量，拿哈希去区分有「每次都不命中」的风险
      （编码器 / 归约差异 → 指纹每次都变），那会让缓存退化成「每跑一次都白跑
      一采」，比复用更糟。换提示词复用旧一采时，状态条会明确写「跳过一采」，
      不算静默；要隔离就改「缓存命名」。
    """
    raw = (f"{seed}|{transition_step}|{lowres_scale}|{cfg}|"
           f"{_latent_shape_signature(latent_image)}")
    return hashlib.md5(raw.encode("utf-8")).hexdigest()[:12]


def _latent_shape_signature(latent_image) -> str:
    try:
        samples = latent_image["samples"]
        if getattr(samples, "is_nested", False):
            return "|".join(str(tuple(s.shape)) for s in samples.unbind())
        return str(tuple(samples.shape))
    except Exception:
        return "?"


def _cache_path(name: str, fingerprint: str) -> str:
    return os.path.join(_cache_dir(), f"{name}__{fingerprint}.pt")


def _save_cache(path: str, blob: dict) -> None:
    import torch
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = {
        "version": 1,
        "nested": bool(blob["nested"]),
        "state": [t.detach().to("cpu").contiguous() for t in blob["state"]],
        "x0": [t.detach().to("cpu").contiguous() for t in blob["x0"]],
    }
    torch.save(payload, path)
    logging.info("[DNSSelfLiftH3] 一采缓存已写入 %s", path)


def _load_cache(path: str) -> dict:
    import torch
    try:
        payload = torch.load(path, map_location="cpu", weights_only=True)
    except Exception:
        payload = torch.load(path, map_location="cpu", weights_only=False)
    if not isinstance(payload, dict) or "state" not in payload or "x0" not in payload:
        raise ValueError(f"DNSSelfLiftH3: 缓存文件格式不对，删掉重跑一采：{path}")
    logging.info("[DNSSelfLiftH3] 读到一采缓存 %s", path)
    return {
        "state": list(payload["state"]),
        "x0": list(payload["x0"]),
        "nested": bool(payload.get("nested", False)),
    }


# ---------------------------------------------------------------------------
# 惰性引擎加载
#
# comfyui-SelfLift 的子模块（h3_upscaler.py / nodes.py / selflift.py）内部用了
# 相对导入（如 `from .diagnostics import log_memory`）。必须把兄弟包目录作为一个
# 「包」挂进 sys.path 再按包成员导入，相对导入才能解析。目录名带连字符没法写
# import 语句，但 importlib.import_module("comfyui-SelfLift") 按字符串名导入可以。
# ---------------------------------------------------------------------------

_SIBLING_PKG = "comfyui-SelfLift"
_SIBLING_PKG_ROOT = None


def _sibling_base() -> str:
    """兄弟包 comfyui-SelfLift 所在目录（= custom_nodes/）。"""
    global _SIBLING_PKG_ROOT
    if _SIBLING_PKG_ROOT is None:
        # 本文件：<comfy>/custom_nodes/ComfyUI-DNNodes/selflift_cache.py
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if not os.path.isdir(os.path.join(base, _SIBLING_PKG)):
            for entry in list(sys.path):
                try:
                    if entry and os.path.isdir(os.path.join(entry, _SIBLING_PKG)):
                        base = entry
                        break
                except OSError:
                    continue
        _SIBLING_PKG_ROOT = base
    return _SIBLING_PKG_ROOT


def _ensure_pkg() -> None:
    if _SIBLING_PKG in sys.modules:
        return
    base = _sibling_base()
    if base not in sys.path:
        sys.path.insert(0, base)
    import importlib
    importlib.import_module(_SIBLING_PKG)


def _load_sibling(name: str):
    """按包成员方式加载 comfyui-SelfLift 的子模块（相对导入可正常解析）。"""
    _ensure_pkg()
    import importlib
    full = f"{_SIBLING_PKG}.{name}"
    if full in sys.modules:
        return sys.modules[full]
    return importlib.import_module(full)


def _engine():
    """兄弟包 nodes 模块（提供 progressive_sample 与那些私有工具函数）。"""
    return _load_sibling("nodes")


def _comfy_mod(name: str):
    import importlib
    return importlib.import_module(f"comfy.{name}") if name else importlib.import_module("comfy")


# ---------------------------------------------------------------------------
# 提升器：把低分辨率干净 latent 提到目标分辨率
#
# 设备与精度沿用兄弟包 learned_latent_lift 的原生行为（当前加速器 + 权重原生精度），
# 只多给一个「时间分块放大」开关：兄弟包 forward 的 enable_chunking 恒为 True 且
# 外部改不了，长片（时间维 > 32）会自动按 T 维分块 + 重叠融合。
# 注意这是「时间」分块，切 latent 时间维；与节点的「高分辨率分块」
# (highres_tiling，切 H/W 空间维) 是两回事。
# ---------------------------------------------------------------------------


def _learned_lift(z0_low, out_hw, model_name, chunking, force_unload):
    import torch
    import comfy.model_management

    ups = _load_sibling("h3_upscaler")
    H, W = out_hw
    device = comfy.model_management.get_torch_device()
    h, w = z0_low.shape[-2], z0_low.shape[-1]
    scale = (H / h + W / w) / 2.0

    patcher = ups._load_model(model_name, device)
    model = patcher.model
    memory_required = ups._inference_memory_required(model, z0_low, (H, W))
    chunk, overlap = model.temporal_chunk_settings()
    if not chunking:
        # 关掉时间分块时真实时间窗口 = 全长，按比例把显存估算放大
        # （兄弟包的估算按分块窗口算，关分块会低估 → 容易 OOM）
        budget = model.temporal_window_budget(z0_low.shape[2])
        if budget > 0 and z0_low.shape[2] > budget:
            memory_required *= z0_low.shape[2] / budget
    logging.info("[DNSSelfLiftH3 upscaler] 提升 %s -> %s | device=%s dtype=%s "
                 "时间分块=%s (chunk=%d overlap=%d, 时间帧数=%d) 估算显存=%.2f MiB",
                 tuple(z0_low.shape), (H, W), device, model.conv_in.weight.dtype,
                 "开" if chunking else "关", chunk, overlap, z0_low.shape[2],
                 memory_required / 2**20)
    try:
        comfy.model_management.load_models_gpu([patcher], memory_required=memory_required)
        dtype = model.conv_in.weight.dtype
        mean = torch.tensor(ups.LATENTS_MEAN, dtype=dtype, device=device).view(1, -1, 1, 1, 1)
        std = torch.tensor(ups.LATENTS_STD, dtype=dtype, device=device).view(1, -1, 1, 1, 1)
        x = z0_low.to(device=device, dtype=dtype)
        with torch.no_grad():
            x = (x - mean) / std
            out = model(x, scale=scale, target_size=(z0_low.shape[2], H, W),
                        enable_chunking=bool(chunking))
            out = (out * std + mean).float().to(
                comfy.model_management.intermediate_device())
        return out
    finally:
        if force_unload:
            comfy.model_management.unload_model_and_clones(
                patcher, unload_additional_models=False)
            comfy.model_management.soft_empty_cache()


def _lifter(upscaler_model, upscaler_unload, upscaler_chunking=True):
    if upscaler_model == "none":
        return None
    return (lambda z, hw: _learned_lift(z, hw, upscaler_model, upscaler_chunking,
                                        upscaler_unload))


# ---------------------------------------------------------------------------
# 接缝：以下两个函数 = 兄弟包 progressive_sample 的前半段 / 后半段
# ---------------------------------------------------------------------------


def _plan(model, latent_image, lowres_scale, highres_tiling, model_hires,
          build_high_model: bool):
    """两段共用的准备工作（形状 / 低分辨率尺寸 / 锚点 / 掩码），照搬原函数前半段。"""
    import torch
    import comfy.sample
    import comfy.model_management

    sl = _engine()
    h3_tiling = _load_sibling("h3_tiling")

    streams, nested = sl._streams(comfy.sample.fix_empty_latent_channels(
        model, latent_image["samples"], latent_image.get("downscale_ratio_spacial", None),
        latent_image.get("downscale_ratio_temporal", None)))
    high_model = None
    if build_high_model:
        hires_base = model_hires if model_hires is not None else model
        high_model = (h3_tiling.tiled_model(hires_base, [tuple(s.shape) for s in streams])
                      if highres_tiling else hires_base)
    shapes = [tuple(s.shape) for s in streams]

    video = streams[0].ndim == 5
    if video:
        b, c, t, H, W = streams[0].shape
    else:
        b, c, H, W = streams[0].shape
        t = None
    h = max(2, round(H * lowres_scale / 2) * 2)
    w = max(2, round(W * lowres_scale / 2) * 2)
    device = comfy.model_management.intermediate_device()
    source_video = streams[0].to(device)
    audio_streams = [s.to(device) for s in streams[1:]]
    del streams

    # noise_mask 只影响掩码区域；形状规则与原函数逐字一致
    noise_mask = sl._validate_latent_input(latent_image)
    m_full = m_low = None
    if noise_mask is not None:
        if video and noise_mask.shape[2] == 1 and t > 1:
            m_full = noise_mask.expand(b, 1, t, H, W)
        else:
            m_full = noise_mask
        if video:
            m_low = torch.nn.functional.interpolate(
                m_full.reshape(b * t, 1, H, W).float(), size=(h, w), mode="bilinear",
                align_corners=False).reshape(b, 1, t, h, w)
        else:
            m_low = torch.nn.functional.interpolate(
                m_full.float(), size=(h, w), mode="bilinear", align_corners=False)
        m_low = m_low.clamp(0.0, 1.0)

    return {
        "shapes": shapes, "nested": nested, "video": video,
        "b": b, "c": c, "t": t, "H": H, "W": W, "h": h, "w": w, "device": device,
        "source_video": source_video, "audio_streams": audio_streams,
        "m_full": m_full, "m_low": m_low, "high_model": high_model,
    }


def _masked_model(base, video_anchor, m, nested, audio_streams, b, c):
    """原函数里 masked_model 闭包的照搬版（m 为 None 时原样返回 base）。"""
    if m is None:
        return base
    import torch
    import comfy.model_patcher

    sl = _engine()
    patched = base.clone()
    if nested:
        flat_mask = m.reshape(b, 1, -1).repeat(1, 1, c).to(video_anchor.device)
        flat_anchor = video_anchor.reshape(b, 1, -1)
        for s in audio_streams:
            flat_mask = torch.cat([flat_mask, torch.ones_like(s.reshape(b, 1, -1))], dim=-1)
            flat_anchor = torch.cat([flat_anchor, s.reshape(b, 1, -1)], dim=-1)
        hook = sl._mask_blend_fn(flat_anchor, flat_mask)
    else:
        hook = sl._mask_blend_fn(video_anchor, m)
    patched.model_options = comfy.model_patcher.set_model_options_post_cfg_function(
        patched.model_options, hook)
    return patched


def run_lowres(model, positive, negative, latent_image, sampler, sigmas, seed, cfg,
               transition_step, lowres_scale, highres_tiling=False, model_hires=None):
    """一采：低分辨率前缀（原函数前半段，接缝之前）。

    返回 {"state": [...], "x0": [...], "nested": bool}：
    state/x0 每个流一个 tensor（视频流在前，音频流在后），
    两者都停在 sigma = sigmas[transition_step - 1]，是二采续跑所需的全部信息。
    """
    import torch
    import comfy.sample
    import comfy.samplers
    import comfy.utils
    import latent_preview

    sl = _engine()
    plan = _plan(model, latent_image, lowres_scale, highres_tiling, model_hires,
                 build_high_model=False)
    nested = plan["nested"]
    video = plan["video"]
    b, c, t, H, W = plan["b"], plan["c"], plan["t"], plan["H"], plan["W"]
    h, w = plan["h"], plan["w"]
    source_video = plan["source_video"]
    audio_streams = plan["audio_streams"]

    if video:
        low_video = torch.nn.functional.interpolate(
            source_video.float(), size=(t, h, w), mode="trilinear", align_corners=False
        ).to(dtype=source_video.dtype)
        positive_low = sl._resize_keyframes(positive, h, w)
        negative_low = sl._resize_keyframes(negative, h, w)
    else:
        low_video = torch.nn.functional.interpolate(
            source_video.float(), size=(h, w), mode="bilinear", align_corners=False
        ).to(dtype=source_video.dtype)
        positive_low, negative_low = positive, negative

    low_latent = sl._pack([low_video] + audio_streams, nested)
    low_model = _masked_model(model, low_video, plan["m_low"], nested, audio_streams, b, c)
    del low_video
    noise_low = comfy.sample.prepare_noise(low_latent, seed,
                                           latent_image.get("batch_index", None))

    total_steps = sigmas.shape[-1] - 1
    callback = latent_preview.prepare_callback(model, total_steps)
    disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED

    transition = {}
    low_evaluations = 0

    def callback_low(step, x0, x, total):
        nonlocal low_evaluations
        step = low_evaluations
        low_evaluations += 1
        if low_evaluations > transition_step:
            raise RuntimeError("SelfLift: too many low-resolution callbacks for the Euler schedule")
        if step == transition_step - 1:
            transition["state"] = x
            transition["x0"] = x0
        # 预览解码器按目标分辨率工作：解一份临时提升过的，但采样状态保持低分辨率
        preview_x0 = x0
        if video:
            preview_streams, preview_nested = sl._streams(x0)
            preview_video = torch.nn.functional.interpolate(
                preview_streams[0].float(), size=(t, H, W), mode="trilinear",
                align_corners=False).to(preview_streams[0].dtype)
            preview_x0 = sl._pack([preview_video] + preview_streams[1:], preview_nested)
            del preview_video, preview_streams
        elif x0.ndim == 4:
            preview_x0 = torch.nn.functional.interpolate(
                x0.float(), size=(H, W), mode="bilinear", align_corners=False).to(x0.dtype)
        result = callback(step, preview_x0, preview_x0, total_steps)
        del preview_x0
        return result

    logging.info("[SelfLift 一采] 低分辨率前缀 %d 步 low_latent=%s target_latent=%s "
                 "sigma_transition=%.8g", transition_step, (b, c, t, h, w),
                 tuple(plan["shapes"][0]), float(sigmas[transition_step]))
    # ↓↓↓ 接缝：这一行之上是「一采」，之下是「二采」 ↓↓↓
    comfy.samplers.sample(low_model, noise_low, positive_low, negative_low, cfg,
                          low_model.load_device, sampler, sigmas[:transition_step + 1],
                          low_model.model_options, latent_image=low_latent,
                          callback=callback_low, disable_pbar=disable_pbar, seed=seed)
    if low_evaluations != transition_step:
        raise RuntimeError(
            f"SelfLift: expected {transition_step} low-resolution callbacks, "
            f"received {low_evaluations}; check sampler wrappers")

    state_streams, nested = sl._streams(transition.pop("state"))
    x0_streams, _ = sl._streams(transition.pop("x0"))
    return {"state": state_streams, "x0": x0_streams, "nested": nested}


def run_highres(model, positive, negative, vae, latent_image, sampler, sigmas, seed, cfg,
                transition_step, lowres_scale, rho, w_min, w_max, latent_upsample,
                latent_lifter, highres_tiling, model_hires,
                low_state, low_x0, cached_nested):
    """二采：提升 + 全分辨率收尾（原函数后半段，接缝之后）。

    low_state / low_x0 来自一采（或缓存文件）的 state / x0 流列表。
    全程走兄弟包原逻辑：提升 → 按 sigma_k 重新加噪 → 复用那次预测做一次 Euler →
    从 sigmas[transition_step:] 全分辨率收尾。
    """
    import torch
    import comfy.sample
    import comfy.samplers
    import comfy.model_management
    import comfy.utils
    import latent_preview

    sl = _engine()
    selflift_mod = _load_sibling("selflift")

    plan = _plan(model, latent_image, lowres_scale, highres_tiling, model_hires,
                 build_high_model=True)
    video = plan["video"]
    b, c, t, H, W = plan["b"], plan["c"], plan["t"], plan["H"], plan["W"]
    device = plan["device"]
    video_anchor = plan["source_video"]
    m_full = plan["m_full"]
    audio_streams = plan["audio_streams"]
    # 按「当前」latent 的嵌套结构打包（resume_latent 要喂给当前模型）
    nested = plan["nested"]

    low_streams = [s.to(device) for s in low_state]
    x0_streams = [s.to(device) for s in low_x0]
    expected_streams = len(audio_streams) + 1
    if len(low_streams) != expected_streams or len(x0_streams) != expected_streams:
        raise ValueError(
            f"DNSSelfLiftH3: 一采缓存的流数量（{len(low_streams)}）与当前 latent（{expected_streams}）"
            "对不上，多半是换了模型 / 分辨率 / 时长；请改缓存命名或删掉该缓存重跑一采。")
    if bool(cached_nested) != bool(nested):
        raise ValueError("DNSSelfLiftH3: 一采缓存的 latent 结构与当前输入不一致"
                         "（单流 / 嵌套 AV 流不同），请改缓存命名或删掉该缓存重跑一采。")

    model_sampling = model.get_model_object("model_sampling")
    latent_format = model.get_model_object("latent_format")
    total_steps = sigmas.shape[-1] - 1
    callback = latent_preview.prepare_callback(model, total_steps)
    disable_pbar = not comfy.utils.PROGRESS_BAR_ENABLED
    high_model = _masked_model(plan["high_model"], video_anchor, m_full, nested,
                               audio_streams, b, c)

    sigma_k = sigmas[transition_step - 1]
    sigma_next = sigmas[transition_step]
    # 音频流没有空间维，低分辨率阶段不影响它；它复用同一次 Euler 边界步
    auxiliary_next = [sl._euler_step(state.to(device), denoised.to(device), sigma_k, sigma_next)
                      for state, denoised in zip(low_streams[1:], x0_streams[1:])]
    z0_low_vae = latent_format.process_out(x0_streams[0].float()).to(device)
    del low_streams, x0_streams

    need_pix = rho > 0.0 and w_max > 0.0
    need_lat = not (rho >= 1.0 and w_min >= 1.0 and w_max >= 1.0)
    z_lat_vae, z_pix_vae = selflift_mod.paired_lifts(
        z0_low_vae, vae, (H, W), latent_upsample, latent_lifter,
        need_lat=need_lat, need_pix=need_pix)
    z_lat = latent_format.process_in(z_lat_vae) if z_lat_vae is not None else None
    z_pix = latent_format.process_in(z_pix_vae) if z_pix_vae is not None else None
    z0_high = selflift_mod.artifact_aware_consistency_lift(z_lat, z_pix, rho, w_min, w_max,
                                                           mask=m_full)
    if m_full is not None:
        # 保留区用真正的原始 latent 回填，而不是任何提升估计
        m_cast = m_full.to(device=z0_high.device, dtype=z0_high.dtype)
        z0_high = z0_high * m_cast + video_anchor * (1.0 - m_cast)
    if os.environ.get("SELFLIFT_DEBUG", "0") == "1":
        sl._debug_dump(vae, {
            "z0_low": z0_low_vae,
            "z_lat": z_lat_vae,
            "z_pix": z_pix_vae,
            "z0_high": latent_format.process_out(z0_high),
        })
    z0_high = z0_high.to(device)
    del z0_low_vae, z_lat_vae, z_pix_vae, z_lat, z_pix

    # 按复用那次模型评估的 sigma 重新加噪，然后补完这个 Euler 区间（不再多一次去噪调用）
    video_noise = comfy.sample.prepare_noise(z0_high, (seed + 1) % (1 << 64),
                                             latent_image.get("batch_index", None)).to(z0_high)
    video_state = model_sampling.noise_scaling(sigma_k, video_noise, z0_high)
    next_streams = [sl._euler_step(video_state, z0_high, sigma_k, sigma_next)] + auxiliary_next
    del z0_high, video_noise, video_state, auxiliary_next
    resume_streams = [model_sampling.inverse_noise_scaling(sigma_next, s) for s in next_streams]
    resume_latent = model.model.process_latent_out(sl._pack(resume_streams, nested))
    resume_noise = sl._pack([torch.zeros_like(s) for s in resume_streams], nested)
    del next_streams, resume_streams

    high_evaluations = 0

    def callback_high(step, x0, x, total):
        nonlocal high_evaluations
        step = high_evaluations
        high_evaluations += 1
        if high_evaluations > total_steps - transition_step:
            raise RuntimeError("SelfLift: too many high-resolution callbacks for the Euler schedule")
        return callback(step + transition_step, x0, x, total_steps)

    logging.info("[SelfLift 二采] 全分辨率收尾 %d 步 target_latent=%s sigma_resume=%.8g "
                 "rho=%.4f weights=(%.4f, %.4f) 提升=%s", total_steps - transition_step,
                 tuple(plan["shapes"][0]), float(sigma_next), rho, w_min, w_max,
                 "外部 upscaler" if latent_lifter is not None else latent_upsample)
    out = comfy.samplers.sample(high_model, resume_noise, positive, negative, cfg,
                                model.load_device, sampler, sigmas[transition_step:],
                                high_model.model_options, latent_image=resume_latent,
                                callback=callback_high, disable_pbar=disable_pbar, seed=seed)
    del resume_latent, resume_noise
    if high_evaluations != total_steps - transition_step:
        raise RuntimeError(
            f"SelfLift: expected {total_steps - transition_step} high-resolution callbacks, "
            f"received {high_evaluations}; check sampler wrappers")

    result = latent_image.copy()
    result["samples"] = out.to(device=comfy.model_management.intermediate_device(),
                               dtype=comfy.model_management.intermediate_dtype())
    return result


def _lowres_latent(model, latent_image, blob):
    """把一采（低分辨率、干净预测 x0）变成可直接拿去解码的 LATENT。"""
    import comfy.model_management

    sl = _engine()
    device = comfy.model_management.intermediate_device()
    streams = [s.to(device) for s in blob["x0"]]
    out = latent_image.copy()
    out["samples"] = model.model.process_latent_out(sl._pack(streams, blob["nested"]))
    out["samples"] = out["samples"].to(dtype=comfy.model_management.intermediate_dtype())
    out.pop("noise_mask", None)  # 低分辨率下尺寸对不上，留着会让下游解码炸
    del streams
    return out


# ---------------------------------------------------------------------------
# 节点
# ---------------------------------------------------------------------------


class DNSSelfLiftH3:
    @classmethod
    def INPUT_TYPES(cls):
        upscaler = _load_sibling("h3_upscaler")
        models = ["none"] + upscaler.list_upscaler_models()
        h3 = [m for m in models[1:] if "h3" in m.lower()]
        default_upscaler = h3[0] if h3 else "none"
        return {
            "required": {
                "model": ("MODEL",),
                "positive": ("CONDITIONING",),
                "negative": ("CONDITIONING",),
                "vae": ("VAE", {"tooltip": "视频 VAE（二采提升阶段的像素锚点用）。"}),
                "latent_image": ("LATENT", {"tooltip": "目标分辨率 H3 AV latent（定尺寸与时长）。"}),
                "sampler": ("SAMPLER", {"tooltip": "标准 Euler。"}),
                "sigmas": ("SIGMAS",),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff,
                                 "control_after_generate": True}),
                "transition_step": ("INT", {"default": 6, "min": 1, "max": 10000,
                                            "tooltip": "低分辨率阶段去噪步数（一采的步数）。"}),
                "lowres_scale": ("FLOAT", {"default": 0.5, "min": 0.25, "max": 1.0,
                                           "step": 0.05, "tooltip": "低分辨率空间缩放（只影响一采）。"}),
                "upscaler_model": (models, {"default": default_upscaler,
                                            "tooltip": "外部 H3 latent 提升器（只影响二采）；"
                                                       "none = 用 nearest / rho 那条 SelfLift-zero 路线。"}),
                "run_refine": ("BOOLEAN", {"default": True, "display_name": "二采开关",
                                           "label_on": "二采开关：开",
                                           "label_off": "二采开关：关",
                                           "tooltip": "开：跑二采（提升 + 全分辨率收尾）；"
                                                      "命中缓存命名对应的一采缓存时跳过一采直接收尾。"
                                                      "关：只跑一采（低分辨率前缀），输出该 latent。"}),
                "cache_name": ("STRING", {"default": "", "display_name": "缓存命名",
                                          "tooltip": f"一采缓存文件名（不含扩展名），存到 "
                                                     f"{_CACHE_SUBDIR}/。留空 = 不读写缓存。"
                                                     "缓存按 种子 / transition_step / 低分辨率缩放 / "
                                                     "cfg / latent 尺寸 自动区分（这几个改了会重跑一采）。"
                                                     "换模型或提示词请改「缓存命名」来隔离，"
                                                     "否则会复用旧的一采（命中时状态条会写「跳过一采」）。"}),
                "advanced": ("BOOLEAN", {"default": False, "display_name": "高级选项",
                                         "label_on": "高级选项：展开",
                                         "label_off": "高级选项：收起",
                                         "tooltip": "展开/收起下方很少用到的参数"
                                                    "（cfg / rho / w_min / w_max / 时间分块放大 / "
                                                    "高分辨率分块 / 放大后卸载）。"}),
                # ↓↓↓ 以下默认折叠在「高级选项」里（左侧接线口不受影响）↓↓↓
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 100.0,
                                  "step": 0.1, "round": 0.01,
                                  "tooltip": "CFG（H3 建议 1.0）。"}),
                "rho": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                                  "tooltip": "像素锚点修正比例（H3 用 upscaler 时保持 0）。"}),
                "w_min": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.05}),
                "w_max": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "upscaler_chunking": ("BOOLEAN", {"default": True,
                                                  "display_name": "时间分块放大",
                                                  "label_on": "时间分块放大：开",
                                                  "label_off": "时间分块放大：关",
                                                  "tooltip": "提升器内部的「时间」分块（切 latent "
                                                             "时间维），与「高分辨率分块」的空间分块"
                                                             "是两回事。开：长片按时间窗口分块 + "
                                                             "重叠融合，省显存（默认）；关：整段一次性"
                                                             "提升，显存吃紧时可能爆。"}),
            },
            "optional": {
                "model_hires": ("MODEL", {"tooltip": "高分辨率阶段用的另一个模型（可选）。"}),
                "highres_tiling": ("BOOLEAN", {"default": False, "display_name": "高分辨率分块",
                                               "tooltip": "省显存：高分辨率阶段切 1–8 个空间块。"}),
                "upscaler_unload": ("BOOLEAN", {"default": True, "display_name": "放大后卸载",
                                                "tooltip": "提升完立即把 upscaler 从显存卸载。"}),
            },
        }

    RETURN_TYPES = ("LATENT", "STRING")
    RETURN_NAMES = ("latent", "状态")
    FUNCTION = "sample"
    CATEGORY = _CATEGORY
    # 关二采时可以只存缓存、输出口不接线；不标 OUTPUT_NODE 的话这种节点会被
    # ComfyUI 当成「没被用到」直接剪掉，缓存根本不会写。
    OUTPUT_NODE = True
    DESCRIPTION = ("SelfLift H3 渐进采样（DN 版，带一采缓存）。二采开关=关：只跑一采"
                   "（低分辨率前缀），有「缓存命名」就存盘，输出一采 latent。二采开关=开："
                   "命中缓存就跳过一采、直接提升 + 全分辨率收尾；没命中则先跑一采再收尾。"
                   "点「高级选项」展开 cfg / rho / w_min / w_max / 时间分块放大 / 高分辨率分块 / "
                   "放大后卸载。节点底部显示缓存命中状态。")

    def sample(self, model, positive, negative, vae, latent_image, sampler, sigmas,
               seed, cfg, transition_step, lowres_scale, rho, w_min, w_max,
               upscaler_model, run_refine=True, cache_name="", advanced=False,
               model_hires=None, highres_tiling=False, upscaler_unload=True,
               upscaler_chunking=True):
        del advanced  # 纯前端显隐开关，后端不用

        if rho == 0.0 and upscaler_model == "none":
            raise ValueError("DNSSelfLiftH3: rho=0 且 upscaler_model=none 同时关闭了锚点与提升，"
                             "请设 rho>0 或选一个外部 H3 upscaler。")
        sl = _engine()
        sl._validate_schedule(sigmas, transition_step)
        if sigmas.numel() < 2:
            raise ValueError("DNSSelfLiftH3: sigmas 至少要有 2 个值。")
        if not 0.25 <= lowres_scale <= 1.0:
            raise ValueError("SelfLift: lowres_scale 必须在 0.25 到 1 之间。")
        if not 0.0 <= rho <= 1.0:
            raise ValueError("SelfLift: rho 必须在 0 到 1 之间。")
        if not 0.0 <= w_min <= w_max <= 1.0:
            raise ValueError("SelfLift: 权重要满足 0 <= w_min <= w_max <= 1。")
        sl._validate_sampling(model.get_model_object("model_sampling"), sampler)
        if highres_tiling and latent_image.get("noise_mask") is not None:
            raise ValueError("SelfLift: noise_mask 不能与高分辨率分块同用。")
        sl._validate_latent_input(latent_image)

        name = _sanitize_name(cache_name) if cache_name.strip() else ""
        path = ""
        if name:
            path = _cache_path(name, _cache_key_fingerprint(
                seed, transition_step, lowres_scale, cfg, latent_image))
            logging.info("[DNSSelfLiftH3] 缓存目录=%s | 目标文件=%s", _cache_dir(),
                         os.path.basename(path))
        lifter = _lifter(upscaler_model, upscaler_unload, upscaler_chunking)

        def lowres():
            return run_lowres(model, positive, negative, latent_image, sampler, sigmas,
                              seed, cfg, transition_step, lowres_scale,
                              highres_tiling, model_hires)

        def highres(blob):
            return run_highres(model, positive, negative, vae, latent_image, sampler, sigmas,
                               seed, cfg, transition_step, lowres_scale, rho, w_min, w_max,
                               "nearest", lifter, highres_tiling, model_hires,
                               blob["state"], blob["x0"], blob["nested"])

        cached = bool(path) and os.path.isfile(path)

        # 把 cache_name 记到 self，_finish 里用来写内存状态表（前端轮询查这条）
        self._last_cache_name = name

        # ---------- 二采开关 = 关：只要一采 ----------
        if not run_refine:
            if cached:
                blob = _load_cache(path)
                return self._finish(
                    _lowres_latent(model, latent_image, blob),
                    f"命中缓存 {os.path.basename(path)} · 关二采 → 直接输出一采 latent")
            blob = lowres()
            if path:
                _save_cache(path, blob)
            text = (f"未命中 → 跑一采并存 {os.path.basename(path)}" if path
                    else "未设缓存命名 · 只跑一采（未存盘）")
            return self._finish(_lowres_latent(model, latent_image, blob), text)

        # ---------- 二采开关 = 开：一采（可命中）+ 二采 ----------
        if cached:
            blob = _load_cache(path)
            out = highres(blob)
            return self._finish(out, f"命中缓存 {os.path.basename(path)} · 跳过一采 → 二采完成")
        blob = lowres()
        if path:
            _save_cache(path, blob)
        out = highres(blob)
        text = (f"未命中 → 一采存 {os.path.basename(path)} → 二采完成" if path
                else "未设缓存命名 · 一采 + 二采（完整渐进采样）")
        return self._finish(out, text)

    def _finish(self, latent, status_text):
        logging.info("[DNSSelfLiftH3] %s", status_text)
        # 把状态写进内存表（前端 fetch /dn/selflift_status 轮询取，不依赖前端事件 API）
        try:
            record_status(getattr(self, "_last_cache_name", ""), status_text)
        except Exception:
            pass
        return {"ui": {"dn_selflift_status": [status_text]},
                "result": (latent, status_text)}


# ---------------------------------------------------------------------------
# 前端主动查询用的内存状态表 + HTTP 路由
# ---------------------------------------------------------------------------

# 最近一次执行的"状态文本"，按 cache_name 归档（同 key 覆盖）；最多留 32 条，超了丢最旧。
# 前端在「跑完节点」后 fetch /dn/selflift_status?cache_name=xxx 直接读，
# 不依赖任何前端事件 API（onExecuted / app.on / K.addEventListener 在新旧构建上行为不一）。
_LAST_STATUSES: "dict[str, dict]" = {}
_MAX_LAST_STATUSES = 32
_STATUS_LOCK = __import__("threading").Lock()


def record_status(cache_name: str, status_text: str) -> None:
    """把这次执行的状态写进内存表（sample() 末尾调，前端查这条而不是走事件）。"""
    if not cache_name:
        return
    with _STATUS_LOCK:
        _LAST_STATUSES.pop(cache_name, None)
        _LAST_STATUSES[cache_name] = {
            "status": status_text,
            "ts": __import__("time").time(),
        }
        while len(_LAST_STATUSES) > _MAX_LAST_STATUSES:
            oldest = min(_LAST_STATUSES.items(), key=lambda kv: kv[1]["ts"])
            _LAST_STATUSES.pop(oldest[0], None)


def _register_status_route() -> None:
    """注册 /dn/selflift_status 路由；无 PromptServer 时跳过（不影响其它功能）。"""
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return

    instance = getattr(PromptServer, "instance", None)
    if instance is None or not hasattr(instance, "routes"):
        return

    async def dn_selflift_status(request):
        """GET /dn/selflift_status?cache_name=x —— 直接查最近一次执行的状态。
        带指纹查询（可选）：/dn/selflift_status?cache_name=x&fingerprint=yyy 可命中对应
        那次（不同指纹的缓存文件不同，同 cache_name 也可能跨配置命中/未命中过）。"""
        cache_name = request.query.get("cache_name", "").strip()
        if not cache_name:
            return web.json_response({"error": "cache_name required"}, status=400)
        fingerprint = request.query.get("fingerprint", "").strip()
        with _STATUS_LOCK:
            entry = _LAST_STATUSES.get(cache_name)
        if entry is None:
            return web.json_response({"status": None, "ts": None, "fingerprint": fingerprint or None})
        return web.json_response({
            "status": entry["status"],
            "ts": entry["ts"],
            "fingerprint": fingerprint or None,
        })

    async def dn_selflift_cache_list(request):
        """GET /dn/selflift_cache?cache_name=x
        返回缓存目录里、该 cache_name 下所有已存的指纹。

        用途：前端改参数时，按 seed/transition_step/lowres_scale/cfg 算出指纹，
        匹配目录里同名 cache_name 的文件 —— 立刻显示「命中 / 未命中」，
        不需要等节点真的跑完。
        """
        cache_name = request.query.get("cache_name", "").strip()
        if not cache_name:
            return web.json_response({"fingerprints": []})
        base = _sanitize_name(cache_name)
        root = _cache_dir()
        fps = []
        try:
            for fn in os.listdir(root):
                # 文件名格式：{cache_name}__{fingerprint}.pt
                if not fn.endswith(".pt"):
                    continue
                stem = fn[: -3]
                if "__" not in stem:
                    continue
                name_part, fp_part = stem.rsplit("__", 1)
                if name_part == base:
                    fps.append(fp_part)
        except FileNotFoundError:
            pass
        return web.json_response({"fingerprints": sorted(fps), "cache_dir": root})

    async def dn_selflift_cache_batch(request):
        """GET /dn/selflift_cache_batch?names=a,b,c
        一次问多个缓存命名的状态（「资产卡任务台」的分段面板用）。

        返回 ``{"items": {name: {"count", "bytes", "newest", "status", "ts"}}, "cache_dir": ...}``：

        - ``count`` / ``bytes`` / ``newest``：该命名下已存的一采缓存**文件数 / 总字节 / 最新写入时间**
          （只 listdir + stat，不读文件内容，不碰 GPU）。
        - ``status`` / ``ts``：该命名**最近一次执行**写在内存表里的状态文本（没跑过就是 null）。

        为什么要批量的：面板有 N 段，逐段发请求就是 N 次（每 3 秒一轮）；
        这里一次遍历目录就能把 N 段的数字都算出来，且**只查自己关心的那几个命名**。
        """
        raw = request.query.get("names", "").strip()
        root = _cache_dir()
        names = []
        for piece in raw.split(","):
            piece = piece.strip()
            if piece and piece not in names:
                names.append(piece)
        names = names[:64]           # 面板一次最多问 64 段，够用且不会被刷爆
        items = {name: {"count": 0, "bytes": 0, "newest": None,
                        "status": None, "ts": None} for name in names}
        if names:
            wanted = {}
            for name in names:
                wanted.setdefault(_sanitize_name(name), name)
            try:
                for fn in os.listdir(root):
                    if not fn.endswith(".pt"):
                        continue
                    stem = fn[: -3]
                    if "__" not in stem:
                        continue
                    name_part, _fp = stem.rsplit("__", 1)
                    key = wanted.get(name_part)
                    if key is None:
                        continue
                    entry = items[key]
                    entry["count"] += 1
                    try:
                        stat = os.stat(os.path.join(root, fn))
                        entry["bytes"] += stat.st_size
                        newest = entry["newest"]
                        if newest is None or stat.st_mtime > newest:
                            entry["newest"] = stat.st_mtime
                    except OSError:
                        pass
            except FileNotFoundError:
                pass
            # 内存表里的"最近一次执行状态"：record_status 存的是**净化后**的名字，
            # 而 /dn/selflift_status 查的是**原样**的名字 —— 两个都试一遍，别在这掉链子。
            with _STATUS_LOCK:
                for name in names:
                    for key in {name, _sanitize_name(name)}:
                        entry = _LAST_STATUSES.get(key)
                        if entry:
                            items[name]["status"] = entry["status"]
                            items[name]["ts"] = entry["ts"]
                            break
        return web.json_response({"items": items, "cache_dir": root})

    for route, handler in (
        ("/dn/selflift_status", dn_selflift_status),
        ("/selflift/dn_status", dn_selflift_status),
        ("/dn/selflift_cache", dn_selflift_cache_list),
        ("/selflift/dn_cache", dn_selflift_cache_list),
        ("/dn/selflift_cache_batch", dn_selflift_cache_batch),
    ):
        try:
            instance.routes.get(route)(handler)
        except Exception:
            pass


_register_status_route()


NODE_CLASS_MAPPINGS = {
    "DNSSelfLiftH3": DNSSelfLiftH3,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "DNSSelfLiftH3": "SelfLift Sampler DN",
}
