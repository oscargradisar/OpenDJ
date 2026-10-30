// Commons DJ — main process
// Owns the window, the track library on disk, and the yt-dlp integration.
// The renderer never touches the filesystem or spawns processes directly;
// everything goes through the IPC handlers below.

const { app, BrowserWindow, ipcMain, dialog, shell, net, Menu, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'webm', 'aif', 'aiff'];

// YouTube's own "Creative Commons" search filter. Not used in the NoGate
// build's search (see search-issues/3-cc-filter.md).
const CC_SEARCH_PARAM = 'EgIwAQ%253D%253D';

// NO-GATE BUILD: the license gate (license-field check, CC-search memory and
// title-search fallback) is removed here. See license-gate-features/ for the
// original code and the plan for putting each piece back.

const paths = {};
let mainWindow = null;
let library = { version: 1, tracks: [] };
const activeDownloads = new Map();

// ---------------------------------------------------------------- paths

function initPaths() {
  paths.root = app.getPath('userData');
  paths.bin = path.join(paths.root, 'bin');
  paths.audio = path.join(paths.root, 'audio');
  paths.library = path.join(paths.root, 'library.json');
  fs.mkdirSync(paths.bin, { recursive: true });
  fs.mkdirSync(paths.audio, { recursive: true });
}

// ---------------------------------------------------------------- library

async function loadLibrary() {
  try {
    const parsed = JSON.parse(await fsp.readFile(paths.library, 'utf8'));
    if (!Array.isArray(parsed?.tracks) || parsed.tracks.some((t) => !t || typeof t.id !== 'string' || !t.id || typeof t.file !== 'string' || !t.file)) {
      throw new Error('The library contains invalid track data. Restore it from a backup before reopening the app.');
    }
    library = { version: 1, tracks: parsed.tracks };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    library = { version: 1, tracks: [] };
  }
}

let saveTimer = null;
function saveLibrary() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeLibraryNow, 250);
}

function writeLibraryNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = paths.library + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(library, null, 2));
    fs.renameSync(tmp, paths.library);
  } catch (err) {
    console.error('Could not save library:', err);
  }
}

