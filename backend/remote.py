"""Bounded URL imports. Direct media is downloaded with public-address pinning."""
import heapq
import http.client
import ipaddress
import json
import re
import shutil
import socket
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit

import av
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field
from yt_dlp import YoutubeDL
from backend.videos import MAX_VIDEO, store_for

MAX_IMAGE = 20 * 1024 * 1024
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"}

class LinkInput(BaseModel):
    url: str = Field(min_length=1, max_length=4096)

_dns_cache = {}
_dns_lock = threading.Lock()


def parse_http_url(url):
    try:
        parts = urlsplit(url)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password or port not in {80, 443}:
            raise ValueError()
        return parts, port
    except ValueError:
        raise ValueError("Нужна публичная ссылка HTTP/HTTPS на фото или видео.") from None


def public_dns_fallback(hostname):
    # Fake-IP VPN DNS requires a real public IP before pinning the connection.
    with _dns_lock:
        cached = _dns_cache.get(hostname)
        if cached and cached[0] > time.monotonic():
            return cached[1]
    for endpoint in ("1.1.1.1", "1.0.0.1"):
        connection = http.client.HTTPSConnection(endpoint, timeout=8)
        try:
            connection.request("GET", "/dns-query?name=" + quote(hostname, safe="") + "&type=A",
                               headers={"Accept": "application/dns-json"})
            response = connection.getresponse()
            if response.status != 200:
                continue
            data = json.loads(response.read(65536))
            addresses = [row["data"] for row in data.get("Answer", []) if row.get("type") == 1]
            if not addresses:
                continue
            if any(not ipaddress.ip_address(address).is_global for address in addresses):
                raise ValueError("Ссылки на локальные и служебные сетевые адреса не поддерживаются.")
            with _dns_lock:
                if len(_dns_cache) >= 128:
                    _dns_cache.clear()
                _dns_cache[hostname] = (time.monotonic() + 60, addresses[0])
            return addresses[0]
        except (OSError, http.client.HTTPException, json.JSONDecodeError):
            continue
        finally:
            connection.close()
    raise ValueError("Не удалось проверить адрес сайта через DNS. Проверьте подключение или VPN и повторите загрузку.")


def public_address(url):
    parts, port = parse_http_url(url)
    try:
        addresses = socket.getaddrinfo(parts.hostname, port, type=socket.SOCK_STREAM)
    except OSError:
        raise ValueError("Не удалось определить сетевой адрес сайта. Проверьте подключение или VPN и повторите загрузку.") from None
    if not addresses:
        raise ValueError("Не удалось определить сетевой адрес сайта. Проверьте подключение или VPN и повторите загрузку.")
    fake_range = ipaddress.ip_network("198.18.0.0/15")
    if all(ipaddress.ip_address(row[4][0]) in fake_range for row in addresses):
        return parts, port, public_dns_fallback(parts.hostname)
    if any(not ipaddress.ip_address(row[4][0]).is_global for row in addresses):
        raise ValueError("Ссылки на локальные и служебные сетевые адреса не поддерживаются.")
    return parts, port, addresses[0][4][0]

def youtube_url(url):
    parts = urlsplit(url)
    if (parts.hostname or "").lower() not in YOUTUBE_HOSTS:
        return None
    if parts.hostname.endswith("youtu.be"):
        key = parts.path.strip("/")
    elif parts.path == "/watch":
        key = parse_qs(parts.query).get("v", [""])[0]
    else:
        match = re.fullmatch(r"/(?:shorts|live|embed)/([A-Za-z0-9_-]{11})/?", parts.path)
        key = match[1] if match else ""
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", key):
        raise ValueError("Укажите ссылку на одно видео YouTube, а не канал или плейлист.")
    return "https://www.youtube.com/watch?v=" + key

def check_stop(stop, deadline):
    if stop.is_set():
        raise ValueError("Загрузка отменена.")
    if time.monotonic() > deadline:
        raise ValueError("Время загрузки истекло. Попробуйте другую ссылку.")

