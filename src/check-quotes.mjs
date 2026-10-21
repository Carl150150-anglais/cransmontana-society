// Validates quotes/quotes.json (and quotes/captions.json) against the editorial rules.
// Exits with code 1 and a list of problems if anything fails. Run with: npm run check
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { QUOTES, THEMES, readJson } from './paths.mjs';

// jewels and fashion took 10 quotes each from ambition and discipline.
export const THEME_COUNTS = {
  ambition: 40, mountain: 30, discipline: 15, cars: 25, watches: 20,
  chalets: 15, ski: 15, golf: 10, dining: 10, jewels: 10, fashion: 10,
};
const SEASONS = new Set(['all', 'winter', 'summer']);
const MAX_LENGTH = 64;

// Matched as whole words, with common inflections (kings, richer, hustling...).
const FORBIDDEN_WORDS = [
  'grind', 'hustle', 'boss', 'alpha', 'sigma', 'money', 'rich', 'riches', 'wealth', 'wealthy',
  'millionaire', 'billionaire', 'cash', 'slay', 'king',
];
// Topics the page never touches: parties, nightlife, alcohol, fire, loss, mourning.
const FORBIDDEN_TOPICS = [
  'party', 'parties', 'partying', 'nightlife', 'nightclub', 'club', 'clubbing', 'dance', 'dancing',
  'celebrate', 'celebration', 'midnight', 'new year', 'countdown', 'disco', 'rave', 'bar', 'bars', 'pub',
  'alcohol', 'champagne', 'prosecco', 'wine', 'wines', 'cellar', 'sommelier', 'vintage', 'cocktail',
  'drink', 'drinks', 'drinking', 'toast', 'cheers', 'bottle', 'bottles', 'glass', 'glasses', 'apero',
  'aperitif', 'spirits', 'whisky', 'whiskey', 'vodka', 'gin', 'rum', 'beer', 'liquor', 'bubbly',
  'fire', 'fires', 'fireside', 'fireplace', 'firework', 'fireworks', 'flame', 'flames', 'blaze',
  'burn', 'burns', 'burning', 'burnt', 'ember', 'embers', 'smoke', 'smoking', 'ash', 'ashes',
  'spark', 'sparks', 'sparkler', 'sparklers', 'candle', 'candles', 'candlelight', 'hearth', 'ignite',
  'kindle', 'inferno', 'loss', 'lose', 'losing', 'lost', 'mourn', 'mourning', 'grief', 'grieve',
  'funeral', 'death', 'dead', 'die', 'dying', 'tragedy', 'tragic', 'memorial', 'tears', 'victim',
  'victims', 'farewell', 'gone',
];
const BRANDS = [
  'porsche', 'ferrari', 'lamborghini', 'bugatti', 'mclaren', 'bentley', 'rolls', 'royce', 'maserati',
  'aston martin', 'mercedes', 'bmw', 'audi', 'jaguar', 'range rover', 'land rover', 'tesla', 'alfa romeo',
  'lotus', 'pagani', 'koenigsegg', 'maybach', 'rolex', 'patek', 'philippe', 'audemars', 'piguet', 'omega',
  'cartier', 'breitling', 'hublot', 'tag heuer', 'tudor', 'iwc', 'jaeger', 'vacheron', 'constantin',
  'richard mille', 'chopard', 'longines', 'tissot', 'blancpain', 'breguet', 'zenith', 'panerai', 'swatch',
  'montblanc', 'mont blanc', 'hermes', 'hermès', 'chanel', 'dior', 'gucci', 'prada', 'vuitton', 'moncler',
  'bogner', 'loro piana', 'brunello', 'cucinelli', 'ritz', 'aman', 'four seasons', 'six senses', 'badrutt',
  'michelin', 'titleist', 'callaway', 'taylormade', 'salomon', 'rossignol', 'nespresso', 'lindt', 'nike',
];
// Normalised fragments of well-known quotes and proverbs; any match is rejected.
const KNOWN_QUOTES = [
  'mountains are calling', 'not the mountain we conquer', 'best view comes after the hardest climb',
  'view is worth the climb', 'higher you climb', 'time is money', 'time waits for no', 'slow and steady',
  'journey is the destination', 'not a destination', 'less is more', 'ultimate sophistication',
  'quality is not an act', 'we are what we repeatedly do', 'god is in the details',
  'the details are not the details', 'elegance is refusal', 'elegance is not standing out',
  'stay hungry', 'dream big', 'shoot for the moon', 'sky is the limit', 'fortune favors the bold',
  'fortune favours the bold', 'nothing worth having', 'patience is a virtue', 'practice makes perfect',
  'not built in a day', 'what goes up', 'keep calm and', 'good things come to those who wait',
  'thousand miles begins', 'early bird', 'discipline is the bridge', 'discipline equals freedom',
  'success is a journey', 'too short to drive boring', 'keep moving forward', 'do what you love',
  'lost time is never found', 'good walk spoiled', 'most important shot in golf', 'silence is golden',
  'the quieter you become', 'luxury must be comfortable', 'best things in life are free',
  'you only live once', 'carpe diem', 'style is a way to say who you are', 'make it happen',
  'getting to the top is optional', 'other side of fear', 'if you want to go fast',
  'predict the future is to create', 'no elevator to success', 'success is not final',
  'quality over quantity', 'good things take time', 'best things take time', 'in the middle of difficulty',
  'work hard in silence', 'let success make the noise', 'when no one is watching', 'its own reward',
  'time well spent', 'ultimate luxury', 'merely look after it', 'climb mountains not so',
  'go confidently in the direction', 'comfort zone', 'the road less', 'one day at a time',
  'great things never came', 'it always seems impossible', 'the harder i work', 'luckier i get',
];
// First words that mark a quiet imperative ("Rise early.", "Choose the summit.").
const IMPERATIVE_VERBS = new Set([
  'aim', 'arrive', 'aspire', 'be', 'begin', 'build', 'carry', 'carve', 'choose', 'climb', 'do', 'drive',
  'earn', 'find', 'follow', 'give', 'go', 'hold', 'keep', 'leave', 'let', 'listen', 'look', 'make',
  'move', 'pace', 'play', 'prepare', 'raise', 'reach', 'read', 'repeat', 'rest', 'rise', 'savour', 'set',
  'show', 'ski', 'stay', 'take', 'trust', 'wait', 'walk', 'wear', 'wind',
]);
// Capitalised words allowed after the first word (sentence case).
const PROPER_NOUNS = new Set(['Alps', 'Alpine', 'Swiss', 'Valais', 'Crans-Montana', 'Switzerland', 'Rhône', 'I']);
const STOPWORDS = new Set(
  ('a an the and or but of in on at to for from by with as is are was were be been it its this that ' +
   'these those than then so not no nor all every some there their they them you your we our one each ' +
   'into onto over under above below before after up down long more most less what who when where which')
    .split(' ')
);

