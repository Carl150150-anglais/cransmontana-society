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

// Displayed luxury first, anchored in snow, Alps and chalets where the query allows; then the calmer originals.
const BASE_QUERIES = {
  cars: [
    'porsche 911 snow', 'ferrari night', 'lamborghini mountain road', 'mercedes g class snow', 'luxury car chalet',
    'luxury car mountain road night', 'sports car alps', 'dark luxury car garage',
  ],
  mountain: [
    'private jet snow tarmac', 'helicopter alps',
    'swiss alps winter sunrise', 'valais mountains', 'alpine peak clouds moody', 'crans-montana',
  ],
  chalets: [
    'luxury chalet interior champagne', 'chalet hot tub snow night',
    'swiss chalet snow night', 'alpine chalet interior wood', 'wooden chalet mountain view',
  ],
  watches: ['rolex watch macro', 'hublot watch', 'luxury watch diamonds dark', 'luxury watch macro dark', 'swiss watch wrist'],
  ski: ['ski slope alps sunrise', 'skier powder alps'],
  golf: ['golf course mountains morning'],
  dining: ['champagne chalet fireplace', 'fine dining table dark', 'gourmet plate dark'],
  jewels: ['diamond ring macro dark', 'diamond necklace'],
  fashion: [
    'hermes birkin bag', 'louis vuitton bag luxury', 'moncler jacket snow',
    'elegant woman fur coat snow', 'woman evening dress chalet', 'woman luxury ski outfit',
  ],
};
const QUERIES = {
  ...BASE_QUERIES,
  ambition: [...BASE_QUERIES.mountain, ...BASE_QUERIES.cars, ...BASE_QUERIES.watches],
  discipline: [...BASE_QUERIES.watches, ...BASE_QUERIES.mountain, ...BASE_QUERIES.cars],
};
// Every other query asks for dark photos.
const DARK = new Set(Object.values(BASE_QUERIES).flat().filter((_, i) => i % 2 === 0));

// Photo descriptions that would clash with the page rules (parties, nightlife, loss) or keep showing up
// off-topic (smartwatches, cable cars under "car"). Champagne and fireplaces are wanted for chalets and dining.
const AVOID = /\b(smart ?watch(es)?|apple watch|cable car|firework|fireworks|sparklers?|campfire|bonfire|burning (house|building|car)|smoking|cigarettes?|cocktails?|beer|whisk(e)?y|vodka|bar|pub|nightclub|nightlife|party|parties|celebration|new year|dj|concert|accident|crash|funeral|memorial|grave|cemetery)\b/i;
// Photos of people: seen from the back, in profile or in silhouette come first; suggestive poses are never kept.
const PERSON = /\b(woman|women|man|men|girl|boy|person|people|lady|model|couple|skier|snowboarder)\b/i;
const DISCREET_POSE = /\b(back|behind|silhouette|silhouetted|profile|rear|walking away|looking away|facing away|side view|from afar|in the distance)\b/i;
const SUGGESTIVE = /\b(lingerie|bikini|underwear|swimsuit|swimwear|bra|topless|shirtless|naked|nude|sexy|seductive|sensual|provocative|erotic|cleavage|in bed|lying on (a |the )?bed)\b/i;
const IN_WATER = /\b(hot tub|jacuzzi|bath|bathtub|pool|sauna)\b/i;

const describe = (p) => `${p.alt_description ?? ''} ${p.description ?? ''} ${(p.tags ?? []).map((t) => t.title).join(' ')}`;
function acceptable(p) {
  const text = describe(p);
  return !AVOID.test(text) && !SUGGESTIVE.test(text) && !(PERSON.test(text) && IN_WATER.test(text));
}
// 0 = no person, or a person seen from the back / in profile / in silhouette; 1 = any other photo of a person.
const poseRank = (p) => (PERSON.test(describe(p)) && !DISCREET_POSE.test(describe(p)) ? 1 : 0);

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