def download_public(url, path, stop, report, budget=MAX_VIDEO, deadline=None):
    deadline = deadline or time.monotonic() + 600
    for _ in range(6):
        check_stop(stop, deadline)
        parts, port, address = public_address(url)
        connection = (http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection)(parts.hostname, port, timeout=20)
        # Keep TLS SNI/certificate verification on the original hostname while
        # connecting to the already validated IP (including after redirects).
        connection._create_connection = lambda _addr, timeout=20, source_address=None, ip=address: socket.create_connection((ip, port), timeout, source_address)
        try:
            target = parts.path or "/"
            if parts.query:
                target += "?" + parts.query
            connection.request("GET", target, headers={"User-Agent": "Mozilla/5.0 AmuzASCII/1.0", "Accept-Encoding": "identity"})
            response = connection.getresponse()
            if response.status in {301, 302, 303, 307, 308}:
                location = response.getheader("Location")
                if not location:
                    raise ValueError("Ссылка перенаправляет без адреса назначения.")
                url = urljoin(url, location)
                continue
            if response.status != 200:
                raise ValueError("Сайт не разрешил загрузку. Нужна доступная прямая ссылка.")
            media_type = response.getheader("Content-Type", "").split(";")[0].lower()
            if media_type in {"text/html", "application/xhtml+xml", "application/json"}:
                raise ValueError("Ссылка ведёт на страницу. Вставьте прямую ссылку на файл или YouTube.")
            length = int(response.getheader("Content-Length", "0"))
            limit = min(budget, MAX_IMAGE) if media_type.startswith("image/") else budget
            if length > limit:
                raise ValueError("Файл превышает лимит: фото 20 МБ, видео 250 МБ.")
            loaded = 0
            report(0, length or None)
            with path.open("wb") as output:
                while True:
                    check_stop(stop, deadline)
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    loaded += len(chunk)
                    if loaded > limit:
                        raise ValueError("Файл превышает лимит: фото 20 МБ, видео 250 МБ.")
                    output.write(chunk)
                    report(loaded, length or None)
            if not loaded or (length and loaded != length):
                raise ValueError("Файл загрузился не полностью. Повторите загрузку.")
            return unquote(Path(parts.path).name)[:120] or "media"
        finally:
            connection.close()
    raise ValueError("Слишком много перенаправлений ссылки.")

class CheckedYoutubeDL(YoutubeDL):
    def urlopen(self, request):
        public_address(request if isinstance(request, str) else request.url)
        return super().urlopen(request)

