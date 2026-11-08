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
| `src/phrases.ts` | Phrase detection, slicing audio and traces, alignment helpers, sparklines |
| `src/library/db.ts` | IndexedDB library: phrases plus shared video sources, sizes, cleanup |
| `src/library/saveDialog.ts` | Save phrase dialog |
| `src/library/libraryPanel.ts` | Library drawer |
| `src/library/phraseBuilder.ts` | Builds a library phrase from part of a clip |
| `src/practice/takes.ts` | Trimming takes to speech, auto-stop, running median |
| `src/practice/practiceChart.ts` | Layered chart: model, take, previous-take ghost, live line |
| `src/practice/practiceView.ts` | Practice screen: the try-again loop, take strip, starring, playback, keys |
| `src/analysisClient.ts` | One-off analysis in its own worker (for takes) |
| `src/pitchAxis.ts` | Hz ↔ semitones, note names, axis ticks and label formatting |
| `src/units.ts` | Shared axis unit setting (Semitones / Hz / Notes) |
| `src/readout.ts` | Pitch readout: hover, touch-and-hold ring, hint chip |
| `src/main.ts` | Wiring, load/cancel flow, selection, rAF loop, global keyboard handler |

## Phrase library (M1) and Practice (M2)

- **Select a phrase:** press **✂ Select phrase**, then click a phrase on the trace (phrases are detected at pauses) or drag across any part (up to 30 s). Drag the edges to adjust. **Play phrase** plays just that part.
- **Save it:** **Save phrase…** asks for a name, whether it's a **Model** (someone to sound like) or **Me**, an optional language, which Model a Me take goes with, and whether to keep the video (with its size). Short clips can be saved whole.
- **Library:** the **Library** button lists Models with their takes underneath, with trace previews, sizes and the total. **Remove video** keeps the audio and trace; **Delete** asks once. Everything stays in this browser only.
- **Practice:** open it with **Practice** on a Model in the library, or **🎙 Practice this phrase** straight from a selection. Press **● Try again**: the model plays, a 3-2-1 count-in follows, then you speak and your line draws live over the faded model. Recording stops by itself about a second after you finish, and your take (dashed) appears over the model (solid), lined up at the first sound, with your previous take as a faint ghost.
  - Each line is measured from its own speaker's typical pitch, so a low and a high voice line up by shape.
  - **▶ Model** (at 1×, 0.75× or 0.5×, pitch preserved), **▶ My take**, **▶ Model → Me**. Drag the chart to shift your take.
  - Takes are kept for the session; **★** saves one to the library (linked to its Model). If the model isn't saved yet, you're asked to save it first.
  - **Voice ranges:** one for the **Model** (starts at the range it was saved with; changing it re-traces the model and updates it in the library) and one for **My voice** (remembered; re-traces your takes and is used for the live line). Narrow the model's to ignore music in the clip, and set yours to your own voice.
  - Keys: **R** try again / stop · **M** model · **Space** my take · **1–9** pick a take · **Esc** cancel.

## Recording

Press **Record with microphone** (or **Record** in the top bar) and allow the microphone. The level meter comes
alive so you can check your mic, and recording only begins when you press **● Start recording**. While you speak,
a live pitch trace scrolls past with the timer running. **Stop** turns the recording into a WAV and shows the full trace with playback,
seeking and voice range, just like an uploaded file; **Save recording** downloads it. Up to 10 minutes (5 on phones).
Echo cancellation, noise suppression and auto gain are turned off because they distort pitch.
Microphone access needs https (GitHub Pages is) or `localhost`.

## Reading the chart: semitones and Hz

- The left axis is in **semitones from the speaker's typical pitch** ("typical" = 0 st; 12 st = 1 octave = double the Hz). The right axis shows the same gridlines in **Hz**. In Practice, **Right axis for: Model | Me** picks whose Hz scale is shown.
- **Hover** over the trace (or **touch and hold** on a phone; a ring fills while you hold) to read the exact Hz and st at that moment. In Practice it shows the model and your take side by side.
- While you edit a **voice range**, its Min and Max are drawn on the chart and the area outside is shaded.
- **Axis** switches between **Semitones**, **Hz** and musical **Notes** (remembered). **ⓘ** explains how they relate, using the clip's own numbers.

## Video

Video files show their picture beside the trace (above it on phones). One `<video>` element plays sound and picture,
so the play button, seek bar, trace clicks and shortcuts all move the video too, and they can't drift apart.
Click the video to play/pause. Audio files show no video panel.

## Voice range

Below the player: pick *Any voice* (50–800 Hz), *Lower voice* (60–300 Hz), *Higher voice* (140–500 Hz), or type a custom Min/Max.
Only pitches inside the range are traced, and audio below it is filtered out first, so a backing track's bass can't take over the line.
Changing it re-traces the loaded clip in well under a second without stopping playback. The choice is remembered in the browser.

## Keyboard

Space play/pause (a selected phrase plays just that phrase) · ←/→ 2 s · Shift+←/→ 10 s · Home/End · Esc clears the selection. Shortcuts pause while you're typing in the voice range boxes.

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

- Unit tests: 69 passing (sines at 100/220/440 Hz within ±1%, 100→300 Hz glide within ±2%, silence, noise, quiet-clip gating, post-processing steps, voice range and high-pass filter, live pitch from 48/44.1/16 kHz input, WAV encoding, mic error messages, phrase detection and slicing, take trimming and auto-stop, Hz/semitone/note conversions and axis ticks).
- Benchmark: 60 s analyzed in about 0.9 s on the build machine (budget 2 s).
- Smoke-tested in headless Chromium with a synthetic 20 s WAV: load, unsupported file, no-speech file, play/pause via Space without double-toggle, arrow jumps, click and drag seeking, seek bar, cancel then reload, phone width, dark mode. No console errors.
- Video tested in headless Chromium with a portrait YouTube Short, a landscape test video and an audio-only file, at desktop and phone widths: play button, seek bar, trace clicks, video click and Space all keep video and playhead in sync.
- Recording tested in headless Chromium with a fake microphone: live trace, level meter, Stop → trace and playback, Save downloads a valid WAV, Cancel, too-short recording, no microphone.
- Library tested in headless Chromium: select, save (one video shared by two phrases), record and link a take, library sizes, remove video, delete, reload.
- Chart aids tested in headless Chromium: hover readout values, touch-and-hold via real touch events (ring, readout, no seek; quick tap still seeks), range guides, Hz/Notes axes, explainer, Practice Model/Me axis.
- Practice tested in headless Chromium with a fake microphone: full try-again loop with auto-stop, live line, playback at 0.75×, shifting, starring an unsaved model's take, un-starring, keys, library entry points, reload.
- Voice range tested in headless Chromium on a real music-backed clip: switching presets mid-playback, custom values, invalid input, keyboard isolation, remembered setting.

## Still to do for M0 sign-off

- Real speech fixtures with Praat reference pitch (`tests/fixtures/`) and the < 5% gross-error check.
- Click-track fixture to measure `TRACE_OFFSET_SECONDS` per browser and format.
- Manual testing in Firefox, Safari (macOS, iOS) and Chrome Android, including MOV and WebM decoding, the mobile memory limits, and recording with real microphones (permission prompts, Bluetooth headsets).