function findTrack(id) {
  return library.tracks.find((t) => t.id === id);
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function publicTrack(t) {
  return { ...t, missing: !fs.existsSync(t.file) };
}

// ---------------------------------------------------------------- yt-dlp

function ytdlpAssetName() {
  const { platform, arch } = process;
  if (platform === 'win32') {
    if (arch === 'arm64') return 'yt-dlp_arm64.exe';
    if (arch === 'ia32') return 'yt-dlp_x86.exe';
    return 'yt-dlp.exe';
  }
  if (platform === 'darwin') return 'yt-dlp_macos';
  return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

function ytdlpPath() {
  return path.join(paths.bin, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

function bundledYtdlpPath() {
  // Packaged builds ship a copy in resources/bin; dev runs look in ./vendor.
  const base = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, '..', 'vendor');
  return path.join(base, ytdlpAssetName());
}

async function ensureYtdlp(onStatus = () => {}) {
  const target = ytdlpPath();
  if (fs.existsSync(target)) return target;

  // First choice: the copy bundled with the app (copied somewhere writable so it can self-update).
  const bundled = bundledYtdlpPath();
  if (fs.existsSync(bundled)) {
    onStatus('Setting up yt-dlp…');
    await fsp.copyFile(bundled, target);
    if (process.platform !== 'win32') await fsp.chmod(target, 0o755);
    return target;
  }

  // Fallback: fetch the official release from GitHub.
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytdlpAssetName()}`;
  onStatus('Downloading yt-dlp from GitHub…');
  const res = await net.fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download yt-dlp (HTTP ${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = target + '.download';
  await fsp.writeFile(tmp, buf);
  if (process.platform !== 'win32') await fsp.chmod(tmp, 0o755);
  await fsp.rename(tmp, target);
  return target;
}

// yt-dlp needs a JavaScript runtime for full YouTube support. Electron can act
// as Node (ELECTRON_RUN_AS_NODE), so we hand it our own executable. If the user
// has Deno installed, yt-dlp prefers that automatically.
function jsRuntimeArgs() {
  return ['--js-runtimes', `node:${process.execPath}`];
}

function runYtdlp(args, { onLine, signal } = {}) {
  return new Promise(async (resolve, reject) => {
    let bin;
    try {
      bin = await ensureYtdlp();
    } catch (err) {
      reject(err);
      return;
    }
    const child = spawn(bin, [...jsRuntimeArgs(), '--no-warnings', '--no-color', ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (onLine) {
        lineBuf += chunk;
        const lines = lineBuf.split(/\r?\n|\r/);
        lineBuf = lines.pop();
        lines.forEach(onLine);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (onLine) chunk.split(/\r?\n|\r/).filter(Boolean).forEach(onLine);
    });
    if (signal) {
      signal.addEventListener('abort', () => child.kill(), { once: true });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal?.aborted) reject(new Error('Cancelled'));
      else if (code === 0) resolve(stdout);
      else reject(new Error(cleanError(stderr) || `yt-dlp exited with code ${code}`));
    });
  });
}

function cleanError(stderr) {
  const errLine = stderr.split(/\r?\n/).reverse().find((l) => l.startsWith('ERROR:'));
  let msg = (errLine || stderr.trim().split(/\r?\n/).pop() || '').replace(/^ERROR:\s*/, '');
  if (/unable to (download|connect)|getaddrinfo|timed out|network is unreachable/i.test(msg)) {
    return 'Couldn’t reach the site — check your internet connection and try again.';
  }
  if (/sign in to confirm|age/i.test(msg)) return 'YouTube wants a sign-in for this video, so it can’t be downloaded here.';
  return msg.replace(/;?\s*please report this issue.*$/i, '').slice(0, 300);
}

function pickThumb(entry) {
  if (entry.thumbnail) return entry.thumbnail;
  const thumbs = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
  const mid = thumbs.find((t) => t.width && t.width >= 200 && t.width <= 400) || thumbs[thumbs.length - 1];
  return mid?.url || null;
}

// How many results the search asks yt-dlp for (YouTube's first page is ~20,
// then more as you scroll). See search-issues/2-result-cap.md.
const SEARCH_LIMIT = 50;

// NOGATE BUILD: plain YouTube search, same query and order as typing it into
// youtube.com. The Creative Commons filter (CC_SEARCH_PARAM) is off; see
// search-issues/3-cc-filter.md. Returns the results plus details of exactly
// what was searched and what was dropped, so the search tab can show it.
async function searchCreativeCommons(query) {
  const q = String(query || '').trim();
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  const info = { query: q, url, filter: 'none (plain YouTube search)', limit: SEARCH_LIMIT };
  if (!q) return { ...info, received: 0, dropped: [], results: [], ms: 0 };
  const started = Date.now();
  const out = await runYtdlp(['--flat-playlist', '--playlist-end', String(SEARCH_LIMIT), '-J', url]);
  const data = JSON.parse(out);
  const raw = data.entries || [];
  const dropped = [];
  const seen = new Set();
  const kept = [];
  for (const e of raw) {
    let reason = null;
    if (!e || !e.id) reason = 'no video id';
    else if (e.ie_key && e.ie_key !== 'Youtube') reason = `not a video (${e.ie_key})`;
    else if (seen.has(e.id)) reason = 'duplicate';
    if (reason) dropped.push({ id: e?.id || '', title: e?.title || '', reason });
    else {
      seen.add(e.id);
      kept.push(e);
    }
  }
  const results = kept.map((e, i) => ({
    rank: i + 1,
    id: e.id,
    title: e.title || e.id,
    channel: e.channel || e.uploader || '',
    duration: e.duration || null,
    url: e.url && e.url.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
    thumbnail: pickThumb(e),
    inLibrary: library.tracks.some((t) => t.source?.id === e.id),
  }));
  return { ...info, received: raw.length, dropped, results, ms: Date.now() - started };
}

// ---------------------------------------------------------------- Spotify (catalog search only)
// Spotify is used for search and metadata through its public Web API. The
// audio itself comes from the closest YouTube upload (see spotifyMatch).

const spotifyKeysFile = () => path.join(paths.root, 'spotify-keys.bin');
let spotifyToken = null; // { value, expires }

function readSpotifyKeys() {
  try {
    const buf = fs.readFileSync(spotifyKeysFile());
    return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8'));
  } catch {
    return null;
  }
}

function saveSpotifyKeys(clientId, clientSecret) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!/^[0-9a-f]{32}$/i.test(id) || !/^[0-9a-f]{32}$/i.test(secret)) throw new Error('Client ID and secret are both 32-character codes from the Spotify developer dashboard.');
  const json = JSON.stringify({ clientId: id, clientSecret: secret });
  fs.writeFileSync(spotifyKeysFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json);
  spotifyToken = null;
}

async function spotifyApi(pathAndQuery) {
  const keys = readSpotifyKeys();
  if (!keys) throw new Error('Add your Spotify client ID and secret first.');
  if (!spotifyToken || Date.now() > spotifyToken.expires) {
    const res = await net.fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${keys.clientId}:${keys.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(res.status === 400 || res.status === 401 ? 'Spotify rejected the client ID / secret.' : `Spotify sign-in failed (HTTP ${res.status}).`);
    const t = await res.json();
    spotifyToken = { value: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
  }
  const res = await net.fetch(`https://api.spotify.com/v1/${pathAndQuery}`, { headers: { Authorization: `Bearer ${spotifyToken.value}` } });
  if (res.status === 401) spotifyToken = null;
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error?.message || '';
    } catch {}
    throw new Error(`Spotify request failed (HTTP ${res.status}${detail ? `: ${detail}` : ''}).`);
  }
  return res.json();
}

