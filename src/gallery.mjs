// Regenerates docs/index.html: a dark review gallery of every batch in docs/posts/, newest first.
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DOCS, readJson } from './paths.mjs';

const UNSPLASH_LINK = 'https://unsplash.com/?utm_source=cransmontana_society&utm_medium=referral';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function card(batch, post) {
  const credit = post.photo_source === 'unsplash'
    ? `<p class="credit">Photo by <a href="${esc(post.credit_url)}">${esc(post.photographer)}</a> on <a href="${UNSPLASH_LINK}">Unsplash</a></p>`
    : '<p class="credit">Own photo</p>';
  return `<figure>
  <a href="posts/${esc(batch)}/${esc(post.file)}"><img src="posts/${esc(batch)}/${esc(post.file)}" width="1080" height="1350" loading="lazy" alt="${esc(post.quote)}"></a>
  <figcaption>
    <p class="file">${esc(post.file)} · ${esc(post.theme)}</p>
    <pre>${esc(post.caption)}</pre>
    ${credit}
  </figcaption>
</figure>`;
}

export async function writeGallery() {
  const postsDir = path.join(DOCS, 'posts');
  const batches = [];
  const dirs = (await readdir(postsDir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory());
  for (const name of dirs.map((d) => d.name).sort().reverse()) {
    const posts = await readJson(path.join(postsDir, name, 'posts.json'), null);
    if (posts) batches.push({ name, posts });
  }
  const sections = batches
    .map(({ name, posts }) => `<section>
<h2>${esc(name)} <span>${posts.length} posts · <a href="posts/${esc(name)}/posts.json">posts.json</a></span></h2>
<div class="grid">
${posts.map((p) => card(name, p)).join('\n')}
</div>
</section>`)
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>cransmontana.society · batches</title>
<style>
  :root { color-scheme: dark; --bg: #0d0d0d; --card: #161616; --ivory: #F2EDE3; --muted: #9a958c; --gold: #C9A962; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ivory); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
  header { padding: 40px 24px 8px; max-width: 1400px; margin: 0 auto; }
  h1 { font-weight: 300; letter-spacing: 4px; font-size: 22px; margin: 0; }
  header p { color: var(--muted); margin: 6px 0 0; }
  section { max-width: 1400px; margin: 0 auto; padding: 24px; }
  h2 { font-weight: 400; font-size: 18px; letter-spacing: 2px; border-bottom: 1px solid #2a2a2a; padding-bottom: 10px; }
  h2 span { color: var(--muted); font-size: 14px; letter-spacing: 0; margin-left: 10px; }
  a { color: var(--gold); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 24px; }
  figure { margin: 0; background: var(--card); border-radius: 4px; overflow: hidden; }
  img { width: 100%; height: auto; display: block; }
  figcaption { padding: 12px 14px 16px; }
  .file { color: var(--muted); font-size: 13px; margin: 0 0 8px; }
  pre { white-space: pre-wrap; font: inherit; margin: 0; }
  .credit { color: var(--muted); font-size: 13px; margin: 10px 0 0; }
</style>
</head>
<body>
<header>
  <h1>cransmontana.society</h1>
  <p>Review gallery. Nothing here is posted automatically.</p>
</header>
${sections || '<section><p>No batch yet.</p></section>'}
</body>
</html>
`;
  await writeFile(path.join(DOCS, 'index.html'), html);
  return batches.length;
}
