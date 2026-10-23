// Fetches portrait photos from the Unsplash API (demo tier) into photos/unsplash/.
// Usage:
//   npm run fetch [-- --per-theme 4]            download until each theme has that many unused photos
//   npm run fetch -- --preview [--per-theme 5]  search only: candidates go on review sheets in out/candidates/
//   npm run fetch -- --keep id1,id2 [--score 5] [--theme cars]
//                                                approve candidates (optionally under another theme) and download them
//   npm run fetch -- --keep                      download approved candidates a previous run had no budget for
//   npm run fetch -- --reject id1,id2            drop candidates for good
//
// Demo-tier etiquette: at most 1 request per second and 40 API requests per run.
// Every call to api.unsplash.com counts, including the download_location tracking pings
// that the API guidelines require for each photo we download. Review sheets show the photos
// straight from the Unsplash CDN (images.unsplash.com), which is not an API request.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { ROOT, OUT, PHOTOS_UNSPLASH, STATE, THEMES, readJson, writeJson, parseArgs } from './paths.mjs';
import { AVOID, PERSON, DISCREET_POSE, SUGGESTIVE, IN_WATER } from './filters.mjs';
import { listPhotos } from './photos.mjs';
import { makeContactSheet } from './sheet.mjs';

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
const PHOTOS_USED_FILE = path.join(STATE, 'photos-used.json');
const CANDIDATES_FILE = path.join(ROOT, 'photos/candidates.json');
const SHEETS_DIR = path.join(OUT, 'candidates');
const PREVIEW_FACTOR = 3; // candidates per missing photo, so the review can keep the best ones
const SHEET_SIZE = 30;

const args = parseArgs();
const PER_THEME = Number(args['per-theme'] ?? 4);
const MODE = args.preview ? 'preview' : args.keep ? 'keep' : args.reject ? 'reject' : 'fetch';
const ids = (value) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : []);
const SCORE = args.score === undefined ? undefined : Number(args.score);
if (SCORE !== undefined && !(Number.isInteger(SCORE) && SCORE >= 1 && SCORE <= 5)) {
  console.error('--score must be a whole number from 1 to 5.');
  process.exit(1);
}
const THEME = args.theme;
if (THEME !== undefined && !THEMES.includes(THEME)) {
  console.error(`--theme must be one of: ${THEMES.join(', ')}.`);
  process.exit(1);
}

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
  golf: ['golf course mountains morning', 'crans-montana golf', 'golf course alps'],
  dining: ['champagne chalet fireplace', 'fine dining table dark', 'gourmet plate dark'],
  jewels: ['diamond ring macro dark', 'diamond necklace'],
  fashion: [
    'hermes birkin bag', 'louis vuitton bag luxury', 'moncler jacket snow',
    'elegant woman fur coat snow', 'woman evening dress chalet', 'woman luxury ski outfit',
  ],
};
// Luxury upgrade of batch 2026-10-21. Queries never searched before are tried first.
// The last ones for cars, golf and ski are broader fallbacks: in portrait, "rolls royce snow",
// "bentley mountain", "aston martin alps" and "golf course alps luxury" return almost nothing,
// and "snow polo" returns VW Polos and Christmas decorations.
const LUXURY_QUERIES = {
  cars: [
    'rolls royce snow', 'bentley mountain', 'aston martin alps', 'range rover snow chalet', 'porsche night snow', 'lamborghini night',
    'rolls royce', 'bentley', 'aston martin', 'mercedes maybach',
  ],
  mountain: ['private jet snow', 'private jet tarmac', 'helicopter alps luxury', 'gstaad', 'st moritz', 'zermatt luxury', 'verbier'],
  chalets: ['luxury chalet interior', 'chalet fireplace champagne', 'alpine hotel suite', 'luxury hotel lobby alpine', 'chalet terrace hot tub snow'],
  dining: ['champagne terrace mountains', 'fine dining alpine hotel', 'caviar champagne'],
  fashion: ['fur coat snow elegant', 'luxury ski outfit', 'cashmere coat winter'],
  jewels: ['diamond ring luxury dark', 'luxury jewelry macro'],
  watches: ['rolex', 'patek philippe', 'audemars piguet', 'luxury watch wrist suit'],
  golf: [
    'golf course alps luxury', 'golf alps', 'golf course switzerland', 'golf swing mountains', 'golf resort mountains',
    'golfer silhouette sunset', 'golf course aerial', 'golf course sunrise',
  ],
  ski: ['snow polo', 'ski alps luxury sunrise', 'heliskiing', 'skier alps sunset', 'ski touring alps sunrise'],
};
const OWN_QUERIES = Object.fromEntries(Object.entries(BASE_QUERIES).map(([t, q]) => [t, [...LUXURY_QUERIES[t], ...q]]));
const QUERIES = {
  ...OWN_QUERIES,
  ambition: [...OWN_QUERIES.mountain, ...OWN_QUERIES.cars, ...OWN_QUERIES.watches],
  discipline: [...OWN_QUERIES.watches, ...OWN_QUERIES.mountain, ...OWN_QUERIES.cars],
};
// Every other original query asks for dark photos.
const DARK = new Set(Object.values(BASE_QUERIES).flat().filter((_, i) => i % 2 === 0));


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
const PHOTO_COST = MODE === 'preview' ? 0 : 1; // API requests per photo taken: the download_location ping