function spotifyResult(t, i) {
  const artists = (t.artists || []).map((a) => a.name).join(', ');
  return {
    rank: i + 1,
    id: t.id,
    title: t.name,
    channel: artists,
    artists,
    album: t.album?.name || '',
    isrc: t.external_ids?.isrc || '',
    duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : null,
    url: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
    thumbnail: (t.album?.images || []).slice(-2)[0]?.url || null,
    inLibrary: library.tracks.some((x) => x.source?.spotifyId === t.id),
  };
}

// A pasted open.spotify.com/track/<id> link (or spotify:track:<id>) -> its id, else null.
function spotifyTrackId(raw) {
  const m = String(raw || '').trim().match(/^(?:https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/);
  return m ? m[1] : null;
}

async function searchSpotify(query) {
  const q = String(query || '').trim();
  const info = { query: q, url: `https://open.spotify.com/search/${encodeURIComponent(q)}`, filter: 'Spotify catalog (tracks)', limit: SEARCH_LIMIT };
  if (!q) return { ...info, received: 0, dropped: [], results: [], ms: 0 };
  const started = Date.now();
  const id = spotifyTrackId(q);
  // Spotify caps search at 10 results per request: fetch the pages side by side.
  const PAGE = 10;
  const pages = id
    ? [[await spotifyApi(`tracks/${id}`)]]
    : await Promise.all(
        Array.from({ length: SEARCH_LIMIT / PAGE }, (_, i) =>
          spotifyApi(`search?type=track&limit=${PAGE}&offset=${i * PAGE}&q=${encodeURIComponent(q)}`).then((r) => r.tracks?.items || [], () => []),
        ),
      );
  if (!id && pages.every((p) => !p.length)) await spotifyApi(`search?type=track&limit=${PAGE}&q=${encodeURIComponent(q)}`); // surfaces the real error, if any
  const seen = new Set();
  const items = pages.flat().filter((t) => t && !seen.has(t.id) && seen.add(t.id)); // pages can overlap
  const results = items.filter(Boolean).map(spotifyResult);
  return { ...info, received: items.length, dropped: [], results, ms: Date.now() - started };
}

// Picks the YouTube upload to download for a Spotify track: among the top 5
// results for "artist - title", the first whose length is within 10 s of Spotify's.
async function spotifyMatch(r) {
  await ensureYtdlp();
  const q = `${r.artists} - ${r.title}`;
  const out = await runYtdlp(['--flat-playlist', '-J', `ytsearch5:${q}`]);
  const entries = (JSON.parse(out).entries || []).filter((e) => e?.id);
  if (!entries.length) throw new Error(`No YouTube upload found for “${q}”.`);
  const best = (r.duration && entries.find((e) => e.duration && Math.abs(e.duration - r.duration) <= 10)) || entries[0];
  return `https://www.youtube.com/watch?v=${best.id}`;
}

async function downloadSpotify(r, jobId) {
  const send = (payload) => mainWindow?.webContents.send('download:progress', { jobId, ...payload });
  let url;
  try {
    send({ stage: 'checking', message: 'Finding it on YouTube…' });
    url = await spotifyMatch(r);
  } catch (err) {
    send({ stage: 'error', message: err.message });
    throw err;
  }
  return downloadTrack({
    url,
    jobId,
    meta: { title: r.title, artist: r.artists, source: { spotifyId: r.id, spotifyUrl: r.url, isrc: r.isrc || null } },
  });
}

function validateUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error('That doesn’t look like a link.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only web links are supported.');
  return u.toString();
}

