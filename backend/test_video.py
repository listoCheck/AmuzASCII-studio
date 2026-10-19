import time
import threading
from fractions import Fraction

import av
import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.video_render import VideoOptions, video_info


def make_video(path, audio=True, times=None):
    variable = times is not None
    times = times or list(range(24))
    with av.open(str(path), "w") as output:
        video = output.add_stream("libx264", rate=12)
        video.width, video.height, video.pix_fmt = 160, 90, "yuv420p"
        video.time_base = video.codec_context.time_base = Fraction(1, 12)
        if variable:
            video.options = {"bf": "0"}
        audio_stream = output.add_stream("aac", rate=48000) if audio else None
        if audio_stream:
            audio_stream.layout = "stereo"
        for n, pts in enumerate(times):
            rgb = np.full((90, 160, 3), 35 + n * 180 // max(1, len(times) - 1), dtype=np.uint8)
            frame = av.VideoFrame.from_ndarray(rgb, format="rgb24")
            frame.pts, frame.time_base = pts, Fraction(1, 12)
            for packet in video.encode(frame):
                output.mux(packet)
        for packet in video.encode(None):
            output.mux(packet)
        if audio_stream:
            length = round((times[-1] + 1) / 12 * 48000)
            for start in range(0, length, 1024):
                wave = np.sin(np.arange(start, min(length, start + 1024)) * 440 * 2 * np.pi / 48000).astype(np.float32) * .2
                frame = av.AudioFrame.from_ndarray(np.stack([wave, wave]), format="fltp", layout="stereo")
                frame.sample_rate, frame.pts, frame.time_base = 48000, start, Fraction(1, 48000)
                for packet in audio_stream.encode(frame):
                    output.mux(packet)
            for packet in audio_stream.encode(None):
                output.mux(packet)


def wait_for_job(client, job_id):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        response = client.get(f"/api/video-jobs/{job_id}")
        assert response.status_code == 200
        job = response.json()
        if job["status"] in {"completed", "failed"}:
            return job
        time.sleep(.02)
    raise AssertionError("Video processing timed out")


@pytest.mark.parametrize("format", ["mp4", "webm"])
def test_full_video_has_all_frames_duration_and_audio(tmp_path, format):
    path = tmp_path / "source.mp4"
    make_video(path)
    with TestClient(app) as client:
        uploaded = client.post("/api/videos", files={"file": (path.name, path.read_bytes(), "video/mp4")})
        assert uploaded.status_code == 200, uploaded.text
        source = uploaded.json()
        assert source["frames"] == 24 and source["has_audio"]
        assert client.get(source["poster_url"]).headers["content-type"] == "image/png"
        response = client.post(f'/api/videos/{source["id"]}/jobs', json={"columns": 40, "format": format, "colorMode": "original", "fileName": "complete"})
        assert response.status_code == 202, response.text
        job = wait_for_job(client, response.json()["id"])
        assert job["status"] == "completed", job
        assert job["progress"] == 100 and job["result"]["frames"] == 24
        metrics = job["metrics"]
        assert metrics["elapsed_seconds"] > 0 and metrics["fps"] > 0
        assert metrics["eta_seconds"] == 0
        assert metrics["memory_mb"] is None or metrics["memory_mb"] > 0
        assert metrics["cpu_percent"] is None or 0 <= metrics["cpu_percent"] <= 100
        downloaded = client.get(f'/api/video-jobs/{job["id"]}/download')
        assert downloaded.status_code == 200
        result = tmp_path / ("result." + format)
        result.write_bytes(downloaded.content)
        with av.open(str(result)) as video:
            assert video.streams.audio
            frames = list(video.decode(video=0))
            assert len(frames) == 24
            assert abs(float(frames[-1].time) - 23 / 12) < .02
            assert frames[-1].to_ndarray(format="rgb24").mean() > frames[0].to_ndarray(format="rgb24").mean()
        with av.open(str(result)) as video:
            audio = list(video.decode(audio=0))
            assert audio and audio[-1].time + audio[-1].samples / audio[-1].sample_rate >= 1.98


def test_variable_frame_timestamps_survive_and_no_trim_parameters(tmp_path):
    path = tmp_path / "variable.mp4"
    make_video(path, audio=False, times=[0, 1, 3, 7, 9])
    with av.open(str(path)) as original:
        expected = [float(frame.time) for frame in original.decode(video=0)]
        expected_duration = original.duration / av.time_base
    with TestClient(app) as client:
        source = client.post("/api/videos", files={"file": (path.name, path.read_bytes(), "video/mp4")}).json()
        url = f'/api/videos/{source["id"]}/jobs'
        assert client.post(url, json={"start_time": .5}).status_code == 422
        job = wait_for_job(client, client.post(url, json={"columns": 40}).json()["id"])
        assert job["status"] == "completed", job
        result = tmp_path / "variable-result.mp4"
        result.write_bytes(client.get(f'/api/video-jobs/{job["id"]}/download').content)
        with av.open(str(result)) as completed:
            actual = [float(frame.time) for frame in completed.decode(video=0)]
            assert completed.duration / av.time_base == pytest.approx(expected_duration, abs=.002)
        assert actual == pytest.approx(expected, abs=.002)


def test_failed_conversion_never_downloads_partial_video(tmp_path, monkeypatch):
    path = tmp_path / "source.mp4"
    make_video(path, audio=False)
    def fail(source, output, *args):
        output.write_bytes(b"partial-file")
        raise RuntimeError("simulated encoder failure")
    monkeypatch.setattr("backend.videos.transcode", fail)
    with TestClient(app) as client:
        source = client.post("/api/videos", files={"file": (path.name, path.read_bytes(), "video/mp4")}).json()
        job = wait_for_job(client, client.post(f'/api/videos/{source["id"]}/jobs', json={}).json()["id"])
        assert job["status"] == "failed" and job["result"] is None
        assert client.get(f'/api/video-jobs/{job["id"]}/download').status_code == 409
        internal = app.state.video_store.job(job["id"])
        assert not internal["path"].exists()
        assert not list(internal["directory"].iterdir())


def test_pending_download_is_blocked_until_every_frame_is_encoded(tmp_path, monkeypatch):
    from backend.video_render import transcode
    path = tmp_path / "source.mp4"
    make_video(path, audio=False)
    started, finish = threading.Event(), threading.Event()
    def delayed(*args):
        started.set()
        if not finish.wait(10):
            raise RuntimeError("test timeout")
        return transcode(*args)
    monkeypatch.setattr("backend.videos.transcode", delayed)
    with TestClient(app) as client:
        source = client.post("/api/videos", files={"file": (path.name, path.read_bytes(), "video/mp4")}).json()
        job_id = client.post(f'/api/videos/{source["id"]}/jobs', json={"columns": 40}).json()["id"]
        try:
            assert started.wait(2)
            assert client.get(f"/api/video-jobs/{job_id}/download").status_code == 409
            assert client.get(f"/api/video-jobs/{job_id}").json()["progress"] < 100
        finally:
            finish.set()
        job = wait_for_job(client, job_id)
        assert job["status"] == "completed" and job["result"]["frames"] == 24


def test_bad_and_oversized_video_is_rejected(monkeypatch):
    with TestClient(app) as client:
        assert client.post("/api/videos", files={"file": ("bad.mp4", b"bad", "video/mp4")}).status_code == 400
        monkeypatch.setattr("backend.videos.MAX_VIDEO", 10)
        assert client.post("/api/videos", files={"file": ("large.mp4", b"0" * 11, "video/mp4")}).status_code == 413
        assert not app.state.video_store.sources


def test_video_settings_validate_palette_and_detail():
    for options in [{"columns": 1001}, {"gamma": 0}, {"colors": ["red", "blue"]}, {"format": "avi"}]:
        with pytest.raises(ValueError):
            VideoOptions(**options)


def test_preview_source_supports_ranges_and_matches_the_original(tmp_path):
    path = tmp_path / "source.mp4"
    make_video(path, audio=False)
    payload = path.read_bytes()
    with TestClient(app) as client:
        source = client.post("/api/videos", files={"file": (path.name, payload, "video/mp4")}).json()
        url = f'/api/videos/{source["id"]}/source'
        response = client.get(url, headers={"Range": "bytes=100-299"})
        assert response.status_code == 206
        assert response.content == payload[100:300]
        assert response.headers["content-range"] == f"bytes 100-299/{len(payload)}"
        assert response.headers["content-disposition"] == "inline"
        assert client.get(url).content == payload
        assert client.get("/api/videos/missing/source").status_code == 404


@pytest.mark.parametrize("mode", ["palette", "original", "mono"])
def test_cached_compositing_matches_float_reference(mode):
    from PIL import Image, ImageOps
    from backend.video_render import AsciiFrames
    options = VideoOptions(columns=63, colorMode=mode, rotation=90, mirror=True,
                           gamma=1.3, saturation=143, brightness=12, contrast=-15,
                           invert=True, inkBrightness=177, background="#2d1438")
    image = Image.fromarray(np.random.default_rng(7).integers(0, 256, (90, 160, 3), dtype=np.uint8))
    renderer = AsciiFrames(160, 90, options)
    actual = renderer.render(image)
    # Former full float-plane compositor: verifies that the faster lookup path
    # retains antialiasing, channel rounding, and output pixels in all color modes.
    transformed = ImageOps.mirror(image.rotate(-options.rotation, expand=True))
    pixels = np.asarray(transformed.resize((renderer.columns, renderer.rows), Image.Resampling.LANCZOS), dtype=np.float32)
    weights = np.array([.2126, .7152, .0722], dtype=np.float32)
    luminance = pixels @ weights
    rgb = renderer.lut[np.rint(np.clip(luminance[..., None] + (pixels - luminance[..., None]) * options.saturation / 100, 0, 255)).astype(np.uint8)]
    light = rgb @ weights
    level = 255 - light
    indices = np.minimum(len(renderer.ramp) - 1, (level / 256 * len(renderer.ramp)).astype(np.int32))
    mask = renderer.atlas[indices].transpose(0, 2, 1, 3).reshape(renderer.rows * renderer.ch, renderer.columns * renderer.cw).astype(np.float32) / 255
    color = rgb if mode == "original" else renderer.tones[np.minimum(31, np.rint(light).astype(np.int32) >> 3)]
    if mode == "mono":
        color = np.broadcast_to(renderer.foreground, (*indices.shape, 3))
    color = np.clip(color.astype(np.float32) * (options.inkBrightness / 100), 0, 255)
    color = np.repeat(np.repeat(color, renderer.ch, axis=0), renderer.cw, axis=1)
    expected = Image.fromarray(np.rint(renderer.background + (color - renderer.background) * mask[..., None]).astype(np.uint8))
    if expected.size != renderer.size:
        expected = expected.resize(renderer.size, Image.Resampling.LANCZOS)
    assert np.array_equal(actual, np.asarray(expected))


def test_backend_metrics_measure_process_cpu_memory_and_export_rate(monkeypatch):
    from types import SimpleNamespace
    from backend.videos import VideoStore
    monkeypatch.setattr("backend.videos.time.monotonic", lambda: 12)
    monkeypatch.setattr("backend.videos.time.process_time", lambda: 4)
    monkeypatch.setattr("backend.videos.os.cpu_count", lambda: 4)
    monkeypatch.setattr("backend.videos.psutil.Process", lambda: SimpleNamespace(memory_info=lambda: SimpleNamespace(rss=128 * 1048576)))
    job = {"telemetry": {"started": 2, "sampled": 10, "cpu": 2}, "metrics": {},
           "frames": 20, "total_frames": 100, "progress": 20}
    VideoStore.update_metrics(None, job)
    assert job["metrics"] == {"cpu_percent": 25, "memory_mb": 128,
                              "elapsed_seconds": 10, "fps": 2, "eta_seconds": 40}
    VideoStore.update_metrics(None, job, complete=True)
    assert job["metrics"]["eta_seconds"] == 0


def test_parallel_frames_complete_out_of_order_but_export_matches_serial(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from backend import video_render
    source = tmp_path / "source.mp4"
    make_video(source)
    info = video_info(source)
    options = VideoOptions(columns=63, colorMode="original")
    monkeypatch.setattr(video_render.os, "cpu_count", lambda: 4)
    def serial_pool(**kwargs):
        return ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(video_render, "ThreadPoolExecutor", serial_pool)
    serial = tmp_path / "serial.mp4"
    video_render.transcode(source, serial, options, info, lambda *_: None, threading.Event())
    monkeypatch.setattr(video_render, "ThreadPoolExecutor", ThreadPoolExecutor)
    original_render = video_render.AsciiFrames.render
    later_finished = threading.Event()
    completion_order = []
    def out_of_order_render(self, image):
        first = image.getpixel((0, 0))[0] < 40
        if first:
            assert later_finished.wait(2), "Second frame did not render concurrently"
        result = original_render(self, image)
        completion_order.append(first)
        if not first:
            later_finished.set()
        return result
    monkeypatch.setattr(video_render.AsciiFrames, "render", out_of_order_render)
    parallel = tmp_path / "parallel.mp4"
    video_render.transcode(source, parallel, options, info, lambda *_: None, threading.Event())
    assert completion_order[0] is False and True in completion_order
    with av.open(str(serial)) as left, av.open(str(parallel)) as right:
        a, b = list(left.decode(video=0)), list(right.decode(video=0))
        assert len(a) == len(b) == 24
        for before, after in zip(a, b):
            assert before.time == after.time
            assert np.array_equal(before.to_ndarray(format="rgb24"), after.to_ndarray(format="rgb24"))
    with av.open(str(serial)) as left, av.open(str(parallel)) as right:
        a, b = list(left.decode(audio=0)), list(right.decode(audio=0))
        assert len(a) == len(b) and a
        assert [(f.time, f.samples) for f in a] == [(f.time, f.samples) for f in b]


@pytest.mark.parametrize("times", [None, [0, 1, 3, 7, 9]])
def test_gif_export_keeps_all_frames_timing_and_loops_without_audio(tmp_path, times):
    import io
    from PIL import Image
    source = tmp_path / "source.mp4"
    make_video(source, times=times)
    with av.open(str(source)) as original:
        expected = [float(frame.time) for frame in original.decode(video=0)]
        expected_duration = original.duration / av.time_base
    with TestClient(app) as client:
        imported = client.post("/api/videos", files={"file": (source.name, source.read_bytes(), "video/mp4")}).json()
        response = client.post(f'/api/videos/{imported["id"]}/jobs', json={"columns": 40, "format": "gif", "colorMode": "original"})
        assert response.status_code == 202
        job = wait_for_job(client, response.json()["id"])
        assert job["status"] == "completed", job
        assert job["result"]["frames"] == len(expected) and not job["result"]["has_audio"]
        downloaded = client.get(f'/api/video-jobs/{job["id"]}/download')
        assert downloaded.headers["content-type"] == "image/gif"
        assert '.gif' in downloaded.headers['content-disposition']
        with Image.open(io.BytesIO(downloaded.content)) as gif:
            assert gif.n_frames == len(expected) and gif.info["loop"] == 0
            assert gif.size == (160, 90)
            elapsed, means = 0, []
            for index, timestamp in enumerate(expected):
                gif.seek(index)
                assert abs(elapsed / 1000 - timestamp) <= .011
                elapsed += gif.info["duration"]
                means.append(np.asarray(gif.convert("RGB")).mean())
            assert abs(elapsed / 1000 - expected_duration) <= .03
            assert means[-1] > means[0]


@pytest.mark.parametrize("format", ["mp4", "webm"])
def test_export_preserves_readable_glyph_edges_at_fractional_cell_sizes(tmp_path, format):
    from PIL import Image
    from backend.video_render import AsciiFrames, transcode
    source = tmp_path / "sharp-source.mp4"
    with av.open(str(source), "w") as container:
        stream = container.add_stream("libx264", rate=12)
        stream.width, stream.height, stream.pix_fmt = 322, 182, "yuv420p"
        for n in range(4):
            frame = av.VideoFrame.from_image(Image.new("RGB", (322, 182), "white"))
            frame.pts, frame.time_base = n, Fraction(1, 12)
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    options = VideoOptions(columns=40, charset="custom", custom="M", colorMode="mono",
                           foreground="#ffffff", background="#000000", inkBrightness=100, format=format)
    expected = AsciiFrames(322, 182, options).render(Image.new("RGB", (322, 182), "white"))
    output = tmp_path / ("sharp." + format)
    transcode(source, output, options, video_info(source), lambda *_: None, threading.Event())
    with av.open(str(output)) as decoded:
        frames = list(decoded.decode(video=0))
    assert len(frames) == 4
    for frame in frames:
        actual = frame.to_ndarray(format="rgb24")
        assert actual.shape == expected.shape
        assert np.abs(actual.astype(float) - expected).mean() < 4
        assert actual.max() >= 250 and actual.min() <= 5


def test_readable_export_does_not_blend_neighboring_cell_colors():
    from PIL import Image
    from backend.video_render import AsciiFrames
    # Each sampled column has one pure primary. Glyph filtering may antialias
    # against black, but must never leak a neighboring primary into its cell.
    image = Image.fromarray(np.array([[[255, 0, 0], [0, 0, 255]] * 20] * 12, dtype=np.uint8))
    renderer = AsciiFrames(322, 182, VideoOptions(columns=40, charset="custom", custom="M",
        colorMode="original", contrast=0, background="#000000", inkBrightness=100))
    actual = renderer.render(image)
    edges = np.floor(np.arange(41) * 322 / 40).astype(int)
    for x in range(40):
        cell = actual[:, edges[x]:edges[x + 1]]
        assert cell[..., 2 if x % 2 == 0 else 0].max() == 0
        assert cell[..., 0 if x % 2 == 0 else 2].max() > 200
