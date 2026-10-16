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