async function fetchInfo(url) {
  const out = await runYtdlp(['--no-playlist', '-J', url]);
  return JSON.parse(out);
}

async function downloadTrack({ url, jobId, meta = null }) {
  const send = (payload) => mainWindow?.webContents.send('download:progress', { jobId, ...payload });
  const controller = new AbortController();
  activeDownloads.set(jobId, controller);

  try {
    const cleanUrl = validateUrl(url);
    send({ stage: 'checking', message: 'Fetching video info…' });
    await ensureYtdlp((message) => send({ stage: 'setup', message }));
    const info = await fetchInfo(cleanUrl);

    const existing = library.tracks.find((t) => t.source?.id === info.id && t.source?.extractor === info.extractor_key);
    if (existing) {
      send({ stage: 'done', message: 'Already in your library', track: publicTrack(existing) });
      return publicTrack(existing);
    }

    send({ stage: 'downloading', message: 'Downloading audio…', percent: 0 });
    const outTemplate = path.join(paths.audio, '%(extractor_key)s-%(id)s.%(ext)s');
    let finalPath = null;
    await runYtdlp(
      [
        '--no-playlist',
        '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
        '-o', outTemplate,
        '--no-mtime',
        '--newline',
        '--progress',
        '--no-simulate',
        '--print', 'after_move:CDJPATH:%(filepath)s',
        cleanUrl,
      ],
      {
        signal: controller.signal,
        onLine: (line) => {
          if (line.startsWith('CDJPATH:')) {
            finalPath = line.slice('CDJPATH:'.length).trim();
            return;
          }
          const m = line.match(/\[download\]\s+([\d.]+)%/);
          if (m) send({ stage: 'downloading', message: 'Downloading audio…', percent: parseFloat(m[1]) });
        },
      },
    );

    if (!finalPath || !fs.existsSync(finalPath)) {
      // Fall back to finding the file by its ID.
      const prefix = `${info.extractor_key}-${info.id}.`;
      const match = (await fsp.readdir(paths.audio)).find((f) => f.startsWith(prefix) && !f.endsWith('.part'));
      if (!match) throw new Error('Download finished but the audio file could not be found.');
      finalPath = path.join(paths.audio, match);
    }

    const track = {
      id: newId(),
      title: meta?.title || info.track || info.title || info.id,
      artist: meta?.artist || info.artist || info.creator || info.channel || info.uploader || '',
      file: finalPath,
      duration: info.duration || null,
      bpm: null,
      beatOffset: null,
      cues: [null, null, null, null],
      addedAt: new Date().toISOString(),
      source: {
        kind: 'web',
        extractor: info.extractor_key,
        id: info.id,
        url: info.webpage_url || cleanUrl,
        uploader: info.channel || info.uploader || '',
        uploaderUrl: info.channel_url || info.uploader_url || '',
        thumbnail: info.thumbnail || null,
        // Recorded as reported, not checked (no-gate build).
        license: info.license || null,
        licenseCheckedBy: 'unchecked',
        ...meta?.source,
      },
    };
    library.tracks.unshift(track);
    saveLibrary();
    send({ stage: 'done', message: 'Added to library', track: publicTrack(track) });
    return publicTrack(track);
  } catch (err) {
    send({ stage: 'error', message: err.message });
    throw err;
  } finally {
    activeDownloads.delete(jobId);
  }
}

