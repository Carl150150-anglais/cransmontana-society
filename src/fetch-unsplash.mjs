// Fetches portrait photos from the Unsplash API (demo tier) into photos/unsplash/.
// Usage: npm run fetch [-- --per-theme 4]
//
// Demo-tier etiquette: at most 1 request per second and 40 API requests per run.
// Every call to api.unsplash.com counts, including the download_location tracking pings
// that the API guidelines require for each photo we download.
import { readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { ROOT, PHOTOS_UNSPLASH, STATE, THEMES, readJson, writeJson, parseArgs } from './paths.mjs';

dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
const KEY = process.env.UNSPLASH_ACCESS_KEY?.trim();
if (!KEY) {
  console.error('UNSPLASH_ACCESS_KEY is missing from .env. Carl sets it from his own Terminal; stopping.');
  process.exit(1);
}

const API = 'https://api.unsplash.com';
const MAX_REQUESTS = 40;
const MIN_INTERVAL_MS = 1100;
const MIN_HEIGHT = 2000;
const UTM = 'utm_source=cransmontana_society&utm_medium=referral';
const SEEN_FILE = path.join(STATE, 'unsplash-seen.json');
const PER_THEME = Number(parseArgs()['per-theme'] ?? 4);

const BASE_QUERIES = {
  cars: ['luxury car mountain road night', 'sports car alps', 'dark luxury car garage'],
  mountain: ['swiss alps winter sunrise', 'valais mountains', 'alpine peak clouds moody', 'crans-montana'],
  // Fire and alcohol imagery is avoided, as in the quotes (no fireplace, candlelight or champagne).
  chalets: ['swiss chalet snow night', 'alpine chalet interior wood', 'wooden chalet mountain view'],
  watches: ['luxury watch macro dark', 'swiss watch wrist'],
  ski: ['ski slope alps sunrise', 'skier powder alps'],
  golf: ['golf course mountains morning'],
  dining: ['fine dining table dark', 'gourmet plate dark'],
};
const QUERIES = {
  ...BASE_QUERIES,
  ambition: [...BASE_QUERIES.mountain, ...BASE_QUERIES.cars, ...BASE_QUERIES.watches],
  discipline: [...BASE_QUERIES.watches, ...BASE_QUERIES.mountain, ...BASE_QUERIES.cars],
};
// Every other query asks for dark photos.
const DARK = new Set(Object.values(BASE_QUERIES).flat().filter((_, i) => i % 2 === 0));

// Photo descriptions that would clash with the page rules (fire, alcohol, parties, loss)
// or keep showing up off-topic (smartwatches, cable cars under "car", glassware on tables).
const AVOID = /\b(smart ?watch(es)?|apple watch|cable car|glasses|fire|fires|fireplace|firework|fireworks|campfire|bonfire|flames?|candles?|candlelight|burning|smoke|smoking|sparklers?|champagne|wine|cocktails?|beer|whisk(e)?y|vodka|alcohol|drinks?|bar|pub|nightclub|nightlife|party|parties|celebration|new year|dj|concert|accident|crash|funeral|memorial|grave|cemetery)\b/i;

let requests = 0;
let lastRequestAt = 0;
async function throttled(url, opts = {}) {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  return fetch(url, opts);
}

let remainingQuota = Infinity;
async function api(pathAndQuery) {
  if (requests >= MAX_REQUESTS) throw new Error('request budget exhausted');
  requests++;
  const res = await throttled(`${API}${pathAndQuery}`, {
    headers: { Authorization: `Client-ID ${KEY}`, 'Accept-Version': 'v1' },
  });
  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  if (Number.isFinite(remaining)) remainingQuota = remaining;
  if (!res.ok) {
    const err = new Error(`Unsplash API ${res.status} on ${pathAndQuery.split('?')[0]}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
const canSpend = (n) => requests + n <= MAX_REQUESTS && remainingQuota >= n + 1;

const seen = await readJson(SEEN_FILE, { photos: {}, queryCursor: {}, queryPage: {} });
await mkdir(PHOTOS_UNSPLASH, { recursive: true });
const files = await readdir(PHOTOS_UNSPLASH);
const onDisk = (theme) => files.filter((f) => f.startsWith(`${theme}_`) && f.endsWith('.jpg')).length;
const need = Object.fromEntries(THEMES.map((t) => [t, Math.max(0, PER_THEME - onDisk(t))]));
const got = Object.fromEntries(THEMES.map((t) => [t, 0]));

// Search results are pooled by query, so one search can serve mountain, ambition and discipline.
const pools = new Map();
const takenThisRun = new Set();
const searchedThisRun = Object.fromEntries(THEMES.map((t) => [t, 0]));

function takeFromPools(theme) {
  for (const query of QUERIES[theme]) {
    const pool = pools.get(query);
    while (pool?.length) {
      const photo = pool.shift();
      if (!takenThisRun.has(photo.id) && !seen.photos[photo.id]) return { photo, query };
    }
  }
  return null;
}

// One page of results for a query, in black only or in any colour. Pages are tracked per variant.
async function searchPage(query, black) {
  const key = black ? `${query}|black` : query;
  const page = (seen.queryPage[key] ?? 0) + 1;
  const params = new URLSearchParams({
    query, page, per_page: 10, orientation: 'portrait', content_filter: 'high',
    ...(black ? { color: 'black' } : {}),
  });
  const data = await api(`/search/photos?${params}`);
  // Rotation state only advances once a search has succeeded.
  seen.queryPage[key] = page;
  const usable = data.results.filter(
    (p) => p.height >= MIN_HEIGHT && !AVOID.test(`${p.alt_description ?? ''} ${p.description ?? ''}`)
  );
  console.log(`  search "${query}"${black ? ' (black)' : ''} p${page}: ${data.results.length} results, ${usable.length} usable`);
  return usable;
}

async function search(theme) {
  const cursor = seen.queryCursor[theme] ?? 0;
  const query = QUERIES[theme][cursor % QUERIES[theme].length];
  if (pools.has(query)) { seen.queryCursor[theme] = cursor + 1; return; } // already searched this run
  let usable = await searchPage(query, DARK.has(query));
  // A black-only search can come back empty; try the same query in any colour.
  if (!usable.length && DARK.has(query) && canSpend(2)) usable = await searchPage(query, false);
  seen.queryCursor[theme] = cursor + 1;
  pools.set(query, usable);
}

async function download(theme, photo, query) {
  const base = `${theme}_${photo.id}`;
  const jpg = path.join(PHOTOS_UNSPLASH, `${base}.jpg`);
  const res = await throttled(`${photo.urls.raw}&w=1080&h=1350&fit=crop&crop=entropy&q=85&fm=jpg`);
  if (!res.ok) throw new Error(`image download failed (${photo.id}): HTTP ${res.status}`);
  await writeFile(jpg, Buffer.from(await res.arrayBuffer()));
  try {
    // Required by the API guidelines for every downloaded photo.
    await api(`${new URL(photo.links.download_location).pathname}${new URL(photo.links.download_location).search}`);
  } catch (err) {
    await rm(jpg, { force: true });
    throw err;
  }
  const meta = {
    id: photo.id,
    theme,
    query,
    photographer: photo.user.name,
    username: photo.user.username,
    profile_link: `${photo.user.links.html}?${UTM}`,
    photo_link: `${photo.links.html}?${UTM}`,
    unsplash_link: `https://unsplash.com/?${UTM}`,
    alt: photo.alt_description ?? photo.description ?? '',
    width: photo.width,
    height: photo.height,
    color: photo.color,
    downloaded_at: new Date().toISOString(),
  };
  await writeFile(path.join(PHOTOS_UNSPLASH, `${base}.json`), JSON.stringify(meta, null, 2) + '\n');
  seen.photos[photo.id] = { theme, photographer: meta.photographer, username: meta.username, downloaded_at: meta.downloaded_at };
  takenThisRun.add(photo.id);
  got[theme]++;
  need[theme]--;
}

console.log(`Fetching up to ${PER_THEME} photos per theme (budget ${MAX_REQUESTS} API requests).`);
let stopReason = null;
try {
  // Round-robin across themes so a short budget still spreads photos evenly.
  while (THEMES.some((t) => need[t] > 0) && !stopReason) {
    let progressed = false;
    for (const theme of THEMES) {
      if (need[theme] <= 0) continue;
      let pick = takeFromPools(theme);
      while (!pick && searchedThisRun[theme] < QUERIES[theme].length) {
        if (!canSpend(2)) break;
        searchedThisRun[theme]++;
        await search(theme);
        pick = takeFromPools(theme);
      }
      if (!pick) {
        if (!canSpend(2)) { stopReason = 'request budget reached'; break; }
        need[theme] = 0; // every query for this theme came back empty this run
        console.log(`  ${theme}: no new usable photos left in this run's queries`);
        continue;
      }
      if (!canSpend(1)) { stopReason = 'request budget reached'; break; }
      await download(theme, pick.photo, pick.query);
      progressed = true;
    }
    if (!progressed && !stopReason) break;
  }
} catch (err) {
  stopReason =
    err.status === 401 ? 'Unsplash rejected UNSPLASH_ACCESS_KEY (401). Check the Access Key in .env'
    : err.status === 403 || err.status === 429 ? 'Unsplash rate limit reached'
    : err.message;
} finally {
  await writeJson(SEEN_FILE, seen);
}

const total = Object.values(got).reduce((a, b) => a + b, 0);
console.log(`\nDownloaded ${total} photo(s) using ${requests} API request(s).`);
console.log(THEMES.map((t) => `  ${t}: +${got[t]} (now ${onDisk(t) + got[t]} on disk)`).join('\n'));
const short = THEMES.filter((t) => onDisk(t) + got[t] < PER_THEME);
if (stopReason) console.log(`Stopped: ${stopReason}.`);
if (short.length) console.log(`Still short of ${PER_THEME}: ${short.join(', ')}. Run npm run fetch again in an hour (demo limit is 50 requests/hour).`);
if (stopReason && !['request budget reached', 'Unsplash rate limit reached'].includes(stopReason)) process.exit(1);