def import_youtube(url, directory, stop, report, phase=None):
    check_stop(stop, time.monotonic() + 600)
    options = {"quiet": True, "no_warnings": True, "noplaylist": True, "cachedir": False,
               "socket_timeout": 20, "retries": 1, "extractor_retries": 1,
               "js_runtimes": {"node": {}}, "skip_download": True}
    with CheckedYoutubeDL(options) as client:
        info = client.extract_info(url, download=False)
    if not info or info.get("is_live") or info.get("live_status") in {"is_live", "is_upcoming"} or info.get("_type") in {"playlist", "multi_video"}:
        raise ValueError("Нужен завершённый ролик YouTube. Прямые трансляции не поддерживаются.")
    formats = [f for f in info.get("formats", []) if f.get("protocol") in {"http", "https"} and f.get("url")]
    videos = [f for f in formats if f.get("vcodec") not in {None, "none"} and (f.get("width") or 1) * (f.get("height") or 1) <= 25_000_000]
    if not videos:
        raise ValueError("YouTube не выдал доступный видеопоток. Обновите yt-dlp или загрузите файл вручную.")
    selected = max(videos, key=lambda f: (f.get("height") or 0, f.get("fps") or 0, f.get("tbr") or 0))
    tracks = [selected]
    if selected.get("acodec") in {None, "none"}:
        audios = [f for f in formats if f.get("vcodec") == "none" and f.get("acodec") not in {None, "none"}]
        if not audios:
            raise ValueError("Не удалось получить звуковую дорожку YouTube.")
        tracks.append(max(audios, key=lambda f: f.get("abr") or f.get("tbr") or 0))
    known = [f.get("filesize") or f.get("filesize_approx") or 0 for f in tracks]
    if sum(known) > MAX_VIDEO:
        raise ValueError("Файл превышает лимит: фото 20 МБ, видео 250 МБ.")
    estimates = [not f.get("filesize") and bool(f.get("filesize_approx")) for f in tracks]
    loaded = 0
    deadline = time.monotonic() + 600
    paths = []
    for index, track in enumerate(tracks):
        path = directory / f"track-{index}.media"
        base = loaded
        def track_report(count, content_length):
            if content_length:
                known[index] = content_length
                estimates[index] = False
            if phase:
                phase("downloading", any(estimates))
            report(base + count, sum(known) if all(known) else None)
        download_public(track["url"], path, stop, track_report, MAX_VIDEO - loaded, deadline)
        known[index] = path.stat().st_size
        estimates[index] = False
        loaded += known[index]
        paths.append(path)
        report(loaded, sum(known) if all(known) else None)
    if phase:
        phase("preparing")
    output = directory / "youtube.mkv"
    if len(paths) == 1:
        paths[0].replace(output)
    else:
        # Remux without re-encoding: retain both complete tracks, no external ffmpeg.
        with av.open(str(paths[0])) as video, av.open(str(paths[1])) as audio, av.open(str(output), "w", format="matroska") as target:
            streams = [video.streams.video[0], audio.streams.audio[0]]
            inputs = [video, audio]
            outputs = [target.add_stream_from_template(s) for s in streams]
            packets = [iter(c.demux(s)) for c, s in zip(inputs, streams)]
            heap = []
            def push(index):
                for packet in packets[index]:
                    if packet.size and (packet.dts is not None or packet.pts is not None):
                        stamp = packet.dts if packet.dts is not None else packet.pts
                        heapq.heappush(heap, (float(stamp * packet.time_base), index, packet))
                        return
            push(0); push(1)
            while heap:
                check_stop(stop, deadline)
                _, index, packet = heapq.heappop(heap)
                packet.stream = outputs[index]
                target.mux(packet)
                push(index)
    if output.stat().st_size > MAX_VIDEO:
        raise ValueError("Файл превышает лимит: фото 20 МБ, видео 250 МБ.")
    return output, str(info.get("title") or "YouTube")[:110] + ".mkv"

