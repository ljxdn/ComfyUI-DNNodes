# ---------------------------------------------------------------------------
# 资产卡（Asset Card）后端 —— 原 ComfyUI-H3-OpenNodes 的 H3 Media Loader
#
# 来源与授权（MIT）：
#   派生自 https://github.com/juntaosun/ComfyUI-H3-OpenNodes 的 H3MediaLoader.py
#   作者 sunnyboxs（GitHub: juntaosun），MIT License，Copyright (c) 2026 sunnyboxs。
#   上游仓库已删除（GitHub 404），原包与上游都不再更新。
#   按 MIT 要求保留原始版权声明；完整信息见仓库根目录 LICENSE 与 THIRD_PARTY_NOTICES.md。
#
# 本包（ComfyUI-DNNodes）相对上游的改动：
#   - 显示名改为「资产卡」，分类并入 DN Nodes（不再挂在 H3Nodes 下）
#   - 新增「最长边」参数（只缩不放），role_name 增加中文显示名「资产名」
#   - 上传接口新增本包路由 /dn/asset_card/upload_image（旧路径保留兼容）
#   - 节点类名/节点 id 仍为 H3MediaLoader —— 这样所有已保存的工作流无需改动
# ---------------------------------------------------------------------------

"""资产卡（节点 id 仍为 H3MediaLoader）：在一个节点中聚合可选的图像、音频与文本描述。

图像加载行为对齐 LoadImage（RGB 张量，动图按帧拼接，带 input 下拉）。
音频加载行为对齐 H3AudioUpload（波形裁剪在执行时生效，不改磁盘文件）。
文本为多行描述；三项均可为空，空项在 media 对象中为 None。
同时输出 media 以及独立的 image / audio / prompt，便于接入其它节点。
图像可选按「最长边」等比缩小（只缩不放），用于降低下游参考图的显存占用。
"""

import hashlib
import os

import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence
from torch.nn import functional as F

import folder_paths


# 图像下拉中的空选项，表示不加载图像。
IMAGE_NONE = "(none)"

# 无 content-type 过滤时，按扩展名识别图像文件。
IMAGE_EXTS = {
    ".png", ".jpg", ".jpeg", ".jpe", ".webp", ".gif",
    ".bmp", ".tif", ".tiff", ".apng",
}

# 「最长边」限制：只等比缩小，绝不放大。
# 取值与算法同 ComfyUI-DNNodes 的 media_group_core（DN H3 Media to Director Group）。
MAX_EDGE_LIMIT = 4096      # 节点 UI 上的最大值
DEFAULT_MAX_EDGE = 1440    # 默认值：最长边超过 1440 就缩到 1440
MIN_MAX_EDGE = 32          # 节点 UI 上的最小值
RESIZE_STRIDE = 2          # 缩放后宽高吸附到 2 的整数倍，避免奇数边长


def _is_empty_name(name):
    """判断文件名是否视为未选择（空、空白或 (none)）。"""
    if name is None:
        return True
    text = str(name).strip()
    return text == "" or text in (IMAGE_NONE, "none", "None")


def _list_input_images():
    """递归列出 input 目录中的图像文件，返回可用于下拉的相对路径。"""
    names = [IMAGE_NONE]
    try:
        input_dir = folder_paths.get_input_directory()
        files = []
        for root, _, filenames in os.walk(input_dir):
            for filename in filenames:
                file_path = os.path.join(root, filename)
                if not os.path.isfile(file_path):
                    continue
                relative_path = os.path.relpath(file_path, input_dir)
                files.append(relative_path.replace(os.sep, "/"))
        if hasattr(folder_paths, "filter_files_content_types"):
            files = folder_paths.filter_files_content_types(files, ["image"])
        else:
            files = [
                f for f in files
                if os.path.splitext(f)[1].lower() in IMAGE_EXTS
            ]
        names.extend(sorted(files))
    except Exception:
        pass
    return names


