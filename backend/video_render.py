"""Frame-by-frame ASCII conversion with original timestamps and complete audio."""
import math
import os
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageColor, ImageDraw, ImageFont, ImageOps
from pydantic import BaseModel, ConfigDict, Field, field_validator
from typing import Literal

from backend.characters import SETS


class VideoOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    columns: int = Field(80, ge=40, le=1000)
    charset: str = "classic"
    custom: str = Field(" .:-=+*#%@", min_length=1, max_length=256)
    brightness: float = Field(0, ge=-100, le=100)
    contrast: float = Field(20, ge=-100, le=100)
    saturation: float = Field(100, ge=0, le=200)
    gamma: float = Field(1, ge=.3, le=2.5)
    rotation: Literal[0, 90, 180, 270] = 0
    mirror: bool = False
    invert: bool = False
    inkBrightness: float = Field(120, ge=0, le=300)
    colorMode: Literal["palette", "mono", "original"] = "palette"
    foreground: str = "#d1e8a0"
    background: str = "#10140f"
    colors: list[str] = Field(default_factory=lambda: ["#273923", "#657943", "#a4bd79", "#d1e8a0"], min_length=2, max_length=16)
    format: Literal["mp4", "webm", "gif"] = "mp4"
    fileName: str = Field("AmuzASCII", max_length=80)

    @field_validator("charset")
    @classmethod
    def valid_charset(cls, value):
        if value != "custom" and value not in SETS:
            raise ValueError("Unknown character set")
        return value

    @field_validator("custom")
    @classmethod
    def printable(cls, value):
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("Printable characters required")
        return value

    @field_validator("foreground", "background")
    @classmethod
    def color(cls, value):
        if len(value) != 7 or value[0] != "#":
            raise ValueError("HEX color required")
        int(value[1:], 16)
        return value

    @field_validator("colors")
    @classmethod
    def palette(cls, value):
        return [cls.color(c) for c in value]


def video_info(path, poster_path=None):
    with av.open(str(path), options={"protocol_whitelist": "file,pipe", "format_whitelist": "mov,matroska,avi,mpeg,mpegts,ogg,asf,flv,h264,hevc,m4v"}) as source:
        if not source.streams.video:
            raise ValueError("В файле нет видеодорожки.")
        stream = source.streams.video[0]
        if stream.width * stream.height > 25_000_000:
            raise ValueError("Максимальное разрешение — 25 мегапикселей.")
        frame = next(source.decode(stream), None)
        if frame is None:
            raise ValueError("Не удалось прочитать первый кадр видео.")
        if frame.width * frame.height > 25_000_000:
            raise ValueError("Максимальное разрешение — 25 мегапикселей.")
        rotation = int(round(frame.rotation or 0)) % 360
        image = frame.to_image()
        if rotation:
            image = image.rotate(rotation, expand=True)
        width, height = image.size
        if poster_path:
            image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
            image.save(poster_path, "PNG")
        video_duration = float(stream.duration * stream.time_base) if stream.duration else 0
        duration = max(video_duration, (source.duration or 0) / av.time_base)
        return {"width": width, "height": height,
                "rotation": rotation, "duration": max(0, duration), "video_duration": video_duration,
                "fps": float(stream.average_rate or stream.guessed_rate or 30),
                "frames": stream.frames or 0, "has_audio": bool(source.streams.audio)}


def mono_font():
    candidates = [os.environ.get("AMUZASCII_FONT", ""),
                  "DejaVuSansMono-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
                  "C:/Windows/Fonts/consolab.ttf", "/System/Library/Fonts/Menlo.ttc"]
    for candidate in candidates:
        if candidate:
            try:
                return ImageFont.truetype(candidate, 100)
            except OSError:
                pass
    raise ValueError("Не найден моноширинный шрифт для видео.")


