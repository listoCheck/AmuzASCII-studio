"""Local ASCII image conversion API and production frontend hosting."""
import io
import math
import warnings
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw, ImageEnhance, ImageOps, UnidentifiedImageError
from backend.videos import router as videos_router

app = FastAPI(title="AmuzASCII", version="1.0.0")
app.include_router(videos_router)
Image.MAX_IMAGE_PIXELS = 25_000_000
MAX_UPLOAD = 20 * 1024 * 1024
from backend.characters import SETS

def demo_image() -> Image.Image:
    image = Image.new("RGB", (700, 850), "#080d08")
    draw = ImageDraw.Draw(image)
    draw.line([(350, 800), (345, 600), (355, 400), (350, 120)], fill="#a9bf76", width=5)
    for x, y, length, angle in [(350, 235, 180, -.6), (350, 340, 240, .9),
                                 (350, 440, 260, -.9), (350, 550, 250, .95),
                                 (350, 670, 260, -1.05), (350, 730, 210, 1.1),
                                 (350, 160, 120, .1)]:
        def point(a, b):
            return (x + a * math.cos(angle) - b * math.sin(angle),
                    y + a * math.sin(angle) + b * math.cos(angle))
        outline = [point(math.sin(t * math.pi) * length * .23, -t * length)
                   for t in [i / 40 for i in range(41)]]
        outline += [point(-math.sin(t * math.pi) * length * .23, -t * length)
                    for t in [i / 40 for i in reversed(range(41))]]
        draw.polygon(outline, fill="#a4bd79")
        draw.line([point(0, 0), point(0, -length)], fill="#e2eaba", width=2)
        for i in range(2, 9):
            t = i / 10
            for side in (-1, 1):
                draw.line([point(0, -length * t),
                           point(side * math.sin(t * math.pi) * length * .19,
                                 -length * (t + .09))], fill="#536e3c", width=2)
    return image


def convert_image(image: Image.Image, columns: int, charset: str, custom: str,
                  brightness: float, contrast: float, saturation: float,
                  gamma: float, rotation: int, mirror: bool, invert: bool) -> dict:
    if not 40 <= columns <= 1000:
        raise HTTPException(422, "Детализация должна быть от 40 до 1000.")
    if charset not in SETS and charset != "custom":
        raise HTTPException(422, "Неизвестный набор символов.")
    chars = custom if charset == "custom" else SETS[charset]
    if not chars or len(chars) > 256 or any(ord(c) < 32 for c in chars):
        raise HTTPException(422, "Набор должен содержать от 1 до 256 печатных символов.")
    if not (-100 <= brightness <= 100 and -100 <= contrast <= 100
            and 0 <= saturation <= 200 and .3 <= gamma <= 2.5):
        raise HTTPException(422, "Параметры коррекции вне допустимого диапазона.")
    if rotation not in (0, 90, 180, 270):
        raise HTTPException(422, "Допустим поворот 0, 90, 180 или 270 градусов.")
    image = ImageOps.exif_transpose(image).convert("RGBA")
    background = Image.new("RGBA", image.size, "black")
    image = Image.alpha_composite(background, image).convert("RGB")
    if rotation:
        image = image.rotate(-rotation, expand=True)
    if mirror:
        image = ImageOps.mirror(image)
    rows = max(1, min(2000, round(columns * image.height / image.width * .5)))
    image = image.resize((columns, rows), Image.Resampling.LANCZOS)
    image = ImageEnhance.Color(image).enhance(saturation / 100)
    factor = (259 * (contrast * 2.55 + 255)) / (255 * (259 - contrast * 2.55))
    lut = [round(255 * (max(0, min(255, factor * (v - 128) + 128 + brightness * 2.55)) / 255) ** (1 / gamma)) for v in range(256)]
    image = image.point(lut * 3)
    lines, colors = [], []
    pixels = image.tobytes()
    for y in range(rows):
        line = ""
        for x in range(columns):
            offset = (y * columns + x) * 3
            r, g, b = pixels[offset:offset + 3]
            light = (.2126 * r + .7152 * g + .0722 * b) / 255
            if invert:
                light = 1 - light
            line += chars[min(len(chars) - 1, int(light * len(chars)))]
            colors.append(f"#{r:02x}{g:02x}{b:02x}")
        lines.append(line)
    return {"columns": columns, "rows": rows, "lines": lines, "colors": colors,
            "text": "\n".join(lines), "row_limit_reached": rows == 2000}


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/demo")
def demo():
    from fastapi.responses import Response
    data = io.BytesIO()
    demo_image().save(data, "PNG")
    return Response(data.getvalue(), media_type="image/png")


@app.post("/api/convert")
def convert(file: UploadFile | None = File(None), columns: int = Form(160),
            charset: str = Form("classic"), custom: str = Form(" .:-=+*#%@"),
            brightness: float = Form(0), contrast: float = Form(20),
            saturation: float = Form(100), gamma: float = Form(1),
            rotation: int = Form(0), mirror: bool = Form(False), invert: bool = Form(False)):
    image = None
    if file:
        data = file.file.read(MAX_UPLOAD + 1)
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, "Максимальный размер файла — 20 МБ.")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as opened:
                    if opened.format not in {"PNG", "JPEG", "WEBP", "GIF", "BMP"}:
                        raise HTTPException(415, "Используйте PNG, JPG, WEBP, GIF или BMP.")
                    opened.load()
                    image = opened.copy()
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError,
                Image.DecompressionBombWarning, ValueError) as exc:
            raise HTTPException(400, "Повреждённое изображение или слишком большое разрешение (до 25 Мп).") from exc
    return convert_image(image if image is not None else demo_image(), columns, charset,
                         custom, brightness, contrast, saturation, gamma, rotation, mirror, invert)


DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html")