def _file_signature(file_path):
    """生成文件路径与修改时间、大小的签名，供 IS_CHANGED 使用。"""
    if not file_path:
        return ""
    try:
        stat = os.stat(file_path)
        return "%s:%s:%s" % (file_path, stat.st_mtime, stat.st_size)
    except OSError:
        return str(file_path)


def _resolve_input_path(filename):
    """在 ComfyUI input 目录中解析上传文件的实际路径。"""
    if _is_empty_name(filename):
        return None
    filename = str(filename).strip()

    try:
        annotated = folder_paths.get_annotated_filepath(filename)
        if annotated and os.path.exists(annotated):
            return annotated
    except Exception:
        pass

    input_dir = folder_paths.get_input_directory()
    candidates = [
        os.path.join(input_dir, filename),
        filename if os.path.isabs(filename) else None,
    ]
    for candidate in candidates:
        if candidate and os.path.exists(candidate):
            return candidate
    return None


def _normalize_text(text):
    """空字符串视为未填写，返回 None；其它文本原样保留。"""
    if text is None:
        return None
    if not isinstance(text, str):
        text = str(text)
    return text if text != "" else None


def _normalize_role_name(role_name):
    """归一化角色名称，空白名称返回 None，非空名称去除首尾空白。"""
    if role_name is None:
        return None
    if not isinstance(role_name, str):
        role_name = str(role_name)
    role_name = role_name.strip()
    return role_name if role_name else None


def _md5_bytes(data):
    """计算字节内容的 MD5 十六进制摘要。"""
    return hashlib.md5(data).hexdigest()


