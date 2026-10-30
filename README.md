# OpenDJ (beta)

A two-deck DJ app for your own music and Creative Commons tracks, with yt-dlp built in.

> **This is a development build with the license gate removed.** Downloads are not license-checked, and tracks
> record whatever license yt-dlp reports (or none, shown as UNCHECKED). It uses its own data folder
> (`%APPDATA%\Commons DJ NoGate`), so it doesn't touch the main app's library. The removed features and their
> known problems are written up in `docs/license-gate-features/`, to be put back one at a time.
>
> The search is also a **plain YouTube search** here (no Creative Commons filter, up to 50 results in YouTube's
> order), with a details strip showing exactly what was searched and an **Expand** button for more room. The
> search problems are written up in `docs/search-issues/`.

## What's new in 0.3.10-beta

- Track drops prepare waveforms, beat data and scratch samples in a background worker. The interface stays responsive while full-length stereo songs load, and failed or stalled preparation reports an error instead of switching to heavy work on the UI thread.
- New AI stem separation starts only when you click **Prepare AI stems**, one loaded track at a time. Cached AI stems still load automatically; the instant stem controls work while new AI stems are unprepared.
- Added a full-length stereo drag-and-drop regression with rapid track replacement, plus worker recovery, timeout and sample-transfer tests. Run it with `npm run test:load`.

## What's new in 0.3.9-beta

- Tempo changes and nudges preserve the current playback position. Enabling key processing or loading AI stems no longer starts a cued deck before its scheduled beat.
- Match compensates the tuning of both recordings, including records recorded slightly sharp or flat. Key analysis refreshes once on first load. Match updates pitch and lock together.
- Sync respects manually set grids, listens to the section actually playing after a seek, and honours a forced ratio when the playing deck leads. It shows **TEMPO** if it can keep tempo but has lost beat alignment; press twice to retry after checking the grid.
- Rapid track loads keep the latest selection. Losing window focus releases nudges. Four-deck peak meters work on C and D. An unreadable or damaged library is left untouched and reported at startup.
- Playback regression checks now cover the real engine, renderer and IPC, with audio alignment tests that fail when timing exceeds their limits. The Windows build tooling no longer includes the vulnerable ZIP extractor.

## What's new in 0.3.8-beta

