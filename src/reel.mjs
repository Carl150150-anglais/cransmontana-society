// "The luxury reel": a 9:16 film of 19.5 s from 10 stock clips, all graded alike, between a title card
// and an end card, with quotes over the clips.
// Usage: npm run reel [-- --count 3] [-- --quotes 3] [-- --date 2026-10-21] [-- --dry-run]
//   --count N   N different reels in one run (different clips and quotes)
//   --quotes N  0 to 3 quotes: quote 1 over clips 1-3, quote 2 over 4-6, quote 3 over 7-9; clip 10 stays clean
//   --dry-run   choose clips and quotes only; nothing is downloaded, rendered or recorded
//
// Clips come from the Pixabay Videos API (PIXABAY_API_KEY in .env), one query per slot; a local file
// videos/stock/<slot>_*.mp4 (01_ to 10_) replaces the download for that slot.
// Output in out/reels/, numbered so nothing is overwritten: <date>_luxury_<n>.mp4, _cover.jpg, .txt.
// Nothing is posted anywhere. Music is added in Instagram when posting; the file carries a silent track.
import { existsSync, createWriteStream } from 'node:fs';
import { mkdir, readdir, writeFile, rm, rename, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import dotenv from 'dotenv';
import { ROOT, SRC, OUT, STATE, QUOTES, readJson, writeJson, parseArgs } from './paths.mjs';
import { renderCards, measureLines } from './render.mjs';
import { AVOID, PERSON, DISCREET_POSE, SUGGESTIVE } from './filters.mjs';
import { seasonFor, inSeason } from './season.mjs';

// ---- Tunable constants -------------------------------------------------------------------------

const W = 1080;
const H = 1920;
const FPS = 30;
const CLIP_SECONDS = 1.5;
const TITLE_SECONDS = 2.0;
const TITLE_FADE_IN = 0.3;
const END_SECONDS = 2.5;
const END_FADE_OUT = 0.4;
const QUOTE_FADE = 0.25;
const CLIPS_PER_QUOTE = 3;
const MAX_QUOTES = 3;
const END_CARD_QUOTE = 'Ambition lives at altitude.'; // already on the end card, so never over the clips
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
// clip really shows the subject. Pixabay tags are loose: "imperial coat" (a butterfly), "watch out"
// (meerkats), "diamond head" (Honolulu), "mountain chalet" (a glass). `avoid`: tag words that rule a
// clip out for that slot. `theme` links the clip to the quote themes.
const SLOTS = [
  { query: 'luxury car snow road', theme: 'cars', must: [['car', 'vehicle', 'automobile'], ['snow', 'winter']] },
  { query: 'luxury watch', theme: 'watches', must: [['watch', 'wristwatch', 'chronograph', 'timepiece'], ['time', 'clock', 'wrist', 'wristwatch', 'mechanical', 'movement', 'luxury', 'chronograph', 'timepiece']], avoid: ['alarm', 'wall clock', 'animal'] },
  { query: 'diamond jewelry', theme: 'jewels', must: [['jewelry', 'jewellery', 'necklace', 'ring', 'earring', 'bracelet']], avoid: ['crystal', 'quartz', 'mineral', 'gear'] },
  { query: 'woman fur coat snow', theme: 'fashion', must: [['woman', 'girl', 'lady', 'model'], ['fur', 'coat', 'snow', 'winter']] },
  { query: 'fireplace chalet', theme: 'chalets', must: [['fireplace', 'hearth', 'stove'], ['fire', 'flame', 'firewood', 'cozy']] },
  { query: 'alps drone sunrise', theme: 'mountain', must: [['alps', 'alpine', 'mountain', 'dolomites'], ['drone', 'aerial', 'fpv']] },
  { query: 'champagne pouring', theme: 'dining', must: [['champagne']] },
  { query: 'skiing powder', theme: 'ski', must: [['ski', 'skiing', 'skier']] },
  { query: 'sports car night', theme: 'cars', must: [['sports car', 'supercar', 'luxury car', 'porsche', 'ferrari', 'lamborghini', 'mclaren']] },
  { query: 'luxury interior', theme: 'chalets', must: [['interior', 'living room', 'chandelier', 'lounge', 'suite']], avoid: ['computer', 'monitor', 'keyboard', 'office', 'gaming'] },
];
// Tried in this order when a slot finds nothing usable (and reported).
const FALLBACKS = [
  { query: 'alpine', theme: 'mountain', must: [['alps', 'alpine', 'mountain']] },
  { query: 'luxury', theme: 'ambition', must: [['luxury']] },
  { query: 'snow', theme: 'mountain', must: [['snow', 'winter']] },
];
// Quote themes tried after the clips' own themes.
const GENERIC_QUOTE_THEMES = ['ambition', 'mountain', 'discipline'];

const MIN_SHORT_SIDE = 1080; // px, on the downloaded file
const MAX_UPSCALE = 1.5;
const PREFERRED_DURATION = [4, 20]; // s; longer clips are often compilations whose middle is off-subject
const PAGES_PER_QUERY = 3; // 20 results each, before moving on to the fallback queries
// Per run, Pixabay API searches (its quota); clip files come from Pixabay's CDN and are not counted.
const MAX_API_REQUESTS = 30;
const API_INTERVAL_MS = 1000;
const CACHE_HOURS = 24; // Pixabay asks API clients to cache search results for 24 hours
// Never in a reel, whatever the slot: children, places of worship.
const REEL_AVOID = /\b(baby|babies|child|children|kids?|toddler|mosque|church|cathedral|temple|islam|islamic|chapel)\b/i;
// Generated or computer-made footage, matched on the tags and on the author name.
const SYNTHETIC = /\bai\b|generat|render|\b3d\b|cgi|animat|illustrat|cartoon|virtual/i;

// ---- Arguments and paths -----------------------------------------------------------------------

const args = parseArgs();
const date = typeof args.date === 'string' ? args.date : new Date().toLocaleDateString('sv-SE');
const reelCount = Number(args.count ?? 1);
const quoteCount = Number(args.quotes ?? 3);
if (!Number.isInteger(reelCount) || reelCount < 1) throw new Error('--count must be a positive integer');
if (!Number.isInteger(quoteCount) || quoteCount < 0 || quoteCount > MAX_QUOTES) throw new Error(`--quotes must be 0 to ${MAX_QUOTES}`);

const VIDEOS = path.join(ROOT, 'videos');
const STOCK = path.join(VIDEOS, 'stock');
const DOWNLOADS = path.join(VIDEOS, 'pixabay');
const CACHE = path.join(VIDEOS, '.cache');
const REELS = path.join(OUT, 'reels');
const SEEN_FILE = path.join(STATE, 'pixabay-seen.json');
const USED_QUOTES_FILE = path.join(STATE, 'used-reels.json'); // separate from the posts' state/used.json
const CARD_TEMPLATE = path.join(SRC, 'reel-card.html');

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
const localClips = await localStockClips();
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
const KEY = process.env.PIXABAY_API_KEY?.trim();
if (SLOTS.some((_, i) => !localClips[i]) && !KEY) {
  console.error('PIXABAY_API_KEY is missing from .env. Carl sets it from his own Terminal; stopping.');
  process.exit(1);
}

async function localStockClips() {
  const files = existsSync(STOCK) ? (await readdir(STOCK)).filter((f) => /^\d\d_.*\.mp4$/i.test(f)).sort() : [];
  return SLOTS.map((_, i) => files.find((f) => f.startsWith(`${String(i + 1).padStart(2, '0')}_`)) ?? null);
}

// ---- Pixabay -----------------------------------------------------------------------------------

let apiRequests = 0;
let lastApiCall = 0;

// One page of results, from the 24 h cache when possible. Returns null once the run's budget is spent.
async function search(query, page = 1) {
  const params = new URLSearchParams({
    q: query, video_type: 'film', order: 'popular', per_page: '20', safesearch: 'true', min_height: '1080',
  });
  if (page > 1) params.set('page', String(page)); // page 1 keeps the cache key of earlier runs
  const cacheFile = path.join(CACHE, `${createHash('sha1').update(params.toString()).digest('hex')}.json`);
  const cached = await readJson(cacheFile, null);
  if (cached && Date.now() - cached.fetched_at < CACHE_HOURS * 3600e3) return cached.hits;
  if (apiRequests >= MAX_API_REQUESTS) return null;

  apiRequests++;
  const wait = lastApiCall + API_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastApiCall = Date.now();
  params.set('key', KEY);
  const res = await fetch(`https://pixabay.com/api/videos/?${params}`);
  if (!res.ok) throw new Error(`Pixabay API answered HTTP ${res.status} for "${query}"${res.status === 400 ? ' (check PIXABAY_API_KEY)' : ''}`);
  const { hits = [] } = await res.json();
  await writeJson(cacheFile, { fetched_at: Date.now(), query, page, hits });
  return hits;
}

// The largest rendition with at least MIN_SHORT_SIDE px on its short side.
function bestFile(hit) {
  return Object.values(hit.videos ?? {})
    .filter((v) => v?.url && Math.min(v.width, v.height) >= MIN_SHORT_SIDE)
    .sort((a, b) => b.width * b.height - a.width * a.height || (b.size ?? 0) - (a.size ?? 0))[0] ?? null;
}

const hasTag = (tags, word) => new RegExp(`\\b${word}s?\\b`, 'i').test(tags);

function candidate(hit, excluded, { must, avoid = [] }) {
  if (excluded.has(String(hit.id))) return null;
  if (hit.isAiGenerated || hit.isGRated === false) return null;
  const tags = hit.tags ?? '';
  if (SYNTHETIC.test(`${tags} ${hit.user ?? ''}`) || AVOID.test(tags) || SUGGESTIVE.test(tags) || REEL_AVOID.test(tags)) return null;
  if (!must.every((group) => group.some((word) => hasTag(tags, word))) || avoid.some((word) => hasTag(tags, word))) return null;
  if (!(hit.duration >= CLIP_SECONDS + 0.5)) return null;
  const file = bestFile(hit);
  if (!file) return null;
  const upscale = Math.max(W / file.width, H / file.height); // cover 1080x1920, never stretched
  if (upscale > MAX_UPSCALE) return null;
  const personRank = PERSON.test(tags) && !DISCREET_POSE.test(tags) ? 1 : 0;
  return { hit, file, vertical: file.height > file.width, upscale, personRank };
}

// Clips Pixabay does not flag as low quality when there are any; among them vertical clips when
// there are any; then 4 to 20 s, longer, shorter; then people seen from the back; then popularity.
function durationRank({ hit }) {
  const [min, max] = PREFERRED_DURATION;
  return hit.duration >= min && hit.duration <= max ? 0 : hit.duration > max ? 1 : 2;
}
function pick(hits, excluded, rules) {
  let pool = hits.map((h) => candidate(h, excluded, rules)).filter(Boolean);
  if (pool.some((c) => !c.hit.isLowQuality)) pool = pool.filter((c) => !c.hit.isLowQuality);
  if (pool.some((c) => c.vertical)) pool = pool.filter((c) => c.vertical);
  return pool.sort((a, b) => durationRank(a) - durationRank(b) || a.personRank - b.personRank)[0] ?? null;
}

async function download(c) {
  const file = path.join(DOWNLOADS, `${c.hit.id}_${c.file.width}x${c.file.height}.mp4`);
  if (existsSync(file) && (await stat(file)).size > 0) return file;
  await mkdir(DOWNLOADS, { recursive: true });
  const res = await fetch(c.file.url);
  if (!res.ok || !res.body) throw new Error(`clip download failed (Pixabay ${c.hit.id}): HTTP ${res.status}`);
  const partial = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
  await rename(partial, file);
  return file;
}

// ---- Choosing clips and quotes -----------------------------------------------------------------

async function chooseClips(excluded) {
  const clips = [];
  const notes = [];
  for (const [i, slotDef] of SLOTS.entries()) {
    const slot = String(i + 1).padStart(2, '0');
    if (localClips[i]) {
      clips.push({ slot, query: slotDef.query, theme: slotDef.theme, source: 'local', file: path.join(STOCK, localClips[i]), credit: null });
      continue;
    }
    let found = null;
    attempts: for (const attempt of [slotDef, ...FALLBACKS]) {
      for (let page = 1; page <= PAGES_PER_QUERY; page++) {
        const hits = await search(attempt.query, page);
        if (!hits) break; // API budget spent: only cached pages are left
        const chosen = pick(hits, excluded, attempt);
        if (chosen) { found = { attempt, chosen, page }; break attempts; }
        if (hits.length < 20) break; // last page
      }
    }
    if (!found) throw new Error(`slot ${slot} ("${slotDef.query}"): no unused clip left, even with the fallback queries`);
    const { attempt, chosen, page } = found;
    if (attempt !== slotDef) notes.push(`Slot ${slot}: nothing usable for "${slotDef.query}", used the fallback query "${attempt.query}".`);
    excluded.add(String(chosen.hit.id));
    clips.push({
      slot, query: slotDef.query, usedQuery: attempt.query, page, theme: attempt.theme, source: 'pixabay', candidate: chosen,
      credit: { author: chosen.hit.user, page: chosen.hit.pageURL, id: chosen.hit.id },
    });
  }
  return { clips, notes };
}

// Quote k sits over clips 3k+1..3k+3 and takes the theme of one of them when it can; the preferred
// clip rotates from reel to reel. Quotes not yet posted come first, then the bank order.
function chooseQuotes(clips, reelIndex, pool) {
  const chosen = [];
  for (let k = 0; k < quoteCount; k++) {
    const groupThemes = clips.slice(k * CLIPS_PER_QUOTE, (k + 1) * CLIPS_PER_QUOTE).map((c) => c.theme);
    const shift = reelIndex % groupThemes.length;
    const order = [...new Set([...groupThemes.slice(shift), ...groupThemes.slice(0, shift), ...GENERIC_QUOTE_THEMES])];
    let quote = null;
    for (const theme of order) {
      quote = pool.filter((q) => q.theme === theme).sort((a, b) => Number(a.posted) - Number(b.posted) || a.id.localeCompare(b.id))[0];
      if (quote) break;
    }
    if (!quote) throw new Error('no quote left for reels (state/used-reels.json)');
    pool.splice(pool.indexOf(quote), 1);
    chosen.push({ ...quote, clips: `${k * CLIPS_PER_QUOTE + 1}-${(k + 1) * CLIPS_PER_QUOTE}`, matched: groupThemes.includes(quote.theme) });
  }
  return chosen;
}

function nextReelBase(taken) {
  for (let n = 1; ; n++) {
    const base = path.join(REELS, `${date}_luxury_${n}`);
    if (!taken.has(base) && !existsSync(`${base}.mp4`)) {
      taken.add(base);
      return base;
    }
  }
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
// A quote spans three clips: it fades in at the start of the first and out at the end of the third.
function quoteFade(position) {
  const fades = ['format=rgba'];
  if (position === 0) fades.push(`fade=t=in:st=0:d=${QUOTE_FADE}:alpha=1`);
  if (position === CLIPS_PER_QUOTE - 1) fades.push(`fade=t=out:st=${CLIP_SECONDS - QUOTE_FADE}:d=${QUOTE_FADE}:alpha=1`);
  return fades.join(',');
}
const SEGMENT_CODEC = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-video_track_timescale', String(FPS * 1000)];
const frames = (seconds) => String(Math.round(seconds * FPS));
const still = (png) => ['-framerate', String(FPS), '-loop', '1', '-i', png];
const TOTAL = TITLE_SECONDS + SLOTS.length * CLIP_SECONDS + END_SECONDS;

// ---- Producing one reel ------------------------------------------------------------------------

async function produce(plan, cards) {
  const { base, clips, quotes } = plan;
  const outputs = { video: `${base}.mp4`, cover: `${base}_cover.jpg`, notes: `${base}.txt` };
  const work = path.join(REELS, `.build-${path.basename(base)}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const quoteCards = quotes.map((_, k) => path.join(work, `quote_${k + 1}.png`));
  if (quotes.length)
    await renderCards(CARD_TEMPLATE, quotes.map((q, k) => ({
      out: quoteCards[k], width: W, height: H, variant: 'quote', fill: { 'overlay-quote': q.text }, transparent: true,
    })));

  const segments = [];
  const seg = (name) => { const f = path.join(work, `${name}.mp4`); segments.push(f); return f; };
  ffmpeg(...still(cards.title), '-vf', `fade=t=in:st=0:d=${TITLE_FADE_IN},format=yuv420p`, '-frames:v', frames(TITLE_SECONDS), ...SEGMENT_CODEC, seg('00_title'));

  const grade = gradeFilter();
  for (const [i, c] of clips.entries()) {
    const info = probe(c.file);
    if (info.duration < CLIP_SECONDS) throw new Error(`slot ${c.slot}: clip is only ${info.duration.toFixed(2)} s long`);
    if (Math.max(W / info.width, H / info.height) > MAX_UPSCALE)
      throw new Error(`slot ${c.slot}: ${info.width}x${info.height} would need more than ${MAX_UPSCALE}x upscaling`);
    c.start = Math.max(0, (info.duration - CLIP_SECONDS) / 2); // 1.5 s from the middle
    c.size = `${info.width}x${info.height}`;
    const k = Math.floor(i / CLIPS_PER_QUOTE);
    const withQuote = k < quotes.length;
    const graph = withQuote
      ? `[0:v]${fitFilter(info.width, info.height)},${grade}[g];[g][1:v]overlay=0:0[l];[2:v]${quoteFade(i % CLIPS_PER_QUOTE)}[q];[l][q]overlay=0:0,format=yuv420p[v]`
      : `[0:v]${fitFilter(info.width, info.height)},${grade}[g];[g][1:v]overlay=0:0,format=yuv420p[v]`;
    ffmpeg('-ss', c.start.toFixed(3), '-i', c.file, ...still(cards.label), ...(withQuote ? still(quoteCards[k]) : []),
      '-filter_complex', graph, '-map', '[v]', '-an', '-frames:v', frames(CLIP_SECONDS), ...SEGMENT_CODEC, seg(c.slot));
  }

  ffmpeg(...still(cards.end), '-vf', `fade=t=out:st=${END_SECONDS - END_FADE_OUT}:d=${END_FADE_OUT},format=yuv420p`, '-frames:v', frames(END_SECONDS), ...SEGMENT_CODEC, seg('11_end'));

  // Hard cuts, H.264 yuv420p ~12 Mbps, silent AAC.
  const list = path.join(work, 'segments.txt');
  await writeFile(list, segments.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  ffmpeg('-f', 'concat', '-safe', '0', '-i', list,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-map', '0:v', '-map', '1:a', '-t', TOTAL.toFixed(3),
    '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', String(FPS),
    '-b:v', VIDEO_BITRATE, '-maxrate', '15M', '-bufsize', '24M',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputs.video);
  ffmpeg('-i', cards.title, '-q:v', '2', outputs.cover);

  // Verify: duration, size, codecs, and "it plays" (every frame decodes; ffmpeg reports problems on stderr).
  const out = probe(outputs.video);
  const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', outputs.video, '-f', 'null', '-'], { encoding: 'utf8' });
  const checks = {
    [`duration ${out.duration.toFixed(2)} s`]: Math.abs(out.duration - TOTAL) < 0.1,
    [`${out.width}x${out.height}`]: out.width === W && out.height === H,
    [`${out.codec} ${out.pixFmt}, audio ${out.audio}`]: out.codec === 'h264' && out.pixFmt === 'yuv420p' && out.audio === 'aac',
    'decodes end to end': decode.status === 0 && decode.stderr.trim() === '',
  };

  const clipLines = clips.map((c) =>
    `${c.slot}  ${c.query}${c.usedQuery && c.usedQuery !== c.query ? ` (fallback: ${c.usedQuery})` : ''}\n` +
    `    ${c.source === 'local' ? `local clip ${path.relative(ROOT, c.file)}` : `Pixabay ${c.credit.id}, ${c.credit.page}`}\n` +
    `    source ${c.size}, 1.5 s from ${c.start.toFixed(2)} s`);
  const quoteLines = quotes.map((q) => `${q.id} over clips ${q.clips} [${q.theme}${q.matched ? '' : ', no clip of this theme'}]: ${q.text}`);
  const credits = clips.filter((c) => c.credit).map((c) => `Video by ${c.credit.author} on Pixabay (${c.credit.page})`);
  await writeFile(outputs.notes, `Luxury reel ${path.basename(base)}
${path.basename(outputs.video)}: ${W}x${H}, ${FPS} fps, ${out.duration.toFixed(2)} s, H.264 ${VIDEO_BITRATE}bps, silent AAC (add music in Instagram).
Structure: title card ${TITLE_SECONDS} s, 10 clips x ${CLIP_SECONDS} s, end card ${END_SECONDS} s ("${END_CARD_QUOTE}").

Quotes
${quoteLines.join('\n') || '(none)'}

Clips
${clipLines.join('\n')}
${plan.notes.length ? `\nNotes\n${plan.notes.join('\n')}\n` : ''}
Credits
${credits.join('\n') || '(local clips only)'}
`);

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([what]) => what);
  if (!failed.length) await rm(work, { recursive: true, force: true }); // kept for inspection on failure
  return { outputs, checks, failed, sizeMB: (await stat(outputs.video)).size / 1e6 };
}

// ---- Main --------------------------------------------------------------------------------------

const seen = await readJson(SEEN_FILE, {});
seen.used ??= {};
seen.rejected ??= {};
const usedQuotes = await readJson(USED_QUOTES_FILE, {});
const postedQuotes = await readJson(path.join(STATE, 'used.json'), {});
const excluded = new Set([...Object.keys(seen.used), ...Object.keys(seen.rejected)]);

// Quotes still available for reels: not yet in a reel, in season, not the end-card line, 2 lines max at 60 px.
let quotePool = [];
if (quoteCount) {
  const season = seasonFor(date);
  const candidates = (await readJson(path.join(QUOTES, 'quotes.json')))
    .filter((q) => !usedQuotes[q.id] && inSeason(q, season) && q.text !== END_CARD_QUOTE);
  const lines = await measureLines(CARD_TEMPLATE, { width: W, height: H, variant: 'quote', id: 'overlay-quote' }, candidates.map((q) => q.text));
  quotePool = candidates.filter((_, i) => lines[i] <= 2).map((q) => ({ ...q, posted: Boolean(postedQuotes[q.id]) }));
}

// Plan every reel first, so clips and quotes all differ and a dry run shows everything.
const plans = [];
const takenBases = new Set();
for (let r = 0; r < reelCount; r++) {
  try {
    const { clips, notes } = await chooseClips(excluded);
    const quotes = chooseQuotes(clips, r, quotePool);
    plans.push({ base: nextReelBase(takenBases), clips, quotes, notes });
  } catch (err) {
    if (!plans.length) throw err;
    console.log(`Only ${plans.length} of ${reelCount} reels can be planned: ${err.message}.`);
    break;
  }
}

for (const plan of plans) {
  console.log(`\n${path.basename(plan.base)}`);
  for (const c of plan.clips) {
    const detail = c.source === 'local' ? `local ${path.basename(c.file)}`
      : `Pixabay ${c.credit.id} by ${c.credit.author}, ${c.candidate.file.width}x${c.candidate.file.height}, ${c.candidate.hit.duration}s`;
    console.log(`  ${c.slot}  ${(c.usedQuery ?? c.query).padEnd(22)} ${detail}`);
  }
  for (const q of plan.quotes) console.log(`  quote ${q.clips}  ${q.id} [${q.theme}] ${q.text}`);
  for (const n of plan.notes) console.log(`  ${n}`);
}
console.log(`\nPixabay API requests this run: ${apiRequests} of ${MAX_API_REQUESTS}`);
if (args['dry-run']) {
  // The plan, for review: clip ids, files and cut points can be checked before rendering.
  const planFile = path.join(REELS, `.plan-${date}.json`);
  await writeJson(planFile, plans.map((p) => ({
    reel: path.basename(p.base),
    quotes: p.quotes.map(({ id, text, theme, clips }) => ({ id, text, theme, clips })),
    clips: p.clips.map((c) => ({
      slot: c.slot, query: c.usedQuery ?? c.query, source: c.source, id: c.credit?.id ?? null,
      url: c.candidate?.file.url ?? null, file: c.candidate ? path.join(DOWNLOADS, `${c.candidate.hit.id}_${c.candidate.file.width}x${c.candidate.file.height}.mp4`) : c.file,
      duration: c.candidate?.hit.duration ?? null, tags: c.candidate?.hit.tags ?? null,
    })),
  })));
  console.log(`Dry run: nothing downloaded, rendered or recorded. Plan: ${path.relative(ROOT, planFile)}`);
  process.exit(0);
}

// Title, end and label cards are the same for every reel.
await mkdir(REELS, { recursive: true });
const cardsDir = path.join(REELS, `.cards-${date}`);
const cards = { title: path.join(cardsDir, 'title.png'), end: path.join(cardsDir, 'end.png'), label: path.join(cardsDir, 'label.png') };
await renderCards(CARD_TEMPLATE, [
  { out: cards.title, width: W, height: H, variant: 'title' },
  { out: cards.end, width: W, height: H, variant: 'end' },
  { out: cards.label, width: W, height: H, variant: 'label', transparent: true },
]);

let failures = 0;
for (const plan of plans) {
  for (const c of plan.clips.filter((c) => c.source === 'pixabay')) c.file = await download(c.candidate);
  const { outputs, checks, failed, sizeMB } = await produce(plan, cards);
  console.log(`\n${path.relative(ROOT, outputs.video)}  (${sizeMB.toFixed(1)} MB)`);
  for (const [what, ok] of Object.entries(checks)) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (failed.length) { failures++; continue; }
  // Recorded only for a verified reel.
  const reel = path.basename(outputs.video);
  for (const c of plan.clips.filter((c) => c.credit))
    seen.used[c.credit.id] = { slot: c.slot, query: c.usedQuery, author: c.credit.author, page: c.credit.page, reel };
  for (const q of plan.quotes) usedQuotes[q.id] = reel;
  await writeJson(SEEN_FILE, seen);
  await writeJson(USED_QUOTES_FILE, usedQuotes);
}
await rm(cardsDir, { recursive: true, force: true });
if (failures) {
  console.error(`${failures} reel(s) failed verification; their build folders were kept in out/reels/.`);
  process.exit(1);
}
