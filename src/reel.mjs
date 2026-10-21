// "The luxury reel": a 9:16 film of 19.5 s from 10 stock clips, all graded alike, between a title card
// and an end card. Usage: npm run reel [-- --date 2026-10-21] [-- --force] [-- --dry-run (choose clips only)]
//
// Clips come from the Pixabay Videos API (PIXABAY_API_KEY in .env), one query per slot; a local file
// videos/stock/<slot>_*.mp4 (01_ to 10_) replaces the download for that slot.
// Output in out/reels/: <date>_luxury.mp4, <date>_luxury_cover.jpg, <date>_luxury.txt (clips and credits).
// Nothing is posted anywhere. Music is added in Instagram when posting; the file carries a silent track.
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, readdir, writeFile, rm, rename, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import { ROOT, SRC, OUT, STATE, readJson, writeJson, parseArgs } from './paths.mjs';
import { renderCards } from './render.mjs';
import { AVOID, PERSON, DISCREET_POSE, SUGGESTIVE } from './filters.mjs';

// ---- Tunable constants -------------------------------------------------------------------------

const W = 1080;
const H = 1920;
const FPS = 30;
const CLIP_SECONDS = 1.5;
const TITLE_SECONDS = 2.0;
const TITLE_FADE_IN = 0.3;
const END_SECONDS = 2.5;
const END_FADE_OUT = 0.4;
const VIDEO_BITRATE = '12M';

// "The luxury filter", identical on every clip so the reel feels like one film.
const GRADE = {
  contrast: 1.08, // +8 %
  saturation: 0.85, // -15 %
  blackLift: 0.06, // matte: the black point is raised to 6 %
  warmHighlights: { r: 0.05, g: 0.025, b: -0.05 }, // highlights nudged toward gold
  vignetteAngle: 'PI/5.5', // mild
  grain: 6, // fine temporal film grain
  darkOverlay: 0.2, // 20 % black on top, as on the posts
};

// One query per slot, in order. `must`: groups of tag words; every group needs one match, so the
// clip really shows the subject (Pixabay matched "woman fur coat snow" on a butterfly "imperial coat").
const SLOTS = [
  { query: 'luxury car snow road', must: [['car', 'vehicle', 'automobile'], ['snow', 'winter']] },
  { query: 'luxury watch', must: [['watch', 'wristwatch', 'chronograph', 'timepiece']] },
  { query: 'diamond jewelry', must: [['diamond', 'jewelry', 'jewellery', 'ring', 'necklace']] },
  { query: 'woman fur coat snow', must: [['woman', 'girl', 'lady', 'model'], ['fur', 'coat', 'snow', 'winter']] },
  { query: 'fireplace chalet', must: [['fireplace', 'chalet']] },
  { query: 'alps drone sunrise', must: [['alps', 'alpine', 'mountain', 'dolomites'], ['drone', 'aerial', 'fpv']] },
  { query: 'champagne pouring', must: [['champagne']] },
  { query: 'skiing powder', must: [['ski', 'skiing', 'skier']] },
  { query: 'sports car night', must: [['sports car', 'supercar', 'luxury car', 'porsche', 'ferrari', 'lamborghini', 'mclaren']] },
  { query: 'luxury interior', must: [['interior', 'living room', 'chandelier', 'lounge', 'suite']] },
];
// Tried in this order when a slot finds nothing usable (and reported).
const FALLBACKS = [
  { query: 'alpine', must: [['alps', 'alpine', 'mountain']] },
  { query: 'luxury', must: [['luxury']] },
  { query: 'snow', must: [['snow', 'winter']] },
];

const MIN_SHORT_SIDE = 1080; // px, on the downloaded file
const MAX_UPSCALE = 1.5;
const PREFERRED_DURATION = [4, 20]; // s; longer clips are often compilations whose middle is off-subject
const MAX_REQUESTS = 30; // per run, API searches and downloads together
const API_INTERVAL_MS = 1000;
const CACHE_HOURS = 24; // Pixabay asks API clients to cache search results for 24 hours
// Generated or computer-made footage, matched on the tags and on the author name.
const SYNTHETIC = /\bai\b|generat|render|\b3d\b|cgi|animat|illustrat|cartoon|virtual/i;