class ImportStore:
    def __init__(self):
        self.directory = tempfile.TemporaryDirectory(prefix="amuzascii-import-")
        self.root = Path(self.directory.name)
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="media-import")
        self.jobs = {}
        self.closed = False

    def public(self, job):
        data = {k: job[k] for k in ("id", "status", "loaded", "total", "error", "media", "phase", "total_estimated")}
        elapsed = max(0, time.monotonic() - job["transfer_started"]) if job.get("transfer_started") is not None else 0
        speed = job["loaded"] / elapsed if elapsed >= .25 else 0
        remaining = max(0, job["total"] - job["loaded"]) if job["total"] is not None else None
        data.update(speed_bps=round(speed), elapsed_seconds=round(elapsed, 2),
                    eta_seconds=0 if job["status"] == "completed" else round(remaining / speed, 1)
                    if speed and remaining is not None and job["phase"] == "downloading" else None)
        return data

    def get(self, key):
        with self.lock:
            for job_id, job in list(self.jobs.items()):
                if job["status"] not in {"queued", "loading"} and job["touched"] < time.monotonic() - 3600:
                    shutil.rmtree(job["directory"], ignore_errors=True)
                    del self.jobs[job_id]
            if key not in self.jobs:
                raise HTTPException(404, "Загрузка больше не доступна. Вставьте ссылку снова.")
            self.jobs[key]["touched"] = time.monotonic()
            return self.jobs[key]

    def start(self, url, videos):
        parse_http_url(url)
        # A shared youtu.be link should not require resolving a redirect host.
        # Strip sharing/list/time parameters and validate the canonical video URL.
        url = youtube_url(url) or url
        public_address(url)
        with self.lock:
            # Trigger expiration even when there are no status polls.
            try:
                self.get("")
            except HTTPException:
                pass
            if len(self.jobs) >= 8 or sum(j["status"] in {"queued", "loading"} for j in self.jobs.values()) >= 2:
                raise HTTPException(429, "Слишком много загрузок по ссылке. Повторите позже.")
            key = uuid.uuid4().hex
            directory = self.root / key
            directory.mkdir()
            job = {"id": key, "status": "queued", "loaded": 0, "total": None, "error": "", "media": None,
                   "directory": directory, "stop": threading.Event(), "touched": time.monotonic(),
                   "phase": "queued", "total_estimated": False, "transfer_started": None}
            self.jobs[key] = job
            self.pool.submit(self.run, job, url, videos)
            return self.public(job)

    def run(self, job, url, videos):
        def report(loaded, total):
            with self.lock:
                if job["transfer_started"] is None:
                    job["transfer_started"] = time.monotonic()
                job.update(loaded=loaded, total=total, phase="downloading", touched=time.monotonic())
        def phase(value, estimated=False):
            with self.lock:
                job.update(phase=value, total_estimated=estimated)
        try:
            with self.lock:
                job["status"] = "loading"
                job["phase"] = "resolving"
            target = youtube_url(url)
            if target:
                path, name = import_youtube(target, job["directory"], job["stop"], report, phase)
            else:
                path = job["directory"] / "source.media"
                name = download_public(url, path, job["stop"], report)
            check_stop(job["stop"], float("inf"))
            phase("preparing")
            try:
                with Image.open(path) as image:
                    if path.stat().st_size > MAX_IMAGE or image.width * image.height > 25_000_000:
                        raise ValueError("Максимум для фото: 20 МБ и 25 мегапикселей.")
                    image.verify()
                media = {"kind": "image", "name": name, "url": f'/api/imports/{job["id"]}/image'}
                job["image"] = path
            except UnidentifiedImageError:
                with path.open("rb") as stream:
                    source = videos.import_file(SimpleNamespace(file=stream, filename=name))
                media = {"kind": "video", "source": source}
            check_stop(job["stop"], float("inf"))
            with self.lock:
                job.update(status="completed", media=media, phase="completed", total=job["loaded"], total_estimated=False, touched=time.monotonic())
            if media["kind"] == "video":
                shutil.rmtree(job["directory"], ignore_errors=True)
        except Exception as exc:
            message = str(exc) if isinstance(exc, (ValueError, HTTPException)) else "Не удалось загрузить медиа. Проверьте доступность ссылки; для YouTube может потребоваться обновление yt-dlp."
            if isinstance(exc, HTTPException):
                message = str(exc.detail)
            with self.lock:
                job.update(status="failed", error=message, touched=time.monotonic())
            shutil.rmtree(job["directory"], ignore_errors=True)

    def shutdown(self):
        with self.lock:
            for job in self.jobs.values():
                job["stop"].set()
        self.pool.shutdown(wait=True, cancel_futures=True)
        self.directory.cleanup()
        self.closed = True

@asynccontextmanager
async def lifespan(app):
    yield
    store = getattr(app.state, "import_store", None)
    if store and not store.closed:
        store.shutdown()

router = APIRouter(prefix="/api/imports", lifespan=lifespan)
store_lock = threading.Lock()
def imports_for(request):
    with store_lock:
        store = getattr(request.app.state, "import_store", None)
        if store is None or store.closed:
            store = request.app.state.import_store = ImportStore()
        return store

@router.post("", status_code=202)
def start_import(data: LinkInput, request: Request):
    try:
        return imports_for(request).start(data.url.strip(), store_for(request))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

@router.get("/{key}")
def import_status(key: str, request: Request):
    store = imports_for(request)
    with store.lock:
        return store.public(store.get(key))

@router.delete("/{key}")
def cancel_import(key: str, request: Request):
    store = imports_for(request)
    with store.lock:
        job = store.get(key)
        if job["status"] in {"queued", "loading"}:
            job["stop"].set()
    return {"ok": True}

@router.get("/{key}/image")
def import_image(key: str, request: Request):
    job = imports_for(request).get(key)
    if job["status"] != "completed" or job["media"]["kind"] != "image":
        raise HTTPException(409, "Изображение ещё не готово.")
    return FileResponse(job["image"])
