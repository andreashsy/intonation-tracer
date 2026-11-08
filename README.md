# Intonation Tracer — Milestone 0

Upload an audio or video file, or record from your microphone, then see its pitch trace and play it back with a synced playhead.
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
npm run build      # static files in dist/ (see Deploy to GitHub Pages below)
```

## How it fits together

```
file ─▶ decoder (16 kHz mono) ─▶ pitch.worker (YIN + post-processing) ─▶ PitchTrack
  └─▶ <video> via object URL ─▶ player (smoothed time) ─▶ traceView + seekBar (rAF loop)
```

| File | What it does |
|---|---|
| `src/config.ts` | Every tunable number: YIN, voicing, gate, view, limits, trace offset |
| `src/yin.ts` | Pure YIN estimator for one frame |
| `src/postprocess.ts` | Gate + voicing, octave fix, median filter, short-run removal |
| `src/analyze.ts` | High-pass below the voice range, framing loop (skips YIN on gated frames); shared by worker and tests |
| `src/pitch.worker.ts` | Worker entry; receives a copy of the audio (kept for re-analysis), transfers results back |
| `src/decoder.ts` | Decode straight to 16 kHz, with OfflineAudioContext fallback |
| `src/player.ts` | `<video>` wrapper (audio files too) with an interpolated, monotonic clock |
| `src/traceView.ts` | Two-canvas drawing (trace + playhead), click/drag to seek |
| `src/seekBar.ts` | Slider and time labels; seeks on release |
| `src/voiceRange.ts` | Voice range menu and Min/Max inputs, validation, remembered choice |
| `src/fileInput.ts` | Drop zone, picker, type check |
| `src/recorder.ts` | Microphone capture through an inlined AudioWorklet; permission error messages |
| `src/livePitch.ts` | Streaming resample to 16 kHz + YIN for the live trace |
| `src/liveView.ts` | Scrolling live trace while recording |
| `src/wav.ts` | 16-bit mono WAV encoding |
| `src/main.ts` | Wiring, load/cancel flow, rAF loop, global keyboard handler |

## Recording

Press **Record with microphone** (or **Record** in the top bar). While you speak, a live pitch trace scrolls past,
with a level meter and timer. **Stop** turns the recording into a WAV and shows the full trace with playback,
seeking and voice range, just like an uploaded file; **Save recording** downloads it. Up to 10 minutes (5 on phones).
Echo cancellation, noise suppression and auto gain are turned off because they distort pitch.
Microphone access needs https (GitHub Pages is) or `localhost`.

## Video

Video files show their picture beside the trace (above it on phones). One `<video>` element plays sound and picture,
so the play button, seek bar, trace clicks and shortcuts all move the video too, and they can't drift apart.
Click the video to play/pause. Audio files show no video panel.

## Voice range

Below the player: pick *Any voice* (50–800 Hz), *Lower voice* (60–300 Hz), *Higher voice* (140–500 Hz), or type a custom Min/Max.
Only pitches inside the range are traced, and audio below it is filtered out first, so a backing track's bass can't take over the line.
Changing it re-traces the loaded clip in well under a second without stopping playback. The choice is remembered in the browser.

## Keyboard

Space play/pause · ←/→ 2 s · Shift+←/→ 10 s · Home/End. Shortcuts pause while you're typing in the voice range boxes.

## Deploy to GitHub Pages

The repo includes `.github/workflows/deploy.yml`, which tests, builds and publishes `dist/` on every push to `main`.

1. **Push** this folder to a GitHub repository (any name), with `main` as the default branch.
2. **Turn on Pages:** repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. **Run it:** push to `main`, or open **Actions → Deploy to GitHub Pages → Run workflow**.
   The site appears at `https://<user>.github.io/<repo>/`; the link is also on the workflow run.
4. **Commit the lockfile:** after your first local `npm install`, commit `package-lock.json`.
   The workflow uses `npm ci` when it's there (faster, exact versions) and falls back to `npm install` until then.

**Base path:** `vite.config.ts` uses `base: './'`, so the build works under any repo name, at a domain root,
or on a custom domain without changes.

**Build checks:** the workflow fails before deploying if the unit tests or type check fail, if the pitch worker
chunk is missing from `dist/assets`, or if `index.html` has root-absolute (`/…`) asset paths.

**Check the worker once on the live site:** open the site, load a short clip and confirm the trace appears.
In DevTools → Network, `pitch.worker-<hash>.js` should load with status 200 from under `/<repo>/assets/`.

## Status

- Unit tests: 42 passing (sines at 100/220/440 Hz within ±1%, 100→300 Hz glide within ±2%, silence, noise, quiet-clip gating, post-processing steps, voice range and high-pass filter, live pitch from 48/44.1/16 kHz input, WAV encoding, mic error messages).
- Benchmark: 60 s analyzed in about 0.9 s on the build machine (budget 2 s).
- Smoke-tested in headless Chromium with a synthetic 20 s WAV: load, unsupported file, no-speech file, play/pause via Space without double-toggle, arrow jumps, click and drag seeking, seek bar, cancel then reload, phone width, dark mode. No console errors.
- Video tested in headless Chromium with a portrait YouTube Short, a landscape test video and an audio-only file, at desktop and phone widths: play button, seek bar, trace clicks, video click and Space all keep video and playhead in sync.
- Recording tested in headless Chromium with a fake microphone: live trace, level meter, Stop → trace and playback, Save downloads a valid WAV, Cancel, too-short recording, no microphone.
- Voice range tested in headless Chromium on a real music-backed clip: switching presets mid-playback, custom values, invalid input, keyboard isolation, remembered setting.

## Still to do for M0 sign-off

- Real speech fixtures with Praat reference pitch (`tests/fixtures/`) and the < 5% gross-error check.
- Click-track fixture to measure `TRACE_OFFSET_SECONDS` per browser and format.
- Manual testing in Firefox, Safari (macOS, iOS) and Chrome Android, including MOV and WebM decoding, the mobile memory limits, and recording with real microphones (permission prompts, Bluetooth headsets).