// ---- Paths -------------------------------------------------------------------------------------

const args = parseArgs();
const date = typeof args.date === 'string' ? args.date : new Date().toLocaleDateString('sv-SE');
const VIDEOS = path.join(ROOT, 'videos');
const STOCK = path.join(VIDEOS, 'stock');
const DOWNLOADS = path.join(VIDEOS, 'pixabay');
const CACHE = path.join(VIDEOS, '.cache');
const REELS = path.join(OUT, 'reels');
const WORK = path.join(REELS, `.build-${date}`);
const SEEN_FILE = path.join(STATE, 'pixabay-seen.json');
const base = path.join(REELS, `${date}_luxury`);
const outputs = { video: `${base}.mp4`, cover: `${base}_cover.jpg`, notes: `${base}.txt` };

const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
const ffmpeg = (...a) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);

// ---- Preflight ---------------------------------------------------------------------------------

try {
  run('ffmpeg', ['-version']);
  run('ffprobe', ['-version']);
} catch {
  console.error('ffmpeg is required: brew install ffmpeg');
  process.exit(1);
}
if (existsSync(outputs.video) && !args.force) {
  console.error(`${path.relative(ROOT, outputs.video)} already exists. Use --date <name> or --force.`);
  process.exit(1);
}
const localClips = await localStockClips();
const needsPixabay = SLOTS.some((_, i) => !localClips[i]);
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
const KEY = process.env.PIXABAY_API_KEY?.trim();
if (needsPixabay && !KEY) {
  console.error('PIXABAY_API_KEY is missing from .env. Carl sets it from his own Terminal; stopping.');
  process.exit(1);
}

async function localStockClips() {
  const files = existsSync(STOCK) ? (await readdir(STOCK)).filter((f) => /^\d\d_.*\.mp4$/i.test(f)).sort() : [];
  return SLOTS.map((_, i) => files.find((f) => f.startsWith(`${String(i + 1).padStart(2, '0')}_`)) ?? null);
}

// ---- Pixabay -----------------------------------------------------------------------------------

let requests = 0;
let lastApiCall = 0;
function spend() {
  if (requests >= MAX_REQUESTS) throw new Error(`request budget of ${MAX_REQUESTS} reached`);
  requests++;
}

async function search(query) {
  const params = new URLSearchParams({
    q: query, video_type: 'film', order: 'popular', per_page: '20', safesearch: 'true', min_height: '1080',
  });
  const cacheFile = path.join(CACHE, `${createHash('sha1').update(params.toString()).digest('hex')}.json`);
  const cached = await readJson(cacheFile, null);
  if (cached && Date.now() - cached.fetched_at < CACHE_HOURS * 3600e3) return cached.hits;

  spend();
  const wait = lastApiCall + API_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastApiCall = Date.now();
  params.set('key', KEY);
  const res = await fetch(`https://pixabay.com/api/videos/?${params}`);
  if (!res.ok) throw new Error(`Pixabay API answered HTTP ${res.status} for "${query}"${res.status === 400 ? ' (check PIXABAY_API_KEY)' : ''}`);
  const { hits = [] } = await res.json();
  await writeJson(cacheFile, { fetched_at: Date.now(), query, hits });
  return hits;
}

// The largest rendition with at least MIN_SHORT_SIDE px on its short side.
function bestFile(hit) {
  return Object.values(hit.videos ?? {})
    .filter((v) => v?.url && Math.min(v.width, v.height) >= MIN_SHORT_SIDE)
    .sort((a, b) => b.width * b.height - a.width * a.height || (b.size ?? 0) - (a.size ?? 0))[0] ?? null;
}

const hasTag = (tags, word) => new RegExp(`\\b${word}s?\\b`, 'i').test(tags);