- **Sync rebuilt from scratch.** Every synced deck locks to one shared clock (the way Mixxx and Ableton Link do it), and a phase lock keeps them together with tiny, inaudible speed trims, so decks never drift apart. Sync picks ½×, 1× or 2× once (the ratio button: Auto / ½× / 1× / 2×) and never flips it mid-mix.
- **Synced decks stay synced** through play from pause (a cued deck comes in on the next beat, or the next bar when cued on beat 1), hot cues, seeking, loops, key lock, tempo moves and the space bar. Nudges stick.
- **New beat detection.** Tempo is read far more reliably (92% of the test library within 1% of the published tempo, up from 66%), beat grids are fitted through the whole track (no drift), open hi-hats no longer put the grid on the off-beat, and the other likely tempo readings are kept. Older grids are re-analysed the first time a track is loaded, unless you set them by hand. Analysis runs in the background.
- **Engine timing:** audio runs at 48 kHz (was the device's 192 kHz), every start and jump is scheduled sample-exactly, and key-locked decks no longer slip when their tempo changes.
- **Load over a playing deck**, dials reset on load, and the tempo-range picker is gone from under the slider.
- **Sync listens.** Pressing Sync weighs every tempo reading the analysis found (a triplet or half-time feel can be read at the wrong level) against how firmly each grid sits on the track's hits, and picks the one that needs the least stretching. It then checks where each track's hits really fall: a grid that sits clearly off its music is corrected on joining, and a track that drifts against its own grid (a live drummer) is followed in inaudible steps. Sync also stays on when you load a new track onto a synced deck.
- **Key Match by ear.** Match compares the notes the two tracks actually play and picks the shift where they agree best, instead of trusting key names.
- **Accurate keys.** Key detection measures each track's tuning and weighs notes at their true loudness: on a set of songs with known keys it gets 9 of 11 exact and the other 2 one step away (was 4 exact). Keys are found again the first time each track is loaded.
- **Three-colour waveforms**, as in djay and Serato: bass in red, mids in amber, highs in white, so kicks, snares and hats are easy to tell apart.
- **Smoother look:** softer panels, rounder corners, quieter controls, tinted hot cues and stem dots; Sync lights up in the deck colour.
- Tests: `npm test` (analysis + sync clock), `electron --background test/sync-harness/run.cjs` (measures what each deck actually plays: 0 ms error in all 10 scenarios) and `electron --background test/library-eval.cjs` (tempo accuracy against `test/ground-truth.json`).

## What's new in 0.3.7-beta

- **Fixed: crash when a new track starts AI stems** (for example when you drag a song in). The AI stem runtime now ships next to the app instead of inside it, so Windows no longer loads its own older onnxruntime.dll by mistake.

## What's new in 0.3.6-beta

- **Music video in the middle:** 2 decks put it in a rounded cutout at the top centre above the crossfader; 4 decks put it in a large square where the four decks' inner corners meet, over the XY pad.
- **Waveforms** scroll at the same speed on every deck (16 seconds shown by default; **Settings → Seconds shown**).
- **Snap** lands on the nearest grid line drawn on the waveform (down to ⅛ or ⅟₁₆ beat when zoomed in), lined up with the other deck.
- **Sync** fixes tracks read at ¾ of their tempo (like 112 vs 150): the slower BPM is corrected by 4⁄3 and saved, then the decks sync at normal speed.

## What's new in 0.3.4-beta

- **Snap to beat:** Off / 1 / 1/2 / 1/4. Dragging the waveform, record or overview, and pressing play, land on the nearest step lined up with the other deck.
- **Zoom in beats:** waveform zoom is set as beats shown (4–64, in Settings; `-` / `+` halve or double it), so synced decks line up beat for beat.
- **4-deck XY pad:** in 4-deck mode the crossfader becomes an XY pad (A B on top, C D at the bottom). Compact decks hide the artist line to fit.
- **Hot cues** show their timestamp on the pad and stay visible in 4-deck mode.
- **DROP removed:** the Drop button, V / N keys and riser are gone.

## What's new in 0.3.3-beta

- **Mist theme:** a softer bright theme (soft grey, off-white panels, slate text) in **⚙ Settings**.
- **Fullscreen** (button and F11) now fullscreens the app window, so the Settings dialog stays on top instead of getting stuck behind the page.
- **Tidier Settings:** theme cards fit on one row, with more space between sections.
- **Clean key lock:** key lock and key shift use Signalsmith Stretch, so changing the tempo with key lock on no longer warbles. Its delay is compensated, so sync, loops and Drop stay on the beat.
- **Sync locks tempos:** press **Sync** and the decks stay tempo-locked. Change either one's tempo and the other follows. Press **Sync** again (or load a new track) to unlock.

## What's new in 0.3.2-beta

- **4 decks:** every deck keeps its key row (key readout, key shift, Lock and **Match**) in 4-deck mode; waveforms and mixer faders are a little shorter so the library still fits.

## What's new in 0.3.1-beta

- **4 decks:** ⚙ Settings → Decks switches between 2 and 4 decks. C and D get their own waveform, deck and mixer channel (mixer order C · A · B · D); A and C play on the crossfader's left, B and D on its right. Sync and Match follow a playing deck on the other side.
- **Settings → Audio & display:** pick the output device (headphones, speakers, HDMI…), master volume, and fullscreen (also F11).
- **Spotify search fixed:** Spotify now returns at most 10 results per request; searches page through 50 again, and Spotify's own error text is shown if something's wrong.
- **Polish:** empty decks dim their controls, decks C and D fade in, smoother scrolling.

## What's new in 0.3.0-beta

- **Look:** one clean theme set, picked in **⚙ Settings**: Midnight (dark), Aloe (bright green) and Cherry. Cherries throughout.
- **Records:** a turntable on each deck you can grab and scratch, with real scratch sound. Dragging the waveform scratches too; a flick on a paused deck glides.
- **Bars and sync:** time signature (3/4 or 4/4) and beat 1 are detected per track; **Sync** lines up bars, not just beats. A bar counter shows where you are (`bar 3 · ●●●○`), and **Beat 1** / **4/4** fix the grid by hand.
- **DROP** (V / N): one press builds up over the next bar or two (loop roll 1 → ⅛ beat, high-pass sweep, noise riser) and drops on beat 1, with the track carrying on exactly in time (slip mode). Press again to cancel.
- **SFX tab:** ten dubstep / dariacore one-shots (air horn, dub siren, laser, sub drop, wobble, riser, rewind and more), synthesized live, optionally quantized to the beat.
- **AI stems:** real model-separated vocals / drums / instruments. With an NVIDIA GPU and the optional PyTorch setup (see `src/stems-gpu.py`), MelBand RoFormer + HT-Demucs fine-tuned run on the GPU (~1 minute per track); otherwise HT-Demucs runs on the CPU (**Get AI stems** downloads its model). DSP stems stay as the instant fallback.
- **Search:** a **YouTube / Spotify** switch. Spotify searches the catalogue (needs a free app key) and fetches the matching YouTube upload for the audio.
- **Space bar** pauses everything and resumes the same decks; smoother zoom, animations, and a desktop launcher (`Start OpenDJ.cmd`).

## Running it (Windows on ARM)

1. Unzip `CommonsDJ-win-arm64.zip` somewhere you keep apps, such as `Documents\Apps\Commons DJ`.
2. Double-click **Commons DJ.exe**.
3. The app isn't code-signed, so Windows SmartScreen will warn you the first time. Click **More info → Run anyway**.

Your library and downloads live in `%APPDATA%\Commons DJ` (the **Open download folder** button takes you there).

## What it does

- **Two decks** with play/cue, 4 hot cues, beat loops (1/2/4/8), tempo slider (±8/16/50%), nudge, and **SYNC** that matches tempo and beat phase.
- **Automatic BPM and beat grid** detection on first load, with ÷2 / ×2 / TAP / BEAT to fix the grid by hand.
- **Key detection** (Camelot + key name), **key shift** (♭/♯ without changing tempo), **key lock** (tempo without changing pitch) and **MATCH** to put a deck in the other deck's key.
- **Stems**: turn vocals, drums or instruments on and off per deck in real time (DSP separation, approximate — see `docs/new-features/key-and-stems.md`).
- **AI stems (prototype)**: with the HT-Demucs model and ONNX Runtime installed, click **Prepare AI stems** to process the loaded tracks one at a time. Cached stems load automatically, and the stem buttons switch to the AI stems when ready — see `docs/new-features/ai-stems-plan.md`.
- **Mixer** with trim, 3-band EQ (kills at the bottom), one-knob filter (left = low-pass, right = high-pass), channel faders with meters, a crossfader with Blend or Cut curves, and a limiter on the master.
- **Scrolling waveforms** that stay beat-aligned across both decks, plus an overview you can click to seek.
- **Library** for your own files (drag them into the window or use Add files).
- **Creative Commons search**, which uses YouTube's own Creative Commons filter through yt-dlp. You can also paste a link.
- ~~**License gate**~~: removed in this build (see `docs/license-gate-features/`).
- **Credits**: collects attribution lines for every CC track you play, ready to paste into a mix description (CC BY requires credit).

## Keyboard

| Deck A | Deck B | Mixer |
|---|---|---|
| `X` play / pause | `,` play / pause | `←` `→` crossfader |
| `Z` cue | `M` cue | `Shift` + arrows: slam |
| `C` sync | `.` sync | `/` filter library |
| `1`–`4` hot cues | `7`–`0` hot cues | `?` help |
| `Q` / `W` nudge | `O` / `P` nudge | |

Shift + a hot cue key clears it.

## yt-dlp

A copy of the official `yt-dlp_arm64.exe` ships inside the app. The **yt-dlp** chip in the top bar shows its version; click it to update. YouTube changes often, so update yt-dlp first if search or downloads stop working.

YouTube support in yt-dlp needs a JavaScript runtime. Commons DJ provides one by reusing its own built-in Node.js, so there's nothing extra to install. If you already have Deno installed, yt-dlp will use that instead.

## Building from source

Requires Node.js 22.12 or newer.

```
npm install
npm run fetch-ytdlp     # grabs yt-dlp for this computer, so `npm start` works
npm start               # run in development
npm test                # analysis, sync, transport, worker and library regressions
npm run test:ui          # real UI with a disposable library, no audio output
npm run test:load        # full-length stereo drag-and-drop responsiveness
npm run test:audio       # recorded deck alignment; takes several minutes
npm run package:win-arm64
npm run package:win-x64
```

Project layout:

- `src/main.js` handles the window, library storage, and yt-dlp (search, license check, download).
- `src/preload.js` is the bridge between the UI and the main process.
- `src/renderer/engine.js` is the Web Audio engine (decks, EQ, filter, loops, sync, crossfader).
- `src/renderer/deck-fx.worklet.js` is the per-deck audio-thread processor for key shift / key lock / stems.
- `src/renderer/analysis.js` holds the waveform, BPM/beat-grid and key detection.
- `src/renderer/app.js` is the UI.

## Notes and limits

- Tempo changes work like vinyl (pitch moves with speed) unless **LOCK** is on.
- Key shift and stems run through a per-deck processor that adds a fixed ~43 ms delay to both decks.
- There's one audio output, so there's no separate headphone cue yet.
- Decoded audio is held in memory, so very long files (hour-long mixes) use a lot of RAM.
- The license check relies on what YouTube reports. Keep an eye on licenses for anything you plan to publish.