class AsciiFrames:
    def __init__(self, width, height, options):
        self.s = options
        if options.rotation % 180:
            width, height = height, width
        self.size = (width + width % 2, height + height % 2)
        self.columns = options.columns
        self.rows = max(1, min(2000, round(options.columns * height / width * .5)))
        self.cw, self.ch = math.ceil(self.size[0] / self.columns), math.ceil(self.size[1] / self.rows)
        self.ramp = options.custom if options.charset == "custom" else SETS[options.charset]
        font = mono_font()
        bounds = [font.getbbox(ch, anchor="ls") for ch in self.ramp if ch != " "]
        top = min((b[1] for b in bounds), default=-75)
        bottom = max((b[3] for b in bounds), default=0)
        ink_height = max(1, bottom - top)
        self.atlas = np.zeros((len(self.ramp), self.ch, self.cw), dtype=np.uint8)
        for index, symbol in enumerate(self.ramp):
            if symbol == " ":
                continue
            left, _, right, _ = font.getbbox(symbol, anchor="ls")
            tile = Image.new("L", (max(1, math.ceil(font.getlength(symbol)), right - left), ink_height))
            ImageDraw.Draw(tile).text((tile.width / 2, -top), symbol, font=font, fill=255, anchor="ms")
            self.atlas[index] = np.asarray(tile.resize((self.cw, self.ch), Image.Resampling.LANCZOS))
        # Readable grids are composed directly at the output resolution. The
        # old ceil-sized grid was squeezed as a whole, blurring glyph edges and
        # mixing colors across neighboring cells at fractional cell sizes.
        self.native_grid = self.size[0] / self.columns >= 3 and self.size[1] / self.rows >= 3
        if self.native_grid:
            x_edges = np.floor(np.arange(self.columns + 1) * self.size[0] / self.columns).astype(int)
            y_edges = np.floor(np.arange(self.rows + 1) * self.size[1] / self.rows).astype(int)
            self.x_cell = np.repeat(np.arange(self.columns), np.diff(x_edges))
            self.y_cell = np.repeat(np.arange(self.rows), np.diff(y_edges))
            self.x_local = np.arange(self.size[0]) - x_edges[self.x_cell]
            self.y_local = np.arange(self.size[1]) - y_edges[self.y_cell]
            self.x_width = np.diff(x_edges)[self.x_cell]
            self.y_height = np.diff(y_edges)[self.y_cell]
            self.native_atlas = {}
            for height in np.unique(np.diff(y_edges)):
                native_font = font.font_variant(size=max(1, round(height * 100 / ink_height)))
                boxes = [native_font.getbbox(ch, anchor="ls") for ch in self.ramp if ch != " "]
                native_top = min((b[1] for b in boxes), default=-height)
                native_bottom = max((b[3] for b in boxes), default=0)
                for width in np.unique(np.diff(x_edges)):
                    tiles = np.zeros((len(self.ramp), self.ch, self.cw), dtype=np.uint8)
                    for index, symbol in enumerate(self.ramp):
                        if symbol == " ":
                            continue
                        tile = Image.new("L", (max(1, math.ceil(native_font.getlength(symbol))), max(1, native_bottom - native_top)))
                        ImageDraw.Draw(tile).text((tile.width / 2, -native_top), symbol, font=native_font, fill=255, anchor="ms")
                        tiles[index, :height, :width] = np.asarray(tile.resize((int(width), int(height)), Image.Resampling.LANCZOS))
                    self.native_atlas[int(width), int(height)] = tiles
        contrast = options.contrast * 2.55
        factor = 259 * (contrast + 255) / (255 * (259 - contrast))
        self.lut = np.array([round(255 * (max(0, min(255, factor * (i - 128) + 128 + options.brightness * 2.55)) / 255) ** (1 / options.gamma)) for i in range(256)], dtype=np.uint8)
        self.background = np.array(ImageColor.getrgb(options.background), dtype=np.float32)
        self.foreground = np.array(ImageColor.getrgb(options.foreground), dtype=np.float32)
        channels = np.array([ImageColor.getrgb(c) for c in options.colors], dtype=np.float32)
        points = np.linspace(0, len(channels) - 1, 32)
        tones = np.array([channels[int(p)] * (1 - p % 1) + channels[min(len(channels) - 1, int(p) + 1)] * (p % 1) for p in points])
        lum = tones @ np.array([.2126, .7152, .0722])
        self.tones = np.clip(lum[:, None] + (tones - lum[:, None]) * options.saturation / 100, 0, 255)
        # Settings are fixed for the whole export. Cache every possible alpha
        # blend once instead of expanding full-resolution float RGB planes on
        # every frame (often hundreds of megabytes of temporary arrays).
        alpha = np.arange(256, dtype=np.float32) / 255
        gain = options.inkBrightness / 100
        if options.colorMode == "original":
            colors = np.clip(np.arange(256, dtype=np.float32) * gain, 0, 255)
            self.blend = np.stack([np.rint(bg + (colors[:, None] - bg) * alpha).astype(np.uint8)
                                   for bg in self.background])
        else:
            colors = self.foreground[None] if options.colorMode == "mono" else self.tones
            colors = np.clip(colors.astype(np.float32) * gain, 0, 255)
            self.blend = np.rint(self.background + (colors[:, None, :] - self.background)
                                 * alpha[None, :, None]).astype(np.uint8)


    def render(self, image):
        s = self.s
        if s.rotation:
            image = image.rotate(-s.rotation, expand=True)
        if s.mirror:
            image = ImageOps.mirror(image)
        pixels = np.asarray(image.resize((self.columns, self.rows), Image.Resampling.LANCZOS), dtype=np.float32)
        weights = np.array([.2126, .7152, .0722], dtype=np.float32)
        luminance = pixels @ weights
        rgb = self.lut[np.rint(np.clip(luminance[..., None] + (pixels - luminance[..., None]) * s.saturation / 100, 0, 255)).astype(np.uint8)]
        light = rgb @ weights
        level = 255 - light if s.invert else light
        indices = np.minimum(len(self.ramp) - 1, (level / 256 * len(self.ramp)).astype(np.int32))
        if self.native_grid:
            cell_indices = indices[self.y_cell[:, None], self.x_cell]
            mask = np.empty((self.size[1], self.size[0]), dtype=np.uint8)
            for (width, height), atlas in self.native_atlas.items():
                yy = np.flatnonzero(self.y_height == height)
                xx = np.flatnonzero(self.x_width == width)
                mask[yy[:, None], xx] = atlas[cell_indices[yy[:, None], xx], self.y_local[yy, None], self.x_local[xx]]
            if s.colorMode == "original":
                result = np.empty((*mask.shape, 3), dtype=np.uint8)
                for channel in range(3):
                    result[..., channel] = self.blend[channel][rgb[self.y_cell[:, None], self.x_cell, channel], mask]
                return result
            if s.colorMode == "mono":
                return self.blend[0, mask]
            tones = np.minimum(31, np.rint(light).astype(np.int32) >> 3)
            return self.blend[tones[self.y_cell[:, None], self.x_cell], mask]
        mask = self.atlas[indices]
        if s.colorMode == "original":
            result = np.empty((*mask.shape, 3), dtype=np.uint8)
            for channel in range(3):
                result[..., channel] = self.blend[channel][rgb[..., channel, None, None], mask]
        elif s.colorMode == "mono":
            result = self.blend[0, mask]
        else:
            tones = np.minimum(31, np.rint(light).astype(np.int32) >> 3)
            result = self.blend[tones[..., None, None], mask]
        result = result.transpose(0, 2, 1, 3, 4).reshape(self.rows * self.ch, self.columns * self.cw, 3)
        image = Image.fromarray(result)
        if image.size != self.size:
            image = image.resize(self.size, Image.Resampling.LANCZOS)
        return np.asarray(image)