function candidate(hit, excluded, must) {
  if (excluded.has(String(hit.id))) return null;
  const tags = hit.tags ?? '';
  if (SYNTHETIC.test(`${tags} ${hit.user ?? ''}`) || AVOID.test(tags) || SUGGESTIVE.test(tags)) return null;
  if (!must.every((group) => group.some((word) => hasTag(tags, word)))) return null;
  if (!(hit.duration >= CLIP_SECONDS + 0.5)) return null;
  const file = bestFile(hit);
  if (!file) return null;
  const upscale = Math.max(W / file.width, H / file.height); // cover 1080x1920, never stretched
  if (upscale > MAX_UPSCALE) return null;
  const personRank = PERSON.test(tags) && !DISCREET_POSE.test(tags) ? 1 : 0;
  return { hit, file, vertical: file.height > file.width, upscale, personRank };
}

// Vertical clips when the results have any; then clips of 4 to 20 s, then longer ones, then shorter;
// then people seen from the back or in silhouette; otherwise Pixabay's popularity order.
function durationRank({ hit }) {
  const [min, max] = PREFERRED_DURATION;
  return hit.duration >= min && hit.duration <= max ? 0 : hit.duration > max ? 1 : 2;
}
function pick(hits, excluded, must) {
  const usable = hits.map((h) => candidate(h, excluded, must)).filter(Boolean);
  const pool = usable.some((c) => c.vertical) ? usable.filter((c) => c.vertical) : usable;
  return pool.sort((a, b) => durationRank(a) - durationRank(b) || a.personRank - b.personRank)[0] ?? null;
}

async function download(c) {
  const file = path.join(DOWNLOADS, `${c.hit.id}_${c.file.width}x${c.file.height}.mp4`);
  if (existsSync(file) && (await stat(file)).size > 0) return file;
  spend();
  await mkdir(DOWNLOADS, { recursive: true });
  const res = await fetch(c.file.url);
  if (!res.ok || !res.body) throw new Error(`clip download failed (Pixabay ${c.hit.id}): HTTP ${res.status}`);
  const partial = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
  await rename(partial, file);
  return file;
}

// ---- Video helpers -----------------------------------------------------------------------------

function probe(file) {
  const info = JSON.parse(run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]));
  const v = info.streams.find((s) => s.codec_type === 'video');
  const rotation = Math.abs(Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0));
  const turned = rotation === 90 || rotation === 270;
  return {
    width: turned ? v.height : v.width,
    height: turned ? v.width : v.height,
    duration: Number(info.format.duration ?? v.duration),
    codec: v.codec_name,
    pixFmt: v.pix_fmt,
    fps: v.avg_frame_rate,
    audio: info.streams.find((s) => s.codec_type === 'audio')?.codec_name ?? null,
  };
}

const even = (x) => Math.ceil(x / 2) * 2;
function fitFilter(width, height) {
  const scale = Math.max(W / width, H / height); // cover, then centre crop: aspect ratio is kept
  return `scale=${Math.max(W, even(width * scale))}:${Math.max(H, even(height * scale))}:flags=lanczos,crop=${W}:${H},setsar=1,fps=${FPS}`;
}
function gradeFilter() {
  const g = GRADE;
  const keep = (1 - g.darkOverlay).toFixed(3);
  return [
    `eq=contrast=${g.contrast}:saturation=${g.saturation}`,
    `colorbalance=rh=${g.warmHighlights.r}:gh=${g.warmHighlights.g}:bh=${g.warmHighlights.b}`,
    `curves=master='0/${g.blackLift} 1/1'`,
    `colorchannelmixer=rr=${keep}:gg=${keep}:bb=${keep}`,
    `vignette=angle=${g.vignetteAngle}`,
    `noise=alls=${g.grain}:allf=t`,
  ].join(',');
}
const SEGMENT_CODEC = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-video_track_timescale', String(FPS * 1000)];
const frames = (seconds) => String(Math.round(seconds * FPS));

// ---- 1. Choose the clips -----------------------------------------------------------------------

const seen = await readJson(SEEN_FILE, { used: {}, rejected: {} });
seen.used ??= {};
seen.rejected ??= {};
const excluded = new Set([...Object.keys(seen.used), ...Object.keys(seen.rejected)]);
const slots = [];
const notes = [];

