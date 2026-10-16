import io
import shutil
import threading
import time
from types import SimpleNamespace

import av
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app
from backend import remote
from backend.test_video import make_video


def wait_import(client, key):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        job = client.get(f"/api/imports/{key}").json()
        if job["status"] in {"completed", "failed"}:
            return job
        time.sleep(.01)
    raise AssertionError("Import timed out")


def public_dns(monkeypatch):
    monkeypatch.setattr(remote.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 443))])


@pytest.mark.parametrize("url", ["file:///etc/passwd", "http://user:password@example.com/", "http://example.com:8000/a"])
def test_url_schemes_credentials_and_ports_rejected(url):
    with pytest.raises(ValueError):
        remote.public_address(url)


@pytest.mark.parametrize("address", ["127.0.0.1", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1"])
def test_private_dns_addresses_rejected(monkeypatch, address):
    monkeypatch.setattr(remote.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", (address, 443))])
    with pytest.raises(ValueError):
        remote.public_address("https://example.com/a")


def test_youtube_video_urls_are_canonical_and_playlists_rejected():
    assert remote.youtube_url("https://youtu.be/BaW_jenozKc?t=4") == "https://www.youtube.com/watch?v=BaW_jenozKc"
    assert remote.youtube_url("https://www.youtube.com/shorts/BaW_jenozKc") == "https://www.youtube.com/watch?v=BaW_jenozKc"
    assert remote.youtube_url("https://example.com/photo.jpg") is None
    with pytest.raises(ValueError):
        remote.youtube_url("https://www.youtube.com/playlist?list=test")


def test_direct_download_checks_length_limits_and_html(tmp_path, monkeypatch):
    public_dns(monkeypatch)
    response = SimpleNamespace(status=200, getheader=lambda k, default=None: {"Content-Length": "4", "Content-Type": "image/png"}.get(k, default), read=io.BytesIO(b"abcd").read)
    connection = SimpleNamespace(request=lambda *a, **k: None, getresponse=lambda: response, close=lambda: None)
    monkeypatch.setattr(remote.http.client, "HTTPSConnection", lambda *a, **k: connection)
    progress = []
    target = tmp_path / "source"
    assert remote.download_public("https://example.com/photo.png", target, threading.Event(), lambda n, total: progress.append((n, total))) == "photo.png"
    assert target.read_bytes() == b"abcd" and progress[-1] == (4, 4)
    response.read = io.BytesIO(b"ab").read
    with pytest.raises(ValueError, match="не полностью"):
        remote.download_public("https://example.com/photo.png", target, threading.Event(), lambda *a: None)
    response.getheader = lambda k, default=None: {"Content-Length": str(remote.MAX_VIDEO + 1)}.get(k, default)
    with pytest.raises(ValueError, match="лимит"):
        remote.download_public("https://example.com/video", target, threading.Event(), lambda *a: None)
    response.getheader = lambda k, default=None: {"Content-Type": "text/html"}.get(k, default)
    with pytest.raises(ValueError, match="страницу"):
        remote.download_public("https://example.com/page", target, threading.Event(), lambda *a: None)


def test_redirect_is_validated_again(tmp_path, monkeypatch):
    public_dns(monkeypatch)
    original = remote.public_address
    seen = []
    def checked(url):
        seen.append(url)
        if "127.0.0.1" in url:
            raise ValueError("Blocked redirect")
        return original(url)
    monkeypatch.setattr(remote, "public_address", checked)
    response = SimpleNamespace(status=302, getheader=lambda *a: "http://127.0.0.1/private")
    monkeypatch.setattr(remote.http.client, "HTTPSConnection", lambda *a, **k: SimpleNamespace(request=lambda *a, **k: None, getresponse=lambda: response, close=lambda: None))
    with pytest.raises(ValueError, match="Blocked"):
        remote.download_public("https://example.com/a", tmp_path / "x", threading.Event(), lambda *a: None)
    assert len(seen) == 2


@pytest.mark.parametrize("kind", ["image", "video"])
def test_import_api_opens_image_or_complete_video(tmp_path, monkeypatch, kind):
    public_dns(monkeypatch)
    source = tmp_path / "source"
    if kind == "image":
        Image.new("RGB", (64, 40), "red").save(source, "PNG")
    else:
        make_video(source.with_suffix(".mp4"))
        source = source.with_suffix(".mp4")
    def download(url, path, stop, report, *args):
        shutil.copyfile(source, path)
        report(path.stat().st_size, path.stat().st_size)
        return "source.png" if kind == "image" else "source.mp4"
    monkeypatch.setattr(remote, "download_public", download)
    with TestClient(app) as client:
        response = client.post("/api/imports", json={"url": "https://example.com/media"})
        assert response.status_code == 202
        job = wait_import(client, response.json()["id"])
        assert job["status"] == "completed", job
        assert job["media"]["kind"] == kind and job["loaded"] == source.stat().st_size
        if kind == "image":
            image = client.get(job["media"]["url"])
            assert image.content == source.read_bytes()
        else:
            video = job["media"]["source"]
            assert video["frames"] == 24 and video["has_audio"]
            assert client.get(f'/api/videos/{video["id"]}/source').content == source.read_bytes()


def test_cancellation_never_exposes_partial_file(monkeypatch):
    public_dns(monkeypatch)
    started = threading.Event()
    def download(url, path, stop, report, *args):
        path.write_bytes(b"partial")
        started.set()
        assert stop.wait(3)
        remote.check_stop(stop, float("inf"))
    monkeypatch.setattr(remote, "download_public", download)
    with TestClient(app) as client:
        job = client.post("/api/imports", json={"url": "https://example.com/media"}).json()
        assert started.wait(3)
        assert client.delete(f'/api/imports/{job["id"]}').status_code == 200
        result = wait_import(client, job["id"])
        assert result["status"] == "failed" and result["media"] is None
        assert client.get(f'/api/imports/{job["id"]}/image').status_code == 409
        assert not app.state.import_store.get(job["id"])["directory"].exists()


def test_youtube_remux_keeps_all_frames_audio_and_timestamps(tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    make_video(source)
    tracks = []
    for kind in ["video", "audio"]:
        path = tmp_path / (kind + ".mkv")
        with av.open(str(source)) as original, av.open(str(path), "w") as output:
            stream = getattr(original.streams, kind)[0]
            target = output.add_stream_from_template(stream)
            for packet in original.demux(stream):
                if packet.dts is not None:
                    packet.stream = target
                    output.mux(packet)
        tracks.append(path)
    metadata = {"title": "test", "formats": [
        {"protocol": "https", "url": "https://example.com/video", "vcodec": "h264", "acodec": "none", "height": 90},
        {"protocol": "https", "url": "https://example.com/audio", "vcodec": "none", "acodec": "aac", "abr": 128}]}
    class FakeYoutube:
        def __init__(self, options):
            assert options["noplaylist"] and options["skip_download"]
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def extract_info(self, url, download=False): return metadata
    monkeypatch.setattr(remote, "CheckedYoutubeDL", FakeYoutube)
    def download(url, path, stop, report, *args):
        shutil.copyfile(tracks[0 if url.endswith("video") else 1], path)
        report(path.stat().st_size, path.stat().st_size)
    monkeypatch.setattr(remote, "download_public", download)
    output, name = remote.import_youtube("https://www.youtube.com/watch?v=BaW_jenozKc", tmp_path, threading.Event(), lambda *a: None)
    assert name == "test.mkv"
    with av.open(str(output)) as result:
        frames = list(result.decode(video=0))
        assert len(frames) == 24 and abs(frames[-1].time - 23 / 12) < .02
    with av.open(str(output)) as result:
        assert list(result.decode(audio=0))


def test_fake_ip_dns_uses_public_resolution_and_pins_result(monkeypatch):
    monkeypatch.setattr(remote.socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("198.18.0.85", 443))])
    monkeypatch.setattr(remote, "public_dns_fallback", lambda host: "93.184.216.34")
    assert remote.public_address("https://example.com/photo")[2] == "93.184.216.34"


def test_manifest_cannot_open_other_local_or_network_media(tmp_path):
    from backend.video_render import video_info
    playlist = tmp_path / "source.video"
    playlist.write_text("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n")
    with pytest.raises(Exception):
        video_info(playlist)


def test_shared_youtube_url_does_not_resolve_short_redirect_host(tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    make_video(source)
    seen = []
    def dns(host, *args, **kwargs):
        assert host != "youtu.be", "Shared URL must be canonicalized before DNS"
        return [(2, 1, 6, "", ("93.184.216.34", 443))]
    monkeypatch.setattr(remote.socket, "getaddrinfo", dns)
    def youtube(url, directory, stop, report, phase=None):
        seen.append(url)
        target = directory / "source.mp4"
        shutil.copyfile(source, target)
        return target, "video.mp4"
    monkeypatch.setattr(remote, "import_youtube", youtube)
    with TestClient(app) as client:
        job = client.post("/api/imports", json={"url": "https://youtu.be/3s82II8bXD8?si=7tA8BwucadJScpdk"}).json()
        assert wait_import(client, job["id"])["status"] == "completed"
    assert seen == ["https://www.youtube.com/watch?v=3s82II8bXD8"]


def test_dns_failure_is_not_reported_as_invalid_url(monkeypatch):
    def dns(*args, **kwargs):
        raise remote.socket.gaierror("DNS unavailable")
    monkeypatch.setattr(remote.socket, "getaddrinfo", dns)
    with TestClient(app) as client:
        response = client.post("/api/imports", json={"url": "https://example.com/photo.png"})
        assert response.status_code == 400
        assert "сетевой адрес" in response.json()["detail"]
        assert "Нужна публичная ссылка" not in response.json()["detail"]


def test_fake_ip_dns_retries_and_caches_only_verified_public_address(monkeypatch):
    import json
    remote._dns_cache.clear()
    calls = []
    def connection(endpoint, **kwargs):
        calls.append(endpoint)
        def request(*args, **kwargs):
            if endpoint == "1.1.1.1":
                raise OSError("resolver unavailable")
        response = SimpleNamespace(status=200, read=lambda *a: json.dumps({"Answer": [{"type": 1, "data": "93.184.216.34"}]}).encode())
        return SimpleNamespace(request=request, getresponse=lambda: response, close=lambda: None)
    monkeypatch.setattr(remote.http.client, "HTTPSConnection", connection)
    assert remote.public_dns_fallback("retry.example") == "93.184.216.34"
    assert remote.public_dns_fallback("retry.example") == "93.184.216.34"
    assert calls == ["1.1.1.1", "1.0.0.1"]
    remote._dns_cache.clear()


def test_import_progress_exposes_total_speed_and_estimated_remaining(monkeypatch):
    monkeypatch.setattr(remote.time, "monotonic", lambda: 15)
    job = {"id": "test", "status": "loading", "loaded": 25 * 1048576,
           "total": 100 * 1048576, "error": "", "media": None,
           "phase": "downloading", "total_estimated": False, "transfer_started": 5}
    progress = remote.ImportStore.public(None, job)
    assert progress["speed_bps"] == 2621440
    assert progress["eta_seconds"] == 30 and progress["elapsed_seconds"] == 10
    assert progress["loaded"] == 25 * 1048576 and progress["total"] == 100 * 1048576
    job["total"] = None
    assert remote.ImportStore.public(None, job)["eta_seconds"] is None
    job["total"] = 100 * 1048576
    job["phase"] = "preparing"
    assert remote.ImportStore.public(None, job)["eta_seconds"] is None
    job["status"] = "completed"
    assert remote.ImportStore.public(None, job)["eta_seconds"] == 0
