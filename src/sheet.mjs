// Contact sheet: a 3-column grid of rendered posts with their file names, rendered from HTML.
// Also used for the Unsplash candidate review sheets (remote images, smaller cells).
// CLI: npm run sheet -- --batch <name>     (or --dir <folder>)
import { readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './browser.mjs';
import { OUT, FONTS_CSS, parseArgs } from './paths.mjs';

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// files: local paths, or { src, caption } items.
export async function makeContactSheet(files, outPath, { columns = 3, title = '', cell = 340, unit = 'posts' } = {}) {
  const width = 40 * 2 + columns * cell + (columns - 1) * 24;
  const cells = files
    .map((f) => (typeof f === 'string' ? { src: pathToFileURL(f).href, caption: path.basename(f) } : f))
    .map(({ src, caption }) => `<figure><img src="${escapeHtml(src)}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`)
    .join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${pathToFileURL(FONTS_CSS).href}">
<style>
  * { margin: 0; box-sizing: border-box; }
  body { background: #0d0d0d; color: #F2EDE3; font-family: 'Jost', sans-serif; padding: 40px; width: ${width}px; }
  h1 { font-weight: 400; font-size: 18px; letter-spacing: 3px; opacity: .7; margin-bottom: 28px; }
  .grid { display: grid; grid-template-columns: repeat(${columns}, ${cell}px); gap: 28px 24px; }
  img { width: ${cell}px; height: ${cell * 1.25}px; display: block; object-fit: cover; }
  figcaption { font-size: 14px; opacity: .7; padding-top: 8px; word-break: break-all; }
</style></head>
<body><h1>${escapeHtml(title)} · ${files.length} ${unit}</h1><div class="grid">${cells}</div></body></html>`;

  // The page must be a file:// page to load the local images; keep it next to the output.
  const htmlPath = path.join(path.dirname(outPath), '.contact-sheet.html');
  await writeFile(htmlPath, html);
  const browser = await launchBrowser();
  try {
    // A short viewport of the exact sheet width: the full-page screenshot then matches the content.
    const page = await browser.newPage({ viewport: { width, height: 200 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: outPath, fullPage: true });
  } finally {
    await browser.close();
    await rm(htmlPath, { force: true });
  }
  return outPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs();
  const dir = args.dir ? path.resolve(args.dir) : args.batch ? path.join(OUT, args.batch) : null;
  if (!dir) {
    console.error('Usage: npm run sheet -- --batch <name>   (or --dir <folder>)');
    process.exit(1);
  }
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.png') && f !== 'contact-sheet.png')
    .sort()
    .map((f) => path.join(dir, f));
  if (!files.length) {
    console.error(`No PNG posts in ${dir}`);
    process.exit(1);
  }
  const out = await makeContactSheet(files, path.join(dir, 'contact-sheet.png'), { title: path.basename(dir) });
  console.log(`Wrote ${path.relative(process.cwd(), out)} (${files.length} posts)`);
}