console.log(`Luxury reel ${date}: choosing 10 clips`);
for (const [i, { query, must }] of SLOTS.entries()) {
  const slot = String(i + 1).padStart(2, '0');
  if (localClips[i]) {
    slots.push({ slot, query, source: 'local', file: path.join(STOCK, localClips[i]), credit: null });
    console.log(`  ${slot}  local clip videos/stock/${localClips[i]}`);
    continue;
  }
  let chosen = null;
  let usedQuery = query;
  for (const attempt of [{ query, must }, ...FALLBACKS]) {
    chosen = pick(await search(attempt.query), excluded, attempt.must);
    if (chosen) { usedQuery = attempt.query; break; }
  }
  if (!chosen) throw new Error(`Slot ${slot} ("${query}"): no usable clip, even with ${FALLBACKS.map((f) => f.query).join(', ')}.`);
  if (usedQuery !== query) notes.push(`Slot ${slot}: nothing usable for "${query}", used the fallback query "${usedQuery}".`);
  excluded.add(String(chosen.hit.id));
  slots.push({
    slot, query, usedQuery, source: 'pixabay', candidate: chosen,
    credit: { author: chosen.hit.user, page: chosen.hit.pageURL, id: chosen.hit.id },
  });
  const { width, height } = chosen.file;
  console.log(`  ${slot}  "${usedQuery}" -> Pixabay ${chosen.hit.id} by ${chosen.hit.user}, ${width}x${height}, ${chosen.hit.duration}s${chosen.vertical ? ', vertical' : ''}`);
}

if (args['dry-run']) {
  console.log(`Dry run: clips chosen, nothing downloaded or rendered. Pixabay requests: ${requests} of ${MAX_REQUESTS}.`);
  if (notes.length) console.log(notes.join('\n'));
  process.exit(0);
}

// ---- 2. Download -------------------------------------------------------------------------------

for (const s of slots.filter((s) => s.source === 'pixabay')) {
  process.stdout.write(`  downloading ${s.slot} (${((s.candidate.file.size ?? 0) / 1e6).toFixed(0)} MB)... `);
  s.file = await download(s.candidate);
  console.log('ok');
}
console.log(`Pixabay requests this run: ${requests} of ${MAX_REQUESTS}`);

// ---- 3. Cards (Playwright, same fonts and guard as the posts) ---------------------------------

await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
const cardTemplate = path.join(SRC, 'reel-card.html');
const card = (name) => path.join(WORK, `${name}.png`);
await renderCards(cardTemplate, [
  { out: card('title'), width: W, height: H, variant: 'title' },
  { out: card('end'), width: W, height: H, variant: 'end' },
  { out: card('label'), width: W, height: H, variant: 'label', transparent: true },
]);

// ---- 4. Segments -------------------------------------------------------------------------------

const segments = [];
const seg = (name) => { const f = path.join(WORK, `${name}.mp4`); segments.push(f); return f; };

ffmpeg('-loop', '1', '-framerate', String(FPS), '-i', card('title'),
  '-vf', `fade=t=in:st=0:d=${TITLE_FADE_IN},format=yuv420p`, '-frames:v', frames(TITLE_SECONDS), ...SEGMENT_CODEC, seg('00_title'));

const grade = gradeFilter();
for (const s of slots) {
  const info = probe(s.file);
  if (info.duration < CLIP_SECONDS) throw new Error(`Slot ${s.slot}: clip is only ${info.duration.toFixed(2)} s long.`);
  if (Math.max(W / info.width, H / info.height) > MAX_UPSCALE)
    throw new Error(`Slot ${s.slot}: ${info.width}x${info.height} would need more than ${MAX_UPSCALE}x upscaling.`);
  s.start = Math.max(0, (info.duration - CLIP_SECONDS) / 2); // 1.5 s from the middle
  s.size = `${info.width}x${info.height}`;
  ffmpeg('-ss', s.start.toFixed(3), '-i', s.file, '-loop', '1', '-i', card('label'),
    '-filter_complex', `[0:v]${fitFilter(info.width, info.height)},${grade}[g];[g][1:v]overlay=0:0,format=yuv420p[v]`,
    '-map', '[v]', '-an', '-frames:v', frames(CLIP_SECONDS), ...SEGMENT_CODEC, seg(s.slot));
  console.log(`  graded ${s.slot}  ${s.size} from ${s.start.toFixed(2)} s`);
}

