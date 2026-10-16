"""Temporary video imports and background jobs. Only finished files are downloadable."""
import logging
import os
import re
import shutil
import tempfile
import threading
import time
import uuid

import psutil
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from backend.video_render import VideoOptions, transcode, video_info

logger = logging.getLogger(__name__)
MAX_VIDEO = 250 * 1024 * 1024
RETENTION = 3600
store_lock = threading.Lock()


class VideoStore:
    def __init__(self):
        base = os.environ.get("AMUZASCII_VIDEO_DIR")
        if base:
            Path(base).mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix="amuzascii-video-", dir=base)
        self.root = Path(self.directory.name)
        self.sources, self.jobs = {}, {}
        self.lock = threading.RLock()
        self.stopping = threading.Event()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="amuzascii-video")
        self.closed = False

    def cleanup(self):
        with self.lock:
            cutoff = time.monotonic() - RETENTION
            for key, job in list(self.jobs.items()):
                if job["status"] in {"completed", "failed"} and job["touched"] < cutoff:
                    shutil.rmtree(job["directory"], ignore_errors=True)
                    del self.jobs[key]
            active = {j["source_id"] for j in self.jobs.values() if j["status"] in {"queued", "processing"}}
            for key, source in list(self.sources.items()):
                if key not in active and source["touched"] < cutoff:
                    shutil.rmtree(source["directory"], ignore_errors=True)
                    del self.sources[key]

    def import_file(self, upload):
        self.cleanup()
        with self.lock:
            if len(self.sources) >= 16:
                raise HTTPException(429, "Слишком много загруженных видео. Повторите позже.")
        key = uuid.uuid4().hex
        directory = self.root / key
        directory.mkdir()
        path, poster = directory / "source.video", directory / "poster.png"
        try:
            size = 0
            with path.open("wb") as target:
                while chunk := upload.file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_VIDEO:
                        raise HTTPException(413, "Максимальный размер видео — 250 МБ.")
                    target.write(chunk)
            info = video_info(path, poster)
            entry = {"id": key, "name": (upload.filename or "video")[:120], "info": info,
                     "path": path, "poster": poster, "directory": directory, "touched": time.monotonic()}
            with self.lock:
                self.sources[key] = entry
            return {"id": key, "name": entry["name"], **info, "poster_url": f"/api/videos/{key}/poster"}
        except HTTPException:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        except Exception as exc:
            shutil.rmtree(directory, ignore_errors=True)
            raise HTTPException(400, "Не удалось прочитать видео на сервере. Проверьте файл.") from exc

    def source(self, key):
        self.cleanup()
        with self.lock:
            source = self.sources.get(key)
            if source is None:
                raise HTTPException(404, "Видео больше не доступно. Загрузите его снова.")
            source["touched"] = time.monotonic()
            return source

    def public(self, job):
        if job["status"] == "processing" and job.get("telemetry"):
            self.update_metrics(job)
        return {k: job[k] for k in ("id", "source_id", "status", "progress", "frames", "total_frames", "duration", "error", "format", "result", "metrics")}

    def update_metrics(self, job, complete=False):
        sampler = job["telemetry"]
        now, cpu = time.monotonic(), time.process_time()
        elapsed = max(0, now - sampler["started"])
        interval = now - sampler["sampled"]
        metrics = dict(job["metrics"])
        if interval >= .1:
            # process_time includes all threads; normalize to total host CPU.
            metrics["cpu_percent"] = round(min(100, max(0, (cpu - sampler["cpu"]) / interval * 100 / (os.cpu_count() or 1))), 1)
            sampler.update(sampled=now, cpu=cpu)
        try:
            metrics["memory_mb"] = round(psutil.Process().memory_info().rss / 1048576, 1)
        except (psutil.Error, OSError):
            metrics["memory_mb"] = None
        fps = job["frames"] / elapsed if elapsed > 0 else 0
        ratio = job["frames"] / job["total_frames"] if job["total_frames"] else job["progress"] / 100
        ratio = min(1, max(0, ratio))
        metrics.update(elapsed_seconds=round(elapsed, 2), fps=round(fps, 2),
                       eta_seconds=0 if complete else round(elapsed * (1 - ratio) / ratio, 1) if ratio > 0 else None)
        job["metrics"] = metrics

    def start(self, source_id, options):
        source = self.source(source_id)
        with self.lock:
            if sum(j["status"] in {"queued", "processing"} for j in self.jobs.values()) >= 3:
                raise HTTPException(429, "Очередь обработки видео заполнена. Повторите позже.")
            key = uuid.uuid4().hex
            directory = self.root / ("job-" + key)
            directory.mkdir()
            name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", options.fileName).strip(" .") or "AmuzASCII"
            job = {"id": key, "source_id": source_id, "status": "queued", "progress": 0,
                   "frames": 0, "total_frames": source["info"]["frames"], "duration": source["info"]["duration"],
                   "error": "", "format": options.format, "result": None, "directory": directory,
                   "path": directory / ("result." + options.format), "filename": name + "." + options.format,
                   "touched": time.monotonic(), "metrics": {"elapsed_seconds": 0, "fps": 0, "eta_seconds": None, "cpu_percent": None, "memory_mb": None}}
            self.jobs[key] = job
            self.executor.submit(self.run, job, source, options)
            return self.public(job)

    def run(self, job, source, options):
        pending = job["directory"] / ("pending." + options.format)
        try:
            with self.lock:
                job["status"] = "processing"
                job["telemetry"] = {"started": time.monotonic(), "sampled": time.monotonic(), "cpu": time.process_time()}
            def progress(frames, seconds):
                with self.lock:
                    job["frames"] = frames
                    ratio = frames / job["total_frames"] if job["total_frames"] else seconds / job["duration"] if job["duration"] else 0
                    job["progress"] = min(99, round(ratio * 100))
                    job["touched"] = source["touched"] = time.monotonic()
            result = transcode(source["path"], pending, options, source["info"], progress, self.stopping)
            pending.replace(job["path"])
            with self.lock:
                self.update_metrics(job, complete=True)
                job.update(status="completed", progress=100, result=result, touched=time.monotonic())
        except Exception:
            logger.exception("ASCII video conversion failed: %s", job["id"])
            pending.unlink(missing_ok=True)
            job["path"].unlink(missing_ok=True)
            with self.lock:
                if job.get("telemetry"):
                    self.update_metrics(job)
                job.update(status="failed", error="Не удалось обработать видео полностью. Неполный файл не сохранён.", touched=time.monotonic())

    def job(self, key):
        self.cleanup()
        with self.lock:
            job = self.jobs.get(key)
            if job is None:
                raise HTTPException(404, "Результат больше не доступен. Запустите обработку снова.")
            job["touched"] = time.monotonic()
            return job

    def shutdown(self):
        self.stopping.set()
        self.executor.shutdown(wait=True, cancel_futures=True)
        self.directory.cleanup()
        self.closed = True


