<div align="center">

<img src="frontend/public/assets/favicon.svg" width="64" height="64" alt="AmuzASCII logo">

# AmuzASCII

### From pixels to characters.

A local ASCII art studio for images and videos.<br>
Choose your characters, experiment with colors, and preview adjustments in real time.

**[Русский](README.md) · English · [GitHub repository](https://github.com/listoCheck/AmuzASCII-studio/tree/master)**

![Vue 3](https://img.shields.io/badge/Vue_3-42b883?style=flat-square&logo=vuedotjs&logoColor=white)
![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-3776ab?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white)
![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ed?style=flat-square&logo=docker&logoColor=white)
![RU / EN](https://img.shields.io/badge/Interface-RU_%2F_EN-8b5cf6?style=flat-square)

[Features](#features) · [Screenshots](#screenshots) · [Getting started](#getting-started) · [Development](#development)

</div>

![AmuzASCII image editor in a light theme](docs/screenshots/editor.png)

## Features

Images are processed locally in your browser. Videos have a live ASCII player for previewing effects; complete video exports are processed by the Python backend.

| | Controls |
| :--- | :--- |
| **Characters** | **40–1000 columns**, using a slider or keyboard input. 14 built-in character sets, including Braille, plus a custom character ramp. |
| **Color** | 15 palettes, original photo colors, monochrome mode, and custom foreground/background colors. Restore original colors with one click. |
| **Adjustments** | Brightness, contrast, saturation, gamma, inversion, rotation, and mirroring. Separate **character brightness from 0–300%** below the canvas. |
| **Video** | ASCII playback with seeking, volume, speed, preview FPS, looping, and fullscreen. Complete backend exports with processing and download progress. |
| **Presets** | Built-in corrections, saved presets, and JSON import/export. The last settings are restored automatically. |
| **Appearance** | **12 themes**, including Cyberpunk and two neon themes. Customize accent color, density, text size, panel width, and corners. **English and Russian** interfaces. |
| **Browser metrics** | Preview render time, main-thread long-task blocking, and JavaScript heap usage where supported. |

### Export formats

Use **Export** in the upper-right corner to open the export dialog.

| Format | Use |
| :--- | :--- |
| **PNG** | Lossless image. |
| **JPEG / WebP** | Smaller files with adjustable quality. |
| **SVG** | Scalable vector characters. |
| **TXT** | Plain ASCII text. |
| **HTML** | Standalone page with colored ASCII art. |
| **MP4 / WebM** | Complete server-rendered video: H.264/AAC or VP9/Opus. |

Video export always includes the **entire clip**, preserving all frames and original timestamps, including variable frame rates. Audio tracks are re-encoded as stereo AAC or Opus. Seeking, playback speed, and preview FPS do not trim or change the exported video. Settings are captured when export starts.

A download becomes available only after successful encoding. If processing fails, the unfinished file is removed rather than delivered as a partial clip. Progress first shows processed frames, then download percentage and transferred megabytes. You can close the export dialog and keep previewing; the top Export button shows the current stage.

## Screenshots

### Neon City

Interface themes and ASCII artwork colors are independent.

![Neon theme with colorful ASCII artwork](docs/screenshots/neon.png)

### Video preview and backend export

Preview and adjust your video in the player, then export the full clip. Playback is not required for backend conversion.

![ASCII video player](docs/screenshots/video.png)

<sub>Screenshots were captured in the application using demonstration material.</sub>

## Getting started

```bash
git clone https://github.com/listoCheck/AmuzASCII-studio.git
cd AmuzASCII-studio
```

### Docker Compose

Requires Docker with Linux container support and Compose v2. From the repository root:

```bash
docker compose up --build -d
```

Open **[http://127.0.0.1:8000](http://127.0.0.1:8000)**. Docker builds the Vue frontend and starts the Python server.

```bash
docker compose logs -f web   # application logs
docker compose down         # stop
```

To change the port, copy `.env.example` to `.env` and set, for example, `AMUZASCII_PORT=8080`. The default configuration binds to localhost. The `/data` volume holds temporary video uploads and results; it also provides multipart spool space when the container root filesystem is read-only.

### Local installation

**Requirements:** Python **3.11+**, Node.js **20.19+ or 22.12+**, and npm.

Build the frontend first: `frontend/dist` is excluded from Git.

**Windows / PowerShell**, from the project root:

```powershell
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend run build

python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe run.py
```

<details>
<summary><b>macOS / Linux</b></summary>

```bash
npm --prefix frontend ci
npm --prefix frontend run build

python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python run.py
```

</details>

Open **[http://127.0.0.1:8000](http://127.0.0.1:8000)**. Press `Ctrl+C` to stop the server.

## Your first ASCII artwork

1. Drop an image or video onto the canvas, use **Upload photo or video**, or paste a copied image with **Ctrl+V / ⌘V**.
2. Choose detail level, characters, and a color palette.
3. Adjust the controls on the right and character brightness below the canvas.
4. Save your settings as a preset or use **Export** to download the result.

For video, start with 80–160 columns. Use the player to preview any position; export via the upper-right button. Choose MP4 or WebM and start processing. The complete result downloads automatically and can be downloaded again. Reloading or closing the page does not stop an active backend job. Its status and player source are restored while the temporary server data remains available.

## How it works

**Vue 3 + Vite** provide the interface. A **Web Worker** handles preview rendering outside the main thread. After a short pause, clearly visible characters use an **SVG text preview**. Dense grids retain a filtered LIVE frame to avoid moiré when the slider is released. Intermediate previews use font rendering or **WebGL2**, with Canvas fallback.

**FastAPI + Pillow** serve the application, demo image, and image API. **PyAV + NumPy + Pillow** convert videos in a background job while preserving the source timeline and audio. Cached color/alpha lookup tables avoid large floating-point color buffers for every frame. Decoding uses up to four threads. The optimization retains the same rendered pixels, frame count, and resolution.

Browser metrics show the last preview render time (including worker latency), main-thread tasks lasting at least 50 ms as a share of the last two seconds, and the JavaScript heap when exposed by the browser. Missing metrics show **—**. These are not total CPU/GPU usage: heap data excludes workers, GPU allocations, and other browser processes. Hover over a metric for its definition.

Settings and presets are stored in `localStorage`; media files are not part of presets. Use JSON to transfer presets between browsers.

### Limits and notes

- Images: up to **20 MB** and **25 megapixels**. Videos: up to **250 MB**. Browser preview codec support varies; a video without browser preview can still be exported by the backend.
- Detail means columns; rows follow the source aspect ratio, up to **2000**.
- A character may occupy less than one screen pixel at high detail. Zoom in to inspect its shape.
- Video speed depends on the server, codec, resolution, and detail level. Processing always reads the complete clip.
- Interface fonts are loaded from Google Fonts, with system fallbacks offline. Server rendering requires a monospace font: Consolas on Windows, DejaVu Sans Mono in Docker. `AMUZASCII_FONT` can select a font explicitly.
- Images stay in the browser; videos are uploaded to the server. Inactive uploads/results older than an hour are cleaned up on subsequent API requests. Active jobs are retained. Previous temporary results are unavailable after a server restart.

## Development

For AI-assisted development, start with [AGENTS.md](AGENTS.md): a code map, rendering invariants, and verification commands.

Run the Python backend, then start Vite in a second terminal:

```bash
npm --prefix frontend run dev
```

Open **[http://127.0.0.1:5173](http://127.0.0.1:5173)**. Vite proxies `/api` to `127.0.0.1:8000`. On Windows, use `npm.cmd` if required.

```text
backend/                 FastAPI, image conversion, and background video jobs
frontend/src/            Vue, renderer, themes, translations, and exports
frontend/tests/          Browser rendering checks
presets/                 Built-in adjustment presets in JSON
docs/                    Detailed guide and screenshots
Dockerfile               Frontend and Python application build
compose.yaml             Docker Compose configuration
run.py                   Local server entry point
```

### Checks

In an activated Python environment, from the repository root:

```bash
python -m pip install -r requirements-dev.txt
python -m pytest backend -q
npm --prefix frontend test
npm --prefix frontend run build
```

With Vite running, open the **[browser rendering checks](http://127.0.0.1:5173/tests/preview.html)** to verify adjustments, glyph sharpness, brightness, grid preservation, and horizontal banding.

More details on themes, settings, APIs, and video processing are available in the **[Russian guide](docs/guide.md)**. Source code: **[listoCheck/AmuzASCII-studio](https://github.com/listoCheck/AmuzASCII-studio/tree/master)**.