ffmpeg('-loop', '1', '-framerate', String(FPS), '-i', card('end'),
  '-vf', `fade=t=out:st=${END_SECONDS - END_FADE_OUT}:d=${END_FADE_OUT},format=yuv420p`, '-frames:v', frames(END_SECONDS), ...SEGMENT_CODEC, seg('11_end'));

// ---- 5. Assemble: hard cuts, H.264 yuv420p ~12 Mbps, silent AAC --------------------------------

const total = TITLE_SECONDS + SLOTS.length * CLIP_SECONDS + END_SECONDS;
const list = path.join(WORK, 'segments.txt');
await writeFile(list, segments.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
await mkdir(REELS, { recursive: true });
ffmpeg('-f', 'concat', '-safe', '0', '-i', list,
  '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
  '-map', '0:v', '-map', '1:a', '-t', total.toFixed(3),
  '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', String(FPS),
  '-b:v', VIDEO_BITRATE, '-maxrate', '15M', '-bufsize', '24M',
  '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputs.video);
ffmpeg('-i', card('title'), '-q:v', '2', outputs.cover);

// ---- 6. Verify ---------------------------------------------------------------------------------

const out = probe(outputs.video);
// "It plays": decode every frame; ffmpeg reports problems on stderr, so capture it.
const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', outputs.video, '-f', 'null', '-'], { encoding: 'utf8' });
const decodeErrors = `${decode.status === 0 ? '' : `exit ${decode.status} `}${decode.stderr.trim()}`;
const checks = {
  [`duration ${out.duration.toFixed(2)} s (expected ${total} s)`]: Math.abs(out.duration - total) < 0.1,
  [`${out.width}x${out.height}`]: out.width === W && out.height === H,
  [`${out.codec} ${out.pixFmt}, audio ${out.audio}`]: out.codec === 'h264' && out.pixFmt === 'yuv420p' && out.audio === 'aac',
  'decodes end to end without errors': decodeErrors === '',
};
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([what]) => what);

// ---- 7. Notes, credits, state ------------------------------------------------------------------

const credits = slots.filter((s) => s.credit).map((s) => `Video by ${s.credit.author} on Pixabay (${s.credit.page})`);
const clipLines = slots.map((s) =>
  `${s.slot}  ${s.query}${s.usedQuery && s.usedQuery !== s.query ? ` (fallback: ${s.usedQuery})` : ''}\n` +
  `    ${s.source === 'local' ? `local clip ${path.relative(ROOT, s.file)}` : `Pixabay ${s.credit.id}, ${s.credit.page}`}\n` +
  `    source ${s.size}, 1.5 s from ${s.start.toFixed(2)} s`);
await writeFile(outputs.notes, `Luxury reel ${date}
${path.basename(outputs.video)}: ${W}x${H}, ${FPS} fps, ${out.duration.toFixed(2)} s, H.264 ${VIDEO_BITRATE}bps, silent AAC (add music in Instagram).
Structure: title card ${TITLE_SECONDS} s, 10 clips x ${CLIP_SECONDS} s, end card ${END_SECONDS} s.

Clips
${clipLines.join('\n')}
${notes.length ? `\nNotes\n${notes.join('\n')}\n` : ''}
Credits
${credits.join('\n') || '(local clips only)'}
`);

if (failed.length) {
  console.error(`Verification failed: ${failed.join('; ')}`);
  process.exit(1);
}
for (const s of slots.filter((s) => s.credit))
  seen.used[s.credit.id] = { slot: s.slot, query: s.usedQuery, author: s.credit.author, page: s.credit.page, reel: path.basename(outputs.video) };
await writeJson(SEEN_FILE, seen);
await rm(WORK, { recursive: true, force: true });

console.log(`\n${path.relative(ROOT, outputs.video)}  (${((await stat(outputs.video)).size / 1e6).toFixed(1)} MB)`);
console.log(Object.keys(checks).map((c) => `  ok  ${c}`).join('\n'));
console.log(`  ${path.relative(ROOT, outputs.cover)}\n  ${path.relative(ROOT, outputs.notes)}`);
if (notes.length) console.log(notes.join('\n'));
