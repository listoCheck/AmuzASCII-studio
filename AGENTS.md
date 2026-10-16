# AmuzASCII — agent guide

Read this file first. It is a navigation guide, not a substitute for the current code or the user's request. Read only the relevant files below; do not load the entire repository or the conversation history to understand one change.

## Project and commands

AmuzASCII is a Vue 3/Vite ASCII image/video editor served by Python FastAPI. Public project name: **AmuzASCII**; npm package: `amuzascii`. The checkout directory may have a legacy name; do not rename the checkout or change editor configuration as part of ordinary work. Repository: https://github.com/listoCheck/AmuzASCII-studio/tree/master.

Run commands from the repository root:

```sh
npm --prefix frontend ci                 # only when dependencies are missing/changed
npm --prefix frontend run build          # production bundle served by FastAPI
npm --prefix frontend run dev            # Vite :5173; /api proxies to :8000
python run.py                            # FastAPI :8000 with reload
python -m pip install -r requirements-dev.txt  # install test dependencies when needed
python -m pytest backend -q
npm --prefix frontend test
```

Use the existing Python virtual environment. On Windows: `.venv/Scripts/python.exe` and, if PowerShell blocks npm, `npm.cmd`. On Unix: `.venv/bin/python`. `frontend/dist` is generated and excluded from Git; rebuild it to verify production UI changes, never edit its assets. Docker: `docker compose up --build -d`; validate configuration with `docker compose config --quiet`.

## Read by task

| Task | Start here |
| --- | --- |
| UI, header, dialogs, sidebar sections, player controls | `frontend/src/App.vue` |
| Media lifecycle, render scheduling, worker handoff, playback, server video jobs/downloads | `frontend/src/useEditor.js` |
| Image algorithms, character/color palettes, geometry | `frontend/src/ascii.js` |
| Worker rendering, WebGL2, glyph atlas, SVG scheduling data | `frontend/src/preview.worker.js` |
| Glyph metrics, letter brightness, SVG eligibility/output | `frontend/src/typography.js`, `frontend/src/svgPreview.js` |
| Layout/responsiveness | `frontend/src/style.css` |
| Themes, themed inputs/scrollbars/steppers, header metrics styling | `frontend/src/themes.css` |
| Browser metrics collection and GitHub button | `frontend/src/BrowserMetrics.vue` |
| Appearance dialog, themes/preferences persistence | `frontend/src/AppearancePanel.vue`, `frontend/src/preferences.js` |
| UI translations | `frontend/src/i18n.js`, `frontend/src/locales/en.json` |
| Preset schema/defaults, JSON validation, persistence | `frontend/src/presets.js`, `frontend/src/usePresets.js`, `presets/` |
| Image export formats/filenames | `frontend/src/export.js`, image export handlers in `useEditor.js` |
| Clipboard image input | `frontend/src/clipboard.js`, paste handler in `useEditor.js` |
| Backend image API/demo/static serving | `backend/main.py`, `backend/characters.py` |
| Video import, temporary storage, job queue/status/download/source routes | `backend/videos.py` |
| PyAV decoding/encoding, timestamps/audio, ASCII frame rendering | `backend/video_render.py` |
| Container setup | `Dockerfile`, `compose.yaml`, `.env.example` |
| User documentation | `README.md` (RU), `README.en.md` (EN), `docs/guide.md` (RU) |

Search for the target symbol with `rg -n` and read a bounded section. Read the paired frontend/backend implementation only when changing a shared contract. Do not scan `node_modules`, `.venv`, `dist`, caches, screenshots, or lockfiles to locate application behavior.

## Data flow and invariants

### Photos and preview

- Photos stay in the browser. Live slider changes must not call `/api/convert`; that is an independent backend image API. `/api/demo` supplies the initial sample.
- Input -> `useEditor` -> worker -> Canvas/LIVE or SVG overlay. Work is coalesced; stale worker frames and replaced media must not overwrite newer results. Close transferred bitmaps, revoke object URLs, and cancel timers/listeners on release/unmount.
- Detail is **40–1000 columns**; rows follow source proportions, maximum 2000. Preserve aspect ratio and keyboard/slider synchronization.
- SVG is enabled only when glyphs have sufficient visible pixel size (`canUseVectorPreview`). Dense grids retain the filtered LIVE frame after slider release to prevent moiré/aliasing. Do not force SVG at high detail or enlarge a low-resolution glyph atlas.
- Character brightness is **0–300%, default 120%**; it changes ink only, not background or the glyph selection ramp. Preserve it in presets and exports.
- The original-colors palette button switches `colorMode` to `original`; it must not reset unrelated corrections.