def transcode(source_path, output_path, options, info, progress, stopping):
    """Decode to EOF, retain every frame's timestamp and flush all encoders."""
    renderer = AsciiFrames(info["width"], info["height"], options)
    processed, last_pts, final_time = 0, -1, 0.0
    with av.open(str(source_path), options={"protocol_whitelist": "file,pipe", "format_whitelist": "mov,matroska,avi,mpeg,mpegts,ogg,asf,flv,h264,hevc,m4v"}) as source, av.open(str(output_path), "w", format=options.format, options={"loop": "0"} if options.format == "gif" else {}) as target:
        vin = source.streams.video[0]
        vin.codec_context.thread_count = min(4, os.cpu_count() or 1)
        vin.thread_type = "AUTO"
        rate = vin.average_rate or vin.guessed_rate or Fraction(30)
        origin = (source.start_time or 0) / av.time_base
        video_tb = Fraction(1, 100 if options.format == "gif" else 90000)
        vout = target.add_stream({"mp4": "libx264", "webm": "libvpx-vp9", "gif": "gif"}[options.format], rate=rate)
        vout.width, vout.height = renderer.size
        vout.pix_fmt = "pal8" if options.format == "gif" else "yuv420p"
        vout.time_base = video_tb
        vout.codec_context.time_base = video_tb
        vout.codec_context.thread_count = min(4, os.cpu_count() or 1)
        vout.options = {"crf": "14", "preset": "veryfast", "tune": "animation", "bf": "0"} if options.format == "mp4" else {} if options.format == "gif" else {"crf": "18", "b": "0", "deadline": "good", "cpu-used": "4", "lag-in-frames": "0"}
        durations = {}
        def mux_video(packets):
            for encoded in packets:
                packet_tb = encoded.time_base or video_tb
                key = round(encoded.pts * packet_tb / video_tb) if encoded.pts is not None else None
                duration_ticks = durations.pop(key, None)
                if duration_ticks is not None:
                    encoded.duration = max(1, round(duration_ticks * video_tb / packet_tb))
                target.mux(encoded)
        audio = {}
        audio_inputs = [] if options.format == "gif" else list(source.streams.audio)
        for ain in audio_inputs:
            aout = target.add_stream("aac" if options.format == "mp4" else "libopus", rate=48000)
            aout.layout = "stereo"
            aout.bit_rate = 192000
            audio[ain.index] = (aout, av.AudioResampler(format="fltp" if options.format == "mp4" else "flt", layout="stereo", rate=48000))
        # Pillow/NumPy release the GIL. Prepare a small number of frames in
        # parallel while the main thread decodes and encodes in source order.
        # Large images stay serial to bound peak memory.
        workers = 2 if (os.cpu_count() or 1) >= 4 and info["width"] * info["height"] <= 4_000_000 else 1
        pending, video_pending = deque(), 0
        def prepare_frame(frame):
            if stopping.is_set():
                raise RuntimeError("Обработка видео прервана сервером. Неполный файл не сохранён.")
            image = frame.to_image()
            if info["rotation"]:
                image = image.rotate(info["rotation"], expand=True)
            pixels = renderer.render(image)
            if options.format == "gif":
                indexed = Image.fromarray(pixels).quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
                colors = np.asarray(indexed.getpalette(), dtype=np.uint8).reshape(-1, 3)
                palette = np.zeros((256, 4), dtype=np.uint8)
                palette[:, 0] = 255
                palette[:len(colors), 1:] = colors
                return av.VideoFrame.from_ndarray((np.asarray(indexed), palette), format="pal8")
            return av.VideoFrame.from_ndarray(pixels, format="rgb24")

        def consume():
            nonlocal processed, last_pts, final_time, video_pending
            stream_index, frame, future = pending.popleft()
            if stopping.is_set():
                raise RuntimeError("Обработка видео прервана сервером. Неполный файл не сохранён.")
            if future is not None:
                rendered = future.result()
                video_pending -= 1
                time = float(frame.pts * frame.time_base) - origin if frame.pts is not None else processed / float(rate)
                rendered.pts = max(last_pts + 1, round(time / video_tb))
                rendered.time_base = video_tb
                duration = float(frame.duration * frame.time_base) if frame.duration else 1 / float(rate)
                rendered.duration = max(1, round(duration / video_tb))
                durations[rendered.pts] = rendered.duration
                last_pts = rendered.pts
                mux_video(vout.encode(rendered))
                processed += 1
                final_time = time + duration
                progress(processed, final_time)
            elif stream_index in audio:
                aout, resampler = audio[stream_index]
                if frame.pts is not None:
                    frame.pts -= round(origin / frame.time_base)
                for resampled in resampler.resample(frame):
                    for encoded in aout.encode(resampled):
                        target.mux(encoded)

        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="ascii-frame") as pool:
            try:
                for packet in source.demux(vin, *audio_inputs):
                    if stopping.is_set():
                        raise RuntimeError("Обработка видео прервана сервером. Неполный файл не сохранён.")
                    for frame in packet.decode():
                        future = pool.submit(prepare_frame, frame) if packet.stream.type == "video" else None
                        pending.append((packet.stream.index, frame, future))
                        video_pending += future is not None
                        while pending and (video_pending >= workers * 2 or len(pending) >= 32
                                           or pending[0][2] is None or pending[0][2].done()):
                            consume()
                while pending:
                    consume()
            finally:
                for _, _, future in pending:
                    if future is not None:
                        future.cancel()
        mux_video(vout.encode(None))
        for aout, resampler in audio.values():
            for frame in resampler.resample(None):
                for encoded in aout.encode(frame):
                    target.mux(encoded)
            for encoded in aout.encode(None):
                target.mux(encoded)
    if processed == 0 or (info["frames"] and processed != info["frames"]):
        raise RuntimeError("Видео прочитано не полностью. Неполный файл не сохранён.")
    # A successful download must contain the complete source timeline, not only
    # the prefix before a decoding failure or a browser player position.
    if info.get("video_duration") and final_time + max(.1, 2 / float(rate)) < info["video_duration"]:
        raise RuntimeError("Видео прочитано не полностью. Неполный файл не сохранён.")
    with av.open(str(output_path)) as completed:
        if not completed.streams.video or completed.size <= 0:
            raise RuntimeError("Не удалось завершить кодирование видео.")
    return {"frames": processed, "duration": final_time, "width": renderer.size[0], "height": renderer.size[1], "has_audio": bool(audio)}