const QUOTE_CHARS = /["'“”‘’«»„‚`´]/;
const EMOJI = /\p{Extended_Pictographic}/u;

const normalize = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
const wordRe = (w, inflect) => new RegExp(`\\b${w.replace(/ /g, '\\s+')}${inflect ? '(s|es|er|est|ing|ed|y)?' : ''}\\b`, 'i');
const contentWords = (s) =>
  new Set(normalize(s).split(' ').filter((w) => w && !STOPWORDS.has(w)).map((w) => w.replace(/(ies|es|s)$/, '')));
function trigrams(s) {
  const t = `  ${normalize(s)} `;
  const set = new Set();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}
const jaccard = (a, b) => [...a].filter((x) => b.has(x)).length / new Set([...a, ...b]).size;
const dice = (a, b) => (2 * [...a].filter((x) => b.has(x)).length) / (a.size + b.size);

// Rules shared by quotes and captions: returns a list of problems for one text.
export function contentProblems(text) {
  const problems = [];
  if (text.includes('!')) problems.push('exclamation mark');
  if (text.includes('#')) problems.push('hashtag');
  if (QUOTE_CHARS.test(text)) problems.push('quotation mark or apostrophe');
  if (EMOJI.test(text)) problems.push('emoji');
  for (const w of FORBIDDEN_WORDS) if (wordRe(w, true).test(text)) problems.push(`forbidden word "${w}"`);
  for (const w of FORBIDDEN_TOPICS) if (wordRe(w, false).test(text)) problems.push(`forbidden topic "${w}"`);
  for (const b of BRANDS) if (wordRe(b, false).test(text)) problems.push(`brand name "${b}"`);
  const norm = normalize(text);
  for (const k of KNOWN_QUOTES) if (norm.includes(normalize(k))) problems.push(`resembles a known quote ("${k}")`);
  return problems;
}

export async function checkQuotes() {
  const errors = [];
  const quotes = await readJson(path.join(QUOTES, 'quotes.json'));
  if (!Array.isArray(quotes)) return { errors: ['quotes.json must be an array'], quotes: [], counts: {}, imperatives: 0 };

  if (quotes.length !== 200) errors.push(`expected 200 quotes, found ${quotes.length}`);
  if (quotes[0]?.id !== 'q001' || quotes[0]?.text !== 'Ambition lives at altitude.')
    errors.push('q001 must be "Ambition lives at altitude."');

  const counts = Object.fromEntries(THEMES.map((t) => [t, 0]));
  const ids = new Set();
  let imperatives = 0;
  quotes.forEach((q, i) => {
    const where = `${q.id ?? `#${i + 1}`}`;
    const err = (msg) => errors.push(`${where}: ${msg} -> ${q.text}`);
    const expectedId = `q${String(i + 1).padStart(3, '0')}`;
    if (q.id !== expectedId) err(`id should be ${expectedId}`);
    if (ids.has(q.id)) err('duplicate id');
    ids.add(q.id);
    if (Object.keys(q).sort().join() !== 'id,season,text,theme') err('fields must be exactly id, text, theme, season');
    if (!THEMES.includes(q.theme)) err(`unknown theme "${q.theme}"`);
    else counts[q.theme]++;
    if (!SEASONS.has(q.season)) err(`unknown season "${q.season}"`);
    const text = q.text ?? '';
    if (text !== text.trim() || /\s{2,}/.test(text)) err('stray whitespace');
    if (text.length > MAX_LENGTH) err(`${text.length} characters (max ${MAX_LENGTH})`);
    if (!/^[A-Z]/.test(text)) err('must start with a capital letter');
    if (!/[^.]\.$/.test(text)) err('must end with a single period');
    if (/[?;]/.test(text)) err('no question marks or semicolons');
    // Sentence case: after the first word, capitals only for proper nouns or after a full stop.
    const words = text.split(/\s+/);
    words.slice(1).forEach((w, j) => {
      const bare = w.replace(/[.,:]/g, '');
      if (/[A-Z]/.test(bare) && !PROPER_NOUNS.has(bare) && !words[j].endsWith('.')) err(`not sentence case ("${bare}")`);
    });
    for (const p of contentProblems(text)) err(p);
    if (IMPERATIVE_VERBS.has(normalize(words[0]))) imperatives++;
  });

  for (const [theme, expected] of Object.entries(THEME_COUNTS))
    if (counts[theme] !== expected) errors.push(`theme ${theme}: expected ${expected}, found ${counts[theme]}`);
  if (imperatives > quotes.length / 3)
    errors.push(`too many imperatives: ${imperatives} of ${quotes.length} (max a third)`);

  // Duplicates and near-duplicates.
  const prepared = quotes.map((q) => ({ q, norm: normalize(q.text), words: contentWords(q.text), tri: trigrams(q.text) }));
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i];
      const b = prepared[j];
      const why =
        a.norm === b.norm ? 'duplicate'
        : jaccard(a.words, b.words) >= 0.5 ? `near-duplicate (shared words ${jaccard(a.words, b.words).toFixed(2)})`
        : dice(a.tri, b.tri) >= 0.7 ? `near-duplicate (similar wording ${dice(a.tri, b.tri).toFixed(2)})`
        : null;
      if (why) errors.push(`${a.q.id} / ${b.q.id}: ${why} -> "${a.q.text}" / "${b.q.text}"`);
    }
  }

  // Captions and hashtags.
  const captions = await readJson(path.join(QUOTES, 'captions.json'));
  const lines = THEMES.flatMap((t) => captions.lines?.[t] ?? []);
  if (lines.length !== 40) errors.push(`captions.json: expected 40 caption lines, found ${lines.length}`);
  const tagRe = /^#[A-Za-z][A-Za-z0-9]*$/;
  for (const t of captions.hashtags?.base ?? []) if (!tagRe.test(t)) errors.push(`captions.json: bad base hashtag ${t}`);
  for (const theme of THEMES) {
    if (!captions.lines?.[theme]?.length) errors.push(`captions.json: no caption line for ${theme}`);
    const tags = captions.hashtags?.themes?.[theme] ?? [];
    if (tags.length < 3 || tags.length > 5) errors.push(`captions.json: ${theme} needs 3 to 5 hashtags, has ${tags.length}`);
    for (const t of tags) if (!tagRe.test(t)) errors.push(`captions.json: bad hashtag ${t}`);
    if ((captions.hashtags?.base?.length ?? 0) + tags.length > 10) errors.push(`captions.json: ${theme} would exceed 10 hashtags`);
  }
  for (const line of lines) {
    const sentences = line.split(/(?<=\.)\s+/).length;
    if (sentences > 2) errors.push(`caption has ${sentences} sentences (max 2): ${line}`);
    if (!/\.$/.test(line)) errors.push(`caption must end with a period: ${line}`);
    for (const p of contentProblems(line)) if (!p.startsWith('resembles')) errors.push(`caption: ${p} -> ${line}`);
  }

  return { errors, quotes, counts, imperatives };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { errors, quotes, counts, imperatives } = await checkQuotes();
  if (errors.length) {
    console.error(`check-quotes: ${errors.length} problem(s)\n` + errors.map((e) => `  - ${e}`).join('\n'));
    process.exit(1);
  }
  const seasons = quotes.reduce((acc, q) => ({ ...acc, [q.season]: (acc[q.season] ?? 0) + 1 }), {});
  console.log(`check-quotes: OK, ${quotes.length} quotes`);
  console.log(`  themes: ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  console.log(`  seasons: ${Object.entries(seasons).map(([s, n]) => `${s} ${n}`).join(', ')}`);
  console.log(`  imperatives: ${imperatives} (max ${Math.floor(quotes.length / 3)})`);
}