const seen = await readJson(SEEN_FILE, {});
for (const field of ['photos', 'queryCursor', 'queryPage', 'queryLeft', 'queryDone']) seen[field] ??= {};
// Photos found by --preview and waiting for review: { id: { theme, query, found_at, approved?, score?, photo } }.
const candidates = await readJson(CANDIDATES_FILE, {});
await mkdir(PHOTOS_UNSPLASH, { recursive: true });
const photosUsed = await readJson(PHOTOS_USED_FILE, {});
const unusedCounts = async () =>
  Object.fromEntries(await Promise.all(THEMES.map(async (t) => [t, (await listPhotos(t)).filter((p) => !photosUsed[p.key]).length])));
const unusedBefore = await unusedCounts();
const need = Object.fromEntries(THEMES.map((t) => [t, Math.max(0, PER_THEME - unusedBefore[t])]));
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
      if (!takenThisRun.has(photo.id) && !seen.photos[photo.id] && !candidates[photo.id]) return { photo, query };
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

const searchedBefore = (query) => seen.queryPage[query] !== undefined || seen.queryPage[`${query}|black`] !== undefined;
async function search(theme) {
  // A query added to the lists is searched before the rotation resumes.
  let query = QUERIES[theme].find((q) => !searchedBefore(q) && !pools.has(q));
  if (!query) {
    const cursor = seen.queryCursor[theme] ?? 0;
    query = QUERIES[theme][cursor % QUERIES[theme].length];
    seen.queryCursor[theme] = cursor + 1;
    if (pools.has(query)) return; // already searched this run
  }
  let usable = DARK.has(query) ? await searchPage(query, true) : null;
  // A black-only search can come back empty or be used up; try the same query in any colour.
  // When the black search made no request, the caller's budget check already covers this one.
  if (!usable?.length && (usable === null || canSpend(1 + PHOTO_COST))) usable = await searchPage(query, false);
  pools.set(query, usable ?? []);
}

async function download(theme, photo, query, score) {
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
    ...(score !== undefined ? { score } : {}),
    downloaded_at: new Date().toISOString(),
  };
  await writeFile(path.join(PHOTOS_UNSPLASH, `${base}.json`), JSON.stringify(meta, null, 2) + '\n');
  seen.photos[photo.id] = { theme, photographer: meta.photographer, username: meta.username, downloaded_at: meta.downloaded_at };
  takenThisRun.add(photo.id);
  got[theme]++;
  need[theme]--;
}

let stopReason = null;

async function fetchPhotos() {
  console.log(`Fetching until each theme has ${PER_THEME} unused photos (budget ${MAX_REQUESTS} API requests).`);
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
}

// Searches only: every usable result of a page becomes a candidate, until each theme has
// PREVIEW_FACTOR candidates per missing photo. Nothing is downloaded.
async function preview() {
  const pending = (t) => Object.values(candidates).filter((c) => c.theme === t && !c.approved).length;
  const want = Object.fromEntries(THEMES.map((t) => [t, need[t] * PREVIEW_FACTOR - pending(t)]));
  console.log(`Searching candidates for ${PER_THEME} unused photos per theme (budget ${MAX_REQUESTS} API requests).`);
  while (!stopReason && THEMES.some((t) => want[t] > 0)) {
    for (const theme of THEMES) {
      if (want[theme] <= 0) continue;
      if (searchedThisRun[theme] >= QUERIES[theme].length) { want[theme] = 0; continue; }
      if (!canSpend(1)) { stopReason = 'request budget reached'; break; }
      searchedThisRun[theme]++;
      await search(theme);
      for (let pick; (pick = takeFromPools(theme)); want[theme]--) {
        candidates[pick.photo.id] = { theme, query: pick.query, found_at: new Date().toISOString(), photo: pick.photo };
        takenThisRun.add(pick.photo.id);
        got[theme]++;
      }
    }
  }
}