// ---------------------------------------------------------------- local files

async function importLocalFiles(filePaths) {
  const added = [];
  for (const file of filePaths) {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(ext)) continue;
    if (library.tracks.some((t) => t.file === file)) continue;
    const base = path.basename(file, path.extname(file));
    const dash = base.indexOf(' - ');
    const track = {
      id: newId(),
      title: dash > 0 ? base.slice(dash + 3) : base,
      artist: dash > 0 ? base.slice(0, dash) : '',
      file,
      duration: null,
      bpm: null,
      beatOffset: null,
      cues: [null, null, null, null],
      addedAt: new Date().toISOString(),
      source: { kind: 'local' },
    };
    library.tracks.unshift(track);
    added.push(publicTrack(track));
  }
  if (added.length) saveLibrary();
  return added;
}

// ---------------------------------------------------------------- AI stems (prototype)
//
// Optional: needs onnxruntime-node next to the app and the HT-Demucs ONNX model
// in <userData>/models (or <app>/models). Without them the decks keep using the
// real-time DSP stems. Each track is separated once; the four stems are cached
// as WAVs in <userData>/stems/<trackId>/.

const STEM_MODEL = 'htdemucs_fp16weights.onnx';
const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'];
let stemWorker = null;
let stemProvider = null; // 'dml' (graphics card) or 'cpu', once the worker has loaded the model
const stemJobs = new Map(); // trackId -> { promise, resolve, reject }
let stemQueue = Promise.resolve();

function stemSetup() {
  const model = [path.join(paths.root, 'models', STEM_MODEL), path.join(__dirname, '..', 'models', STEM_MODEL)].find((p) => fs.existsSync(p));
  // Packaged: resources/ort/onnxruntime-node (native code can't run from inside the app archive).
  // Dev: a normal node_modules install.
  let runtime = null;
  const packaged = path.join(process.resourcesPath || '', 'ort', 'onnxruntime-node');
  if (fs.existsSync(path.join(packaged, 'package.json'))) runtime = packaged;
  else {
    try {
      runtime = path.dirname(require.resolve('onnxruntime-node/package.json'));
    } catch {}
  }
  return { model, runtime, available: !!(model && runtime) };
}

// Community ONNX export of HT-Demucs v4 (MIT, see docs/new-features/ai-stems-plan.md).
const STEM_MODEL_URL = `https://huggingface.co/adowu/htdemucs-onnx/resolve/main/${STEM_MODEL}`;
let modelDownload = null;

