// Renders one post in the overlay style (quote + photo) to a 1080x1350 PNG with src/template.html.
// The plain style (photo alone) is src/finish.mjs.
// CLI: npm run samples   -> out/samples/ (one mountain, one cars, one watches) + contact sheet
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { SRC, OUT, QUOTES, readJson, parseArgs } from './paths.mjs';
import { listPhotos } from './photos.mjs';
import { makeContactSheet } from './sheet.mjs';

export const WIDTH = 1080;
export const HEIGHT = 1350;
const TEMPLATE = path.join(SRC, 'template.html');
const FONT_SIZES = [54, 48, 44]; // never below 44
const REQUIRED_FONTS = [
  { family: 'Jost', weight: '300', css: '300 54px Jost' },
  { family: 'Jost', weight: '400', css: '400 24px Jost' },
  { family: 'Jost', weight: '500', css: '500 11px Jost' },
  { family: 'Bodoni Moda', weight: '400', css: '400 40px "Bodoni Moda"' },
];

export function pngSize(buf) {
  if (buf.toString('ascii', 1, 4) !== 'PNG') throw new Error('not a PNG file');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Width and height from the first SOF marker of a JPEG.
export function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG file');
  for (let i = 2; i + 9 < buf.length; ) {
    if (buf[i] !== 0xff) throw new Error('corrupt JPEG: marker expected');
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error('corrupt JPEG: no frame header');
}

// Waits for the fonts and throws rather than let the page render with a fallback font.
export async function assertFontsLoaded(page, sample) {
  const missing = await page.evaluate(
    async ({ fonts, sample }) => {
      await Promise.all(fonts.map((f) => document.fonts.load(f.css, sample)));
      await document.fonts.ready;
      // document.fonts.check() is also true for a family that was never declared,
      // so require an actually loaded FontFace for every family and weight too.
      return fonts
        .filter((f) => {
          const loaded = [...document.fonts].some(
            (face) => face.family.replace(/["']/g, '') === f.family && String(face.weight) === f.weight && face.status === 'loaded'
          );
          return !loaded || !document.fonts.check(f.css, sample);
        })
        .map((f) => `${f.family} ${f.weight}`);
    },
    { fonts: REQUIRED_FONTS, sample }
  );
  if (missing.length)
    throw new Error(
      `Fonts not loaded: ${missing.join(', ')}. Run "npm run fonts" and check assets/fonts/fonts.css. ` +
        'Refusing to render with a fallback font.'
    );
}

// Renders HTML cards (e.g. src/reel-card.html) with the same font guard as the posts.
// Each card: { out, width, height, variant, fill: { elementId: text }, transparent }.
export async function renderCards(template, cards) {
  const browser = await launchBrowser();
  try {
    for (const { out, width, height, variant, fill = {}, transparent = false } of cards) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      await page.goto(pathToFileURL(template).href, { waitUntil: 'load' });
      await page.evaluate(
        ({ variant, fill }) => {
          document.body.dataset.variant = variant;
          for (const [id, text] of Object.entries(fill)) document.getElementById(id).textContent = text;
        },
        { variant, fill }
      );
      await assertFontsLoaded(page, `${Object.values(fill).join(' ')} cransmontana.society CM SOCIETY`);
      const png = await page.screenshot({ type: 'png', omitBackground: transparent });
      const size = pngSize(png);
      if (size.width !== width || size.height !== height)
        throw new Error(`card ${variant} rendered ${size.width}x${size.height}, expected ${width}x${height}`);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, png);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

// Number of lines each text takes in element #id of a card variant, with the real fonts.
export async function measureLines(template, { width, height, variant, id }, texts) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(template).href, { waitUntil: 'load' });
    await page.evaluate((v) => { document.body.dataset.variant = v; }, variant);
    await assertFontsLoaded(page, texts.join(' '));
    return await page.evaluate(
      ({ id, texts }) => {
        const el = document.getElementById(id);
        return texts.map((t) => {
          el.textContent = t;
          return Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
        });
      },
      { id, texts }
    );
  } finally {
    await browser.close();
  }
}

export async function createRenderer({ template = TEMPLATE } = {}) {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

  // Returns { fontSize, lines } for the rendered quote.
  async function render(quote, photoPath, outPath) {
    await page.goto(pathToFileURL(template).href, { waitUntil: 'load' });
    await page.evaluate(
      async ({ text, photoUrl }) => {
        const img = document.getElementById('photo');
        img.src = photoUrl;
        await img.decode();
        document.getElementById('quote').textContent = text;
      },
      { text: quote.text, photoUrl: pathToFileURL(photoPath).href }
    );
    await assertFontsLoaded(page, `${quote.text} cransmontana.society CM SOCIETY`);
    const result = await page.evaluate((sizes) => {
      const el = document.getElementById('quote');
      for (const size of sizes) {
        el.style.fontSize = `${size}px`;
        const lines = Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
        if (lines <= 2) return { fontSize: size, lines };
      }
      return { tooLong: true };
    }, FONT_SIZES);
    if (result.tooLong)
      throw new Error(`${quote.id}: needs more than 2 lines even at ${FONT_SIZES.at(-1)}px: ${quote.text}`);

    const png = await page.screenshot({ type: 'png' });
    const { width, height } = pngSize(png);
    if (width !== WIDTH || height !== HEIGHT) throw new Error(`rendered ${width}x${height}, expected ${WIDTH}x${HEIGHT}`);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, png);
    return result;
  }

  return { render, close: () => browser.close() };
}

// One-off convenience wrapper.
export async function renderPost(quote, photoPath, outPath) {
  const renderer = await createRenderer();
  try {
    return await renderer.render(quote, photoPath, outPath);
  } finally {
    await renderer.close();
  }
}

const SAMPLES = [
  { theme: 'mountain', quoteId: 'q051' },
  { theme: 'cars', quoteId: 'q125' },
  { theme: 'watches', quoteId: 'q132' },
];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs();
  if (!args.samples) {
    console.error('Usage: node src/render.mjs --samples');
    process.exit(1);
  }
  const quotes = await readJson(path.join(QUOTES, 'quotes.json'));
  const dir = path.join(OUT, 'samples');
  const renderer = await createRenderer();
  const files = [];
  try {
    for (const { theme, quoteId } of SAMPLES) {
      const quote = quotes.find((q) => q.id === quoteId);
      const [photo] = await listPhotos(theme);
      if (!photo) throw new Error(`No ${theme} photo found in photos/own or photos/unsplash.`);
      const out = path.join(dir, `sample_${theme}_${quote.id}.png`);
      const { fontSize, lines } = await renderer.render(quote, photo.file, out);
      console.log(`  ${path.relative(process.cwd(), out)}  (${photo.key}, ${fontSize}px, ${lines} line${lines > 1 ? 's' : ''})`);
      files.push(out);
    }
  } finally {
    await renderer.close();
  }
  const sheet = await makeContactSheet(files, path.join(dir, 'contact-sheet.png'), { title: 'samples' });
  console.log(`  ${path.relative(process.cwd(), sheet)}`);
}