// Approves the given candidates, then downloads every approved candidate the budget allows.
async function keep() {
  const list = ids(args.keep);
  const missing = list.filter((id) => !candidates[id]);
  if (missing.length) throw new Error(`Not in photos/candidates.json: ${missing.join(', ')}`);
  for (const id of list)
    Object.assign(candidates[id], { approved: true }, SCORE !== undefined ? { score: SCORE } : {}, THEME ? { theme: THEME } : {});
  for (const [id, c] of Object.entries(candidates)) {
    if (!c.approved) continue;
    if (!canSpend(1)) { stopReason = 'request budget reached'; break; }
    await download(c.theme, c.photo, c.query, c.score);
    delete candidates[id];
  }
}

function reject() {
  const list = ids(args.reject);
  const missing = list.filter((id) => !candidates[id]);
  if (missing.length) throw new Error(`Not in photos/candidates.json: ${missing.join(', ')}`);
  for (const id of list) {
    const { theme, photo } = candidates[id];
    // Recorded as seen, so a later search never offers it again.
    seen.photos[id] = { theme, photographer: photo.user.name, username: photo.user.username, rejected_at: new Date().toISOString() };
    delete candidates[id];
  }
}

// One sheet per theme (split by SHEET_SIZE), captioned "number · id", listed the same way on the console.
async function writeReviewSheets() {
  await rm(SHEETS_DIR, { recursive: true, force: true });
  await mkdir(SHEETS_DIR, { recursive: true });
  for (const theme of THEMES) {
    const list = Object.entries(candidates).filter(([, c]) => c.theme === theme && !c.approved);
    for (let i = 0; i < list.length; i += SHEET_SIZE) {
      const part = list.slice(i, i + SHEET_SIZE).map(([id, c], j) => {
        console.log(`  ${theme} ${String(i + j + 1).padStart(2)}  ${id}  "${c.query}"`);
        return { src: `${c.photo.urls.raw}&w=440&h=550&fit=crop&crop=entropy&q=70&fm=jpg`, caption: `${i + j + 1} · ${id}` };
      });
      const name = list.length > SHEET_SIZE ? `${theme}-${i / SHEET_SIZE + 1}.png` : `${theme}.png`;
      await makeContactSheet(part, path.join(SHEETS_DIR, name), { columns: 6, cell: 220, title: `${theme} candidates`, unit: 'photos' });
    }
  }
}

try {
  if (MODE === 'preview') await preview();
  else if (MODE === 'keep') await keep();
  else if (MODE === 'reject') reject();
  else await fetchPhotos();
} catch (err) {
  stopReason =
    err.status === 401 ? 'Unsplash rejected UNSPLASH_ACCESS_KEY (401). Check the Access Key in .env'
    : err.status === 403 || err.status === 429 ? 'Unsplash rate limit reached'
    : err.message;
} finally {
  // Pages that still hold unused photos are asked for again next run instead of skipping to the next page.
  for (const [query, pool] of pools) if (pool.some((p) => !seen.photos[p.id] && !candidates[p.id])) seen.queryLeft[poolKeys.get(query)] = true;
  await writeJson(SEEN_FILE, seen);
  await writeJson(CANDIDATES_FILE, candidates);
}

const total = Object.values(got).reduce((a, b) => a + b, 0);
const unused = await unusedCounts();
const pendingFor = (t) => Object.values(candidates).filter((c) => c.theme === t);
if (MODE !== 'fetch') await writeReviewSheets();
console.log(
  MODE === 'preview' ? `\nFound ${total} candidate(s) using ${requests} API request(s). Review sheets: out/candidates/`
  : MODE === 'reject' ? '\nRejected candidates are recorded in state/unsplash-seen.json.'
  : `\nDownloaded ${total} photo(s) using ${requests} API request(s).`
);
console.log(
  THEMES.map((t) => {
    const waiting = pendingFor(t);
    const approved = waiting.filter((c) => c.approved).length;
    return `  ${t}: ${unused[t]} unused` +
      (approved ? `, ${approved} approved still to download` : '') +
      (waiting.length - approved ? `, ${waiting.length - approved} candidate(s) to review` : '');
  }).join('\n')
);
const short = THEMES.filter((t) => unused[t] < PER_THEME);
if (stopReason) console.log(`Stopped: ${stopReason}.`);
if (short.length && MODE !== 'reject')
  console.log(`Still short of ${PER_THEME} unused: ${short.join(', ')}. Run again in an hour if the budget ran out (demo limit is 50 requests/hour).`);
if (stopReason && !['request budget reached', 'Unsplash rate limit reached'].includes(stopReason)) process.exit(1);