/** Download the model into <userData>/models, once, with progress events. */
function downloadStemModel() {
  if (modelDownload) return modelDownload;
  modelDownload = (async () => {
    const dir = path.join(paths.root, 'models');
    const dest = path.join(dir, STEM_MODEL);
    if (fs.existsSync(dest)) return true;
    fs.mkdirSync(dir, { recursive: true });
    const res = await net.fetch(STEM_MODEL_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Model download failed (HTTP ${res.status}).`);
    // shortcut: checks the size the server reports (no checksum is published), pin a SHA-256 if the file is ever mirrored.
    const total = Number(res.headers.get('content-length'));
    if (total < 100_000_000) throw new Error('The model download looks wrong (unexpected size).');
    const part = dest + '.part';
    const out = fs.createWriteStream(part);
    let got = 0;
    let lastSent = 0;
    try {
      for await (const chunk of res.body) {
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        if (got - lastSent > 2_000_000) {
          lastSent = got;
          mainWindow?.webContents.send('stems:modelProgress', { got, total });
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      await fsp.rm(part, { force: true });
      throw err;
    }
    if (got !== total) {
      await fsp.rm(part, { force: true });
      throw new Error(`Model download was incomplete (${got} of ${total} bytes).`);
    }
    fs.renameSync(part, dest);
    return true;
  })().finally(() => (modelDownload = null));
  return modelDownload;
}

const stemDir = (id) => path.join(paths.root, 'stems', String(id).replace(/[^a-zA-Z0-9_-]/g, ''));

function cachedStems(id) {
  const dir = stemDir(id);
  if (!fs.existsSync(path.join(dir, 'stems.json'))) return null;
  // Once the GPU models are installed, older CPU-only stems are redone at the higher quality.
  try {
    if (gpuSetup() && JSON.parse(fs.readFileSync(path.join(dir, 'stems.json'), 'utf8')).device !== 'cuda') return null;
  } catch {
    return null;
  }
  const files = Object.fromEntries(STEM_NAMES.map((n) => [n, path.join(dir, `${n}.wav`)]));
  return Object.values(files).every((f) => fs.existsSync(f)) ? files : null;
}

function getStemWorker(setup) {
  if (stemWorker) return stemWorker;
  const { Worker } = require('node:worker_threads');
  stemWorker = new Worker(path.join(__dirname, 'stems-worker.js'), { workerData: { modelPath: setup.model, runtimePath: setup.runtime } });
  stemWorker.on('message', (m) => {
    const job = stemJobs.get(m.jobId);
    if (m.provider) stemProvider = m.provider;
    if (m.type === 'progress') mainWindow?.webContents.send('stems:progress', { trackId: m.jobId, done: m.done, total: m.total });
    if (!job) return;
    if (m.type === 'done') job.resolve({ ms: m.ms });
    if (m.type === 'error') job.reject(new Error(m.message));
    if (m.type === 'done' || m.type === 'error') stemJobs.delete(m.jobId);
  });
  stemWorker.on('error', (err) => {
    for (const job of stemJobs.values()) job.reject(err);
    stemJobs.clear();
    stemWorker = null;
  });
  return stemWorker;
}

// ---- High-quality GPU path (optional): BS-RoFormer + HT-Demucs-ft on an NVIDIA GPU
// through a private Python + PyTorch (CUDA) install in <userData>/stems-gpu. Its
// setup writes stems-gpu/ready.json (models chosen and verified) when complete.
function gpuSetup() {
  const dir = path.join(paths.root, 'stems-gpu');
  const python = path.join(dir, 'Scripts', 'python.exe');
  try {
    const ready = JSON.parse(fs.readFileSync(path.join(dir, 'ready.json'), 'utf8'));
    if (fs.existsSync(python)) return { python, modelDir: path.join(dir, 'models'), ...ready };
  } catch {}
  return null;
}

function writeWav16(file, left, right) {
  const n = left.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(44100, 24);
  buf.writeUInt32LE(44100 * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0, o = 44; i < n; i++, o += 4) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767))), o);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767))), o + 2);
  }
  fs.writeFileSync(file, buf);
}

function separateOnGpu(gpu, id, left, right) {
  const input = path.join(app.getPath('temp'), `cdj-stems-${id}.wav`);
  writeWav16(input, left, right);
  const script = path.join(__dirname, 'stems-gpu.py').replace('app.asar', 'app.asar.unpacked');
  return new Promise((resolve, reject) => {
    const p = spawn(gpu.python, [script, input, stemDir(id), gpu.modelDir, gpu.vocalModel, gpu.splitModel], { windowsHide: true });
    let err = '';
    p.stdout.on('data', (d) => {
      for (const m of String(d).matchAll(/PROGRESS (\d+) (\d+)/g)) {
        mainWindow?.webContents.send('stems:progress', { trackId: id, done: Number(m[1]), total: Number(m[2]) });
      }
    });
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', reject);
    p.on('close', (code) => {
      fs.rm(input, { force: true }, () => {});
      if (code === 0 && cachedStems(id)) resolve({ device: 'cuda' });
      else reject(new Error(`GPU separation failed (exit ${code}): ${err.trim().split('\n').pop() || 'no output'}`));
    });
  });
}

/** Separate one track (44.1 kHz stereo PCM from the renderer). One job at a time. */
function separateStems(id, left, right) {
  const gpu = gpuSetup();
  const setup = stemSetup();
  if (!gpu && !setup.available) return Promise.reject(new Error('AI stems are not installed.'));
  if (!findTrack(id)) return Promise.reject(new Error('Track not found'));
  if (cachedStems(id)) return Promise.resolve({ cached: true });
  if (stemJobs.has(id)) return stemJobs.get(id).promise;
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  stemJobs.set(id, { promise, resolve, reject });
  const onCpu = () => {
    if (!setup.available) throw new Error('GPU separation failed and the CPU model is not installed.');
    getStemWorker(setup).postMessage({ type: 'separate', jobId: id, left, right, outDir: stemDir(id) }, [left.buffer, right.buffer]);
  };
  stemQueue = stemQueue.then(async () => {
    try {
      if (!gpu) onCpu();
      else {
        try {
          stemProvider = 'cuda';
          const r = await separateOnGpu(gpu, id, left, right);
          stemJobs.delete(id);
          resolve(r);
        } catch (err) {
          console.error(err.message);
          stemProvider = null;
          onCpu(); // the worker resolves/rejects the job as before
        }
      }
    } catch (err) {
      stemJobs.delete(id);
      reject(err);
    }
    return promise.catch(() => {});
  });
  return promise;
}

// ---------------------------------------------------------------- music videos (optional)
// For tracks downloaded from the web, a small muted video copy (≤ 480p, no audio)
// can be fetched once and kept in <userData>/videos/<trackId>.<ext>. The decks
// show it beside the readouts, following the music.

const videoDir = () => path.join(paths.root, 'videos');
const safeId = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, '');

function cachedVideo(id) {
  try {
    const name = fs.readdirSync(videoDir()).find((n) => n.startsWith(safeId(id) + '.') && !/\.(part|ytdl|tmp)$/.test(n));
    return name ? path.join(videoDir(), name) : null;
  } catch {
    return null;
  }
}

async function fetchVideo(id) {
  const t = findTrack(id);
  if (t?.source?.kind !== 'web' || !t.source.url) throw new Error('Only downloaded web tracks have a video.');
  let file = cachedVideo(id);
  if (!file) {
    fs.mkdirSync(videoDir(), { recursive: true });
    const send = (percent) => mainWindow?.webContents.send('video:progress', { trackId: id, percent });
    await runYtdlp(
      ['--no-playlist', '-f', 'bv*[height<=480][ext=mp4]/bv*[height<=480]/bv*', '-o', path.join(videoDir(), `${safeId(id)}.%(ext)s`), '--no-mtime', '--newline', '--progress', validateUrl(t.source.url)],
      { onLine: (line) => { const m = line.match(/\[download\]\s+([\d.]+)%/); if (m) send(parseFloat(m[1])); } },
    );
    file = cachedVideo(id);
    if (!file) throw new Error('The video download finished but the file could not be found.');
  }
  return fsp.readFile(file);
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('stems:status', (_e, id) => {
    const setup = stemSetup();
    return { available: setup.available || !!gpuSetup(), ready: !!cachedStems(id), busy: stemJobs.has(id) };
  });

  ipcMain.handle('stems:setup', () => {
    const s = stemSetup();
    const gpu = gpuSetup();
    return { runtime: !!s.runtime || !!gpu, model: !!s.model || !!gpu, downloading: !!modelDownload, provider: gpu ? 'cuda' : stemProvider, gpuModel: gpu?.label };
  });
  ipcMain.handle('stems:downloadModel', () => downloadStemModel());

  ipcMain.handle('stems:separate', (_e, id, left, right) => separateStems(id, new Float32Array(left), new Float32Array(right)));

  ipcMain.handle('stems:read', async (_e, id, name) => {
    const files = cachedStems(id);
    if (!files || !files[name]) throw new Error('Stems not ready');
    const buf = await fsp.readFile(files[name]);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  ipcMain.handle('library:list', () => library.tracks.map(publicTrack));

  ipcMain.handle('library:update', (_e, id, patch) => {
    const t = findTrack(id);
    if (!t) return null;
    const allowed = ['title', 'artist', 'bpm', 'beatOffset', 'beatsPerBar', 'downbeat', 'cues', 'duration', 'key',
      'gridVersion', 'gridSource', 'keyVersion', 'chroma', 'tuning', 'bpmConfidence', 'gridRms', 'variable', 'bpmAlts', 'gridPrev'];
    for (const key of allowed) if (key in patch) t[key] = patch[key];
    saveLibrary();
    return publicTrack(t);
  });

  ipcMain.handle('library:remove', async (_e, id, { deleteFile } = {}) => {
    const idx = library.tracks.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    const [t] = library.tracks.splice(idx, 1);
    // Only ever delete files that live inside our own audio folder.
    if (deleteFile && path.dirname(path.resolve(t.file)) === path.resolve(paths.audio)) {
      await fsp.unlink(t.file).catch(() => {});
    }
    // Cached AI stems belong to the track; they go with it.
    if (!stemJobs.has(id)) await fsp.rm(stemDir(id), { recursive: true, force: true }).catch(() => {});
    const video = cachedVideo(id); // so does its music video
    if (video) await fsp.unlink(video).catch(() => {});
    saveLibrary();
    return true;
  });

  ipcMain.handle('video:status', (_e, id) => {
    const t = findTrack(id);
    return { available: t?.source?.kind === 'web' && !!t.source.url, cached: !!cachedVideo(id) };
  });
  ipcMain.handle('video:get', (_e, id) => fetchVideo(id));

  ipcMain.handle('library:readAudio', async (_e, id) => {
    const t = findTrack(id);
    if (!t) throw new Error('Track not found');
    return pathToFileURL(t.file).href;
  });

  ipcMain.handle('library:importDialog', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Add music files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
    });
    if (res.canceled) return [];
    return importLocalFiles(res.filePaths);
  });

  ipcMain.handle('library:importPaths', (_e, filePaths) => importLocalFiles(Array.isArray(filePaths) ? filePaths : []));

  ipcMain.handle('library:openFolder', () => shell.openPath(paths.audio));

  ipcMain.handle('cc:search', (_e, query) => searchCreativeCommons(query));

  ipcMain.handle('cc:download', (_e, url, jobId) => downloadTrack({ url, jobId }));

  ipcMain.handle('spotify:hasKeys', () => !!readSpotifyKeys());
  ipcMain.handle('spotify:setKeys', (_e, id, secret) => saveSpotifyKeys(id, secret));
  ipcMain.handle('spotify:search', (_e, query) => searchSpotify(query));
  ipcMain.handle('spotify:download', (_e, result, jobId) => downloadSpotify(result, jobId));

  ipcMain.handle('cc:cancel', (_e, jobId) => {
    activeDownloads.get(jobId)?.abort();
    return true;
  });

  ipcMain.handle('ytdlp:status', async () => {
    const p = ytdlpPath();
    if (!fs.existsSync(p) && !fs.existsSync(bundledYtdlpPath())) return { installed: false };
    try {
      const v = await runYtdlp(['--version']);
      return { installed: true, version: v.trim() };
    } catch (err) {
      return { installed: false, error: err.message };
    }
  });

  ipcMain.handle('ytdlp:update', async () => {
    const out = await runYtdlp(['-U']);
    return out.trim().split(/\r?\n/).pop();
  });

  // Window-level fullscreen: page-level requestFullscreen would cover open dialogs (Settings).
  ipcMain.handle('window:toggleFullscreen', () => {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    const u = validateUrl(url);
    return shell.openExternal(u);
  });
}

// ---------------------------------------------------------------- window

function createWindow() {
  // --background: open behind the current window without taking focus (used for restarts).
  const background = process.argv.includes('--background');
  mainWindow = new BrowserWindow({
    show: !background,
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#0d0e10',
    title: 'Commons DJ',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (background) mainWindow.once('ready-to-show', () => mainWindow.showInactive());

  // Keep links out of the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  initPaths();
  try {
    await loadLibrary();
  } catch (err) {
    dialog.showErrorBox('Unable to open your library', `Your library could not be read. It has been left untouched.\n\n${paths.library}\n\n${err.message}`);
    app.quit();
    return;
  }
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  for (const c of activeDownloads.values()) c.abort();
  if (saveTimer) writeLibraryNow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
