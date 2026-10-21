// Renders one post (quote + photo) to a 1080x1350 PNG with src/template.html.
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

export async function createRenderer({ template = TEMPLATE } = {}) {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

  // Returns { fontSize, lines } for the rendered quote.
  async function render(quote, photoPath, outPath) {
    await page.goto(pathToFileURL(template).href, { waitUntil: 'load' });
    const result = await page.evaluate(
      async ({ text, photoUrl, sizes, fonts }) => {
        const img = document.getElementById('photo');
        img.src = photoUrl;
        await img.decode();
        const el = document.getElementById('quote');
        el.textContent = text;

        const sample = `${text} cransmontana.society CM SOCIETY`;
        await Promise.all(fonts.map((f) => document.fonts.load(f.css, sample)));
        await document.fonts.ready;
        // document.fonts.check() is also true for a family that was never declared,
        // so require an actually loaded FontFace for every family and weight too.
        const missing = fonts
          .filter((f) => {
            const loaded = [...document.fonts].some(
              (face) => face.family.replace(/["']/g, '') === f.family && String(face.weight) === f.weight && face.status === 'loaded'
            );
            return !loaded || !document.fonts.check(f.css, sample);
          })
          .map((f) => `${f.family} ${f.weight}`);
        if (missing.length) return { missing };

        for (const size of sizes) {
          el.style.fontSize = `${size}px`;
          const lines = Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
          if (lines <= 2) return { fontSize: size, lines };
        }
        return { tooLong: true };
      },
      { text: quote.text, photoUrl: pathToFileURL(photoPath).href, sizes: FONT_SIZES, fonts: REQUIRED_FONTS }
    );
    if (result.missing)
      throw new Error(
        `Fonts not loaded: ${result.missing.join(', ')}. Run "npm run fonts" and check assets/fonts/fonts.css. ` +
          'Refusing to render with a fallback font.'
      );
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
