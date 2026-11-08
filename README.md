# Intonation Tracer — Milestone 0

Upload an audio or video file, see its pitch trace, and play it back with a synced playhead.
Everything runs in the browser; nothing is uploaded anywhere.

Spec: *intonation-tracer-m0-upload-player-spec.md* (in the project docs).

## Run it

Requires Node 22.18 or later.

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Node's built-in runner, no extra deps)
npm run bench      # analysis speed on 60 s of synthetic audio
npm run typecheck
npm run build      # static files in dist/, deployable to any static host
```

## How it fits together

```
file ─▶ decoder (16 kHz mono) ─▶ pitch.worker (YIN + post-processing) ─▶ PitchTrack
  └─▶ <audio> via object URL ─▶ player (smoothed time) ─▶ traceView + seekBar (rAF loop)
```

| File | What it does |
|---|---|
| `src/config.ts` | Every tunable number: YIN, voicing, gate, view, limits, trace offset |
| `src/yin.ts` | Pure YIN estimator for one frame |
| `src/postprocess.ts` | Gate + voicing, octave fix, median filter, short-run removal |
| `src/analyze.ts` | Framing loop (skips YIN on gated frames); shared by worker and tests |
| `src/pitch.worker.ts` | Worker entry; transfers buffers both ways |
| `src/decoder.ts` | Decode straight to 16 kHz, with OfflineAudioContext fallback |
| `src/player.ts` | `<audio>` wrapper with an interpolated, monotonic clock |
| `src/traceView.ts` | Two-canvas drawing (trace + playhead), click/drag to seek |
| `src/seekBar.ts` | Slider and time labels; seeks on release |
| `src/fileInput.ts` | Drop zone, picker, type check |
| `src/main.ts` | Wiring, load/cancel flow, rAF loop, global keyboard handler |

## Keyboard

Space play/pause · ←/→ 2 s · Shift+←/→ 10 s · Home/End.

## Status

- Unit tests: 25 passing (sines at 100/220/440 Hz within ±1%, 100→300 Hz glide within ±2%, silence, noise, quiet-clip gating, post-processing steps).
- Benchmark: 60 s analyzed in about 0.9 s on the build machine (budget 2 s).
- Smoke-tested in headless Chromium with a synthetic 20 s WAV: load, unsupported file, no-speech file, play/pause via Space without double-toggle, arrow jumps, click and drag seeking, seek bar, cancel then reload, phone width, dark mode. No console errors.

## Still to do for M0 sign-off

- Real speech fixtures with Praat reference pitch (`tests/fixtures/`) and the < 5% gross-error check.
- Click-track fixture to measure `TRACE_OFFSET_SECONDS` per browser and format.
- Manual testing in Firefox, Safari (macOS, iOS) and Chrome Android, including MOV and WebM decoding and the mobile memory limits.