def _md5_file(file_path, chunk_size=1024 * 1024):
    """按块读取文件并计算 MD5，避免一次性载入大图。"""
    hasher = hashlib.md5()
    with open(file_path, "rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def _sanitize_upload_basename(filename):
    """提取上传文件的安全基名：去掉目录、拒绝空名，必要时补 .png。"""
    text = str(filename or "").replace("\\", "/")
    name = os.path.basename(text).strip()
    if not name or name in (".", ".."):
        name = "image.png"
    stem, ext = os.path.splitext(name)
    if not stem or stem in (".", ".."):
        stem = "image"
    if not ext:
        ext = ".png"
    return stem + ext


def _duplicate_image_name(stem, ext, index):
    """生成冲突文件名：index=1 为原名，之后为 stem(2).ext、stem(3).ext。"""
    if index <= 1:
        return stem + ext
    return "%s(%d)%s" % (stem, index, ext)


def _resolve_content_aware_image_name(input_dir, filename, content_md5):
    """按内容选择最终文件名：同 MD5 覆盖已有文件，不同内容递增编号。"""
    stem, ext = os.path.splitext(filename)
    if not stem:
        stem = "image"
    if not ext:
        ext = ".png"

    index = 1
    while index <= 10000:
        candidate = _duplicate_image_name(stem, ext, index)
        candidate_path = os.path.join(input_dir, candidate)
        if not os.path.exists(candidate_path):
            return candidate
        try:
            if _md5_file(candidate_path) == content_md5:
                return candidate
        except OSError:
            return candidate
        index += 1
    raise RuntimeError("H3MediaLoader: too many duplicate image names for %s" % filename)


def _is_inside_directory(base_dir, target_path):
    """判断目标路径是否位于指定目录内，防止写出 input 之外。"""
    base_real = os.path.realpath(base_dir)
    target_real = os.path.realpath(target_path)
    try:
        return os.path.commonpath([base_real, target_real]) == base_real
    except ValueError:
        return False


def save_uploaded_image(filename, data):
    """将图像写入 ComfyUI input 根目录，同内容覆盖，不同内容递增编号。"""
    if data is None:
        raise ValueError("empty image data")
    if not isinstance(data, (bytes, bytearray)):
        data = bytes(data)
    if not data:
        raise ValueError("empty image data")

    basename = _sanitize_upload_basename(filename)
    content_md5 = _md5_bytes(data)
    input_dir = folder_paths.get_input_directory()
    os.makedirs(input_dir, exist_ok=True)
    saved_name = _resolve_content_aware_image_name(input_dir, basename, content_md5)
    dest_path = os.path.join(input_dir, saved_name)
    if not _is_inside_directory(input_dir, dest_path):
        raise ValueError("invalid upload path")
    with open(dest_path, "wb") as handle:
        handle.write(data)
    return saved_name


def _resize_long_edge(image, max_edge, stride=RESIZE_STRIDE):
    """等比缩小图片，使最长边不超过 ``max_edge``；本来就够小就原样返回（绝不放大）。

    算法与 ComfyUI-DNNodes 的 media_group_core.resize_long_edge 逐字一致：

    - ``max_edge`` 为 ``None`` / <= 0 → 视为不限制，直接返回原张量
    - 最长边 <= ``max_edge`` → 返回**原张量本身**（不复制、不吸附、像素零改动）
    - 最长边 > ``max_edge`` → 按 ``max_edge / 最长边`` 等比缩小，宽高吸附到 ``stride`` 的整数倍
    - 通道数原样保留
    """
    if image is None or not isinstance(image, torch.Tensor) or image.numel() <= 0:
        return image
    if max_edge is None:
        return image
    try:
        limit = int(max_edge)
    except (TypeError, ValueError):
        return image
    if limit <= 0:
        return image
    limit = max(int(stride), limit)

    height, width = int(image.shape[-3]), int(image.shape[-2])
    current = max(height, width)
    if current <= limit:
        return image

    scale = limit / float(current)
    new_h = max(stride, int(round(height * scale / stride) * stride))
    new_w = max(stride, int(round(width * scale / stride) * stride))
    if new_h == height and new_w == width:
        return image

    resized = F.interpolate(image.movedim(-1, 1), size=(new_h, new_w), mode="area")
    return resized.movedim(1, -1)


def _load_image_tensor(file_path):
    """按 LoadImage 方式读取图像，返回 [B, H, W, C] float32 张量。"""
    img = Image.open(file_path)
    output_images = []
    width = None
    height = None
    excluded_formats = ["MPO"]

    for frame in ImageSequence.Iterator(img):
        frame = ImageOps.exif_transpose(frame)
        if frame.mode == "I":
            frame = frame.point(lambda i: i * (1 / 255))
        image = frame.convert("RGB")

        if width is None:
            width, height = image.size
        if image.size[0] != width or image.size[1] != height:
            continue
        if frame.format in excluded_formats:
            continue

        array = np.array(image).astype(np.float32) / 255.0
        output_images.append(torch.from_numpy(array)[None, ...])

        if img.format not in ("GIF", "WEBP", "APNG"):
            break

    if hasattr(img, "close"):
        img.close()

    if not output_images:
        raise RuntimeError("H3MediaLoader: failed to decode image: %s" % file_path)
    return torch.cat(output_images, dim=0)


def _load_wav_with_wave(file_path):
    """用标准库 wave 读取 PCM WAV，作为 torchaudio/soundfile 的回退。"""
    import wave
    with wave.open(str(file_path), "rb") as handle:
        sr = handle.getframerate()
        channels = handle.getnchannels()
        sampwidth = handle.getsampwidth()
        nframes = handle.getnframes()
        raw = handle.readframes(nframes)
    if sampwidth == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampwidth == 1:
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif sampwidth == 4:
        data = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise RuntimeError("unsupported WAV sample width: %s" % sampwidth)
    if channels > 1:
        data = data.reshape(-1, channels).T
    else:
        data = data.reshape(1, -1)
    return torch.from_numpy(np.ascontiguousarray(data)).float(), int(sr)


def _load_audio_dict(file_path, trim_start, trim_end):
    """读取音频并按秒级裁剪范围返回 ComfyUI AUDIO 字典。"""
    wav = None
    sr = None
    last_error = None

    try:
        import torchaudio
        wav, sr = torchaudio.load(str(file_path))
    except Exception as exc:
        last_error = exc
        try:
            import soundfile as sf
            data, sr = sf.read(str(file_path), always_2d=True)
            wav = torch.from_numpy(data.T).float()
        except Exception as inner:
            last_error = inner
            try:
                wav, sr = _load_wav_with_wave(file_path)
            except Exception as wave_exc:
                raise RuntimeError(
                    "H3MediaLoader: failed to decode audio file %s: %s"
                    % (file_path, last_error)
                ) from wave_exc

    if wav.dim() == 1:
        wav = wav.unsqueeze(0)
    if wav.dim() == 2:
        wav = wav.unsqueeze(0)
    wav = wav.float()

    total_samples = wav.shape[-1]
    if total_samples <= 0:
        raise RuntimeError("H3MediaLoader: audio file is empty.")

    if trim_end is None or trim_end < 0:
        end_sample = total_samples
    else:
        end_sample = int(round(float(trim_end) * sr))
    start_sample = int(round(float(trim_start or 0.0) * sr))
    start_sample = max(0, min(start_sample, total_samples - 1))
    end_sample = max(start_sample + 1, min(end_sample, total_samples))
    trimmed = wav[..., start_sample:end_sample]
    return {"waveform": trimmed, "sample_rate": int(sr)}


class H3MediaLoader:
    """可选图像 / 音频 / prompt 的聚合加载节点。"""

    @classmethod
    def INPUT_TYPES(cls):
        """声明图像下拉、隐藏的音频控件，以及可见的多行 prompt。"""
        return {
            "required": {
                "image_filename": (_list_input_images(), {
                    "image_upload": True,
                    "default": IMAGE_NONE,
                    "tooltip": "从 input 目录选择或上传图像，可为空。",
                }),
                "audio_filename": ("STRING", {"default": ""}),
                "trim_start": ("FLOAT", {
                    "default": 0.0,
                    "min": 0.0,
                    "max": 99999.0,
                    "step": 0.01,
                }),
                "trim_end": ("FLOAT", {
                    "default": -1.0,
                    "min": -1.0,
                    "max": 99999.0,
                    "step": 0.01,
                }),
                "audio_muted": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "静音时不输出 audio。",
                }),
                "role_name": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "display_name": "资产名",
                    "tooltip": "资产名称，可为空。",
                }),
                "max_edge": ("INT", {
                    "default": DEFAULT_MAX_EDGE,
                    "min": MIN_MAX_EDGE,
                    "max": MAX_EDGE_LIMIT,
                    "step": 1,
                    "display_name": "最长边",
                    "tooltip": (
                        "参考图最长边上限（像素）。图片最长边超过该值 → 保持比例等比缩小到该值；"
                        "没超过 → 原样使用，绝不放大。"
                    ),
                }),
                "prompt": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "dynamicPrompts": True,
                    "tooltip": "资产描述（该资产在提示词里的说明），可为空。",
                }),
            },
        }

    RETURN_TYPES = ("H3_MEDIA", "IMAGE", "AUDIO", "STRING")
    RETURN_NAMES = ("media", "image", "audio", "prompt")
    FUNCTION = "load_media"
    CATEGORY = "DN Nodes"
    OUTPUT_NODE = False
    DESCRIPTION = (
        "在一个节点中可选地加载图像、音频（波形预览/裁剪）和描述 prompt，"
        "同时输出 media 对象以及独立的 image / audio / prompt。"
    )

    def load_media(
        self,
        image_filename="",
        audio_filename="",
        trim_start=0.0,
        trim_end=-1.0,
        audio_muted=False,
        role_name="",
        max_edge=DEFAULT_MAX_EDGE,
        prompt="",
    ):
        """加载可选的图像、音频、角色名称与 prompt，同时返回 media 与独立输出。"""
        image = None
        audio = None

        image_name = "" if _is_empty_name(image_filename) else str(image_filename).strip()
        if image_name:
            image_path = _resolve_input_path(image_name)
            if image_path is not None:
                try:
                    image = _load_image_tensor(image_path)
                except FileNotFoundError:
                    raise
                except Exception as exc:
                    raise RuntimeError(
                        "H3MediaLoader: failed to load image %s: %s"
                        % (image_path, exc)
                    ) from exc
                # 「最长边」限制：只缩不放；未超限时返回原张量，像素零改动。
                image = _resize_long_edge(image, max_edge)

        audio_name = (audio_filename or "").strip()
        if audio_name and not bool(audio_muted):
            audio_path = _resolve_input_path(audio_name)
            if audio_path is not None:
                try:
                    audio = _load_audio_dict(audio_path, trim_start, trim_end)
                except Exception as exc:
                    pass

        normalized_role_name = _normalize_role_name(role_name)
        normalized_prompt = _normalize_text(prompt)
        media = {
            "type": "H3_MEDIA",
            "image": image,
            "audio": audio,
            "role_name": normalized_role_name,
            "prompt": normalized_prompt,
        }
        # STRING 输出用空串代替 None，便于直接接入文本类节点。
        prompt_out = normalized_prompt if normalized_prompt is not None else ""
        return (media, image, audio, prompt_out)

    @classmethod
    def IS_CHANGED(
        cls,
        image_filename="",
        audio_filename="",
        trim_start=0.0,
        trim_end=-1.0,
        audio_muted=False,
        role_name="",
        max_edge=DEFAULT_MAX_EDGE,
        prompt="",
    ):
        """根据文件签名、裁剪、静音、角色名称、最长边与 prompt 内容判断是否需要重新执行。"""
        image_path = _resolve_input_path(image_filename)
        audio_path = _resolve_input_path(audio_filename)
        return "|".join([
            _file_signature(image_path) or str(image_filename or ""),
            _file_signature(audio_path) or str(audio_filename or ""),
            str(trim_start),
            str(trim_end),
            str(bool(audio_muted)),
            role_name or "",
            str(max_edge),
            prompt or "",
        ])