### Video

- Browser playback is an ASCII **preview** with seek, sound, speed, preview FPS, loop, fullscreen. Frame delivery uses `requestVideoFrameCallback` with rAF fallback and a bounded worker queue. Pausing/seeking must redraw the current frame.
- **Export is always backend processing of the complete clip**, independent of playback position, speed, and preview FPS. Never restore MediaRecorder/captureStream export, time limits, dropped frames, or fragment downloads.
- Routes: `POST /api/videos`; `GET /api/videos/{id}/poster`; `GET /api/videos/{id}/source` (Range/seek); `POST /api/videos/{id}/jobs`; `GET /api/video-jobs/{id}`; `GET /api/video-jobs/{id}/download`.
- Settings are captured at job submission. Decode to EOF, retain VFR timestamps and all frames/audio tracks, flush encoders/resamplers, then atomically publish the output. Errors must remove incomplete output; downloads before completion return 409.
- MP4 = H.264/AAC; WebM = VP9/Opus. Audio is re-encoded to stereo; preserve content/duration. Output preserves source resolution, rounded up to even sides for YUV420 and adjusted for rotation.
- `AsciiFrames` caches color/alpha blend tables to avoid full-frame float color buffers. Optimizations must preserve pixel rounding and antialiasing; float-reference regression tests cover all color modes.
- Jobs continue when the page closes. `AmuzASCII.videoJob.v1` restores active job state; the source endpoint restores preview after reload. Upload/result retention is temporary; never treat localStorage as media storage.
- Current limits: video uploads 250 MB, photos 20 MB / 25 MP; one active encoding worker and at most three queued/processing jobs. No output-size/duration truncation.
- `AMUZASCII_VIDEO_DIR` controls temporary storage; `AMUZASCII_FONT` selects a font. Docker uses `/data` for storage and multipart spooling (`TMPDIR`), DejaVu fonts, non-root user, read-only root filesystem. Do not move uploads into the small `/tmp` tmpfs.

### UI and saved state

- Export settings belong to the upper-right **Export** dialog. Show processing and download progress there, with current stage also on the header button. Keep export controls out of the sidebar/player.
- Sidebar sections 01/02 remain expanded; sections starting with 03 are collapsible.
- Main header contains identity/tagline, compact metrics, GitHub button, language/appearance controls, and Export. Keep it responsive without overlaps.
- Use theme variables (`--ink`, `--line`, `--ui-field`, `--ui-accent`, etc.) for new UI. Preserve Cyberpunk's distinct appearance; do not apply neon-only changes globally.
- Source strings are Russian; `t(...)` resolves English through `locales/en.json`. Add translations for new visible labels, tooltips, notices, and errors. The interface test checks coverage.
- Metrics are render latency, main-thread long tasks over a 2-second window, and optional JS heap. They are **not CPU/GPU usage**. Show unavailable values as “—”; stop collection for video/unmount. Do not invent unsupported measurements.
- Preserve existing localStorage keys and version-1 preset compatibility; validate imported JSON through the schema. Avoid resetting saved preferences/presets during unrelated changes.

## Verification and efficient changes

- Start with `git status --short`; preserve unrelated edits, untracked user files, `.idea`, and virtual environments. Do not reset the checkout, commit, push, or publish unless requested.
- UI changes: production build; run frontend tests when behavior/translations/presets/rendering change. Inspect layout at relevant desktop/mobile sizes. Use a separate test port (e.g. 8021); do not stop a user's existing server.
- Rendering changes: relevant `ascii.test.js`, `interface.test.js`, `presets.test.js`; with Vite running, open `/tests/preview.html` for browser GPU/CPU comparisons, sharpness, brightness, grids, and banding.
- Video/backend changes: `pytest backend -q`. `test_video.py` generates real fixtures and verifies full MP4/WebM output, audio, VFR timing, failure cleanup, incomplete-download rejection, Range support, and compositor parity. Benchmark before/after on identical inputs; do not trade quality or completeness for speed without a user request.
- Docs-only changes need link/path/command checks, not full render/video suites. Keep the two READMEs aligned and use relative screenshot links. Source files are UTF-8.
- Scale verification to the change; do not add tests that merely assert implementation text or repeatedly run unchanged checks. Report what changed, relevant checks, and concrete limitations briefly.