@asynccontextmanager
async def lifespan(app):
    yield
    store = getattr(app.state, "video_store", None)
    if store and not store.closed:
        store.shutdown()


router = APIRouter(prefix="/api", lifespan=lifespan)


def store_for(request):
    with store_lock:
        store = getattr(request.app.state, "video_store", None)
        if store is None or store.closed:
            store = request.app.state.video_store = VideoStore()
        return store


@router.post("/videos")
def import_video(request: Request, file: UploadFile = File(...)):
    return store_for(request).import_file(file)


@router.get("/videos/{source_id}/poster")
def poster(source_id: str, request: Request):
    return FileResponse(store_for(request).source(source_id)["poster"], media_type="image/png")


@router.get("/videos/{source_id}/source")
def preview_source(source_id: str, request: Request):
    source = store_for(request).source(source_id)
    # FileResponse supports HTTP ranges for seeking without loading the entire file.
    return FileResponse(source["path"], media_type="application/octet-stream",
                        headers={"Content-Disposition": "inline"})


@router.post("/videos/{source_id}/jobs", status_code=202)
def process_video(source_id: str, options: VideoOptions, request: Request):
    return store_for(request).start(source_id, options)


@router.get("/video-jobs/{job_id}")
def job_status(job_id: str, request: Request):
    store = store_for(request)
    with store.lock:
        return store.public(store.job(job_id))


@router.get("/video-jobs/{job_id}/download")
def download_video(job_id: str, request: Request):
    job = store_for(request).job(job_id)
    if job["status"] != "completed" or not job["path"].is_file():
        raise HTTPException(409, "Полное видео ещё не готово.")
    return FileResponse(job["path"], media_type={"mp4": "video/mp4", "webm": "video/webm", "gif": "image/gif"}[job["format"]], filename=job["filename"])