const seen = await readJson(SEEN_FILE, {});
for (const field of ['photos', 'queryCursor', 'queryPage', 'queryLeft', 'queryDone']) seen[field] ??= {};
await mkdir(PHOTOS_UNSPLASH, { recursive: true });
const files = await readdir(PHOTOS_UNSPLASH);
const onDisk = (theme) => files.filter((f) => f.startsWith(`${theme}_`) && f.endsWith('.jpg')).length;
const need = Object.fromEntries(THEMES.map((t) => [t, Math.max(0, PER_THEME - onDisk(t))]));
const got = Object.fromEntries(THEMES.map((t) => [t, 0]));

// Search results are pooled by query, so one search can serve mountain, ambition and discipline.
const pools = new Map();
const poolKeys = new Map(); // query -> variant key ("query" or "query|black") the pool came from
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

// One page of results for a query, in black only or in any colour. Pages are tracked per variant:
// a page that still had unused photos at the end of a run is asked for again, and a variant whose
// last page is used up is skipped without a request (returns null).
async function searchPage(query, black) {
  const key = black ? `${query}|black` : query;
  const again = Boolean(seen.queryLeft[key]);
  if (seen.queryDone[key] && !again) return null;
  const page = again ? seen.queryPage[key] : (seen.queryPage[key] ?? 0) + 1;
  const params = new URLSearchParams({
    query, page, per_page: 10, orientation: 'portrait', content_filter: 'high',
    ...(black ? { color: 'black' } : {}),
  });
  const data = await api(`/search/photos?${params}`);
  // Rotation state only advances once a search has succeeded.
  seen.queryPage[key] = page;
  delete seen.queryLeft[key];
  if (page >= data.total_pages) seen.queryDone[key] = true;
  poolKeys.set(query, key);
  const usable = data.results
    .filter((p) => p.height >= MIN_HEIGHT && acceptable(p))
    .sort((a, b) => poseRank(a) - poseRank(b)); // stable: keeps Unsplash relevance order within each rank
  console.log(`  search "${query}"${black ? ' (black)' : ''} p${page}: ${data.results.length} results, ${usable.length} usable`);
  return usable;
}

async function search(theme) {
  const cursor = seen.queryCursor[theme] ?? 0;
  const query = QUERIES[theme][cursor % QUERIES[theme].length];
  if (pools.has(query)) { seen.queryCursor[theme] = cursor + 1; return; } // already searched this run
  let usable = DARK.has(query) ? await searchPage(query, true) : null;
  // A black-only search can come back empty or be used up; try the same query in any colour.
  // When the black search made no request, the caller's budget check already covers this one.
  if (!usable?.length && (usable === null || canSpend(2))) usable = await searchPage(query, false);
  seen.queryCursor[theme] = cursor + 1;
  pools.set(query, usable ?? []);
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
  // Pages that still hold unused photos are asked for again next run instead of skipping to the next page.
  for (const [query, pool] of pools) if (pool.some((p) => !seen.photos[p.id])) seen.queryLeft[poolKeys.get(query)] = true;
  await writeJson(SEEN_FILE, seen);
}

const total = Object.values(got).reduce((a, b) => a + b, 0);
console.log(`\nDownloaded ${total} photo(s) using ${requests} API request(s).`);
console.log(THEMES.map((t) => `  ${t}: +${got[t]} (now ${onDisk(t) + got[t]} on disk)`).join('\n'));
const short = THEMES.filter((t) => onDisk(t) + got[t] < PER_THEME);
if (stopReason) console.log(`Stopped: ${stopReason}.`);
if (short.length) console.log(`Still short of ${PER_THEME}: ${short.join(', ')}. Run npm run fetch again in an hour (demo limit is 50 requests/hour).`);
if (stopReason && !['request budget reached', 'Unsplash rate limit reached'].includes(stopReason)) process.exit(1);