NODE_CLASS_MAPPINGS = {
    "H3MediaLoader": H3MediaLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    # 节点 id 不变（工作流兼容），只改界面显示名
    "H3MediaLoader": "资产卡",
}

NODE_REGISTRY = {
    "classes": NODE_CLASS_MAPPINGS,
    "names": NODE_DISPLAY_NAME_MAPPINGS,
}


def _register_upload_route():
    """注册内容感知图像上传接口；无 PromptServer 时跳过。"""
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return

    instance = getattr(PromptServer, "instance", None)
    if instance is None or not hasattr(instance, "routes"):
        return

    async def h3_media_loader_upload_image(request):
        """接收前端上传的图像，按 MD5 写入 input 根目录。"""
        try:
            post = await request.post()
            uploaded = post.get("image")
            if uploaded is None:
                return web.json_response({"error": "missing image"}, status=400)
            filename = getattr(uploaded, "filename", None) or "image.png"
            file_obj = getattr(uploaded, "file", None)
            if file_obj is None:
                return web.json_response({"error": "missing image data"}, status=400)
            data = file_obj.read()
            saved_name = save_uploaded_image(filename, data)
            return web.json_response({
                "name": saved_name,
                "subfolder": "",
                "type": "input",
            })
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    # 本包路由 + 旧包路由都挂上：旧前端（浏览器缓存/旧工作流页面）也不会 404。
    for route in ("/dn/asset_card/upload_image", "/h3/media_loader/upload_image"):
        try:
            instance.routes.post(route)(h3_media_loader_upload_image)
        except Exception:
            pass


_register_upload_route()
