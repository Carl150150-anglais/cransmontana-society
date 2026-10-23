// Builds a batch of ready-to-post images, captions and posts.json, then publishes copies under docs/.
// Default style: the photo alone with the finishing pass (JPEG), the quote goes into the caption.
// --overlay: the old style, quote + page name + monogram on the photo (PNG).
// Usage:
//   npm run build                                  30 posts, batch named after today (YYYY-MM-DD)
//   npm run build -- --count 30 --batch 2026-10-21
//   npm run build -- --overlay                     old style, quote on the image
//   npm run build -- --batch 2026-10-21 --redo 03,07   new photo of the same theme for those numbers only
//                                                      (each post keeps its own style)
//   npm run build -- --batch 2026-10-21 --restyle 18,19   same photo in the plain style, as NN_qXXX-v2.jpg
//   npm run build -- --batch 2026-10-21 --scenes photos/scenes/mapping.json --skip 03,05
//                                                      finished images (AI scenes) published as they are,
//                                                      as NN_qXXX-v2.jpg
//   npm run build -- --batch 2026-10-21 --relink       rewrite public_url with the current GitHub Pages base
//   npm run build -- --dry-run                         print the plan only (nothing rendered or recorded)
//                                                      (also with --redo: prints the replacement photos)
import { existsSync } from 'node:fs';
import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, QUOTES, STATE, OUT, DOCS, THEMES, readJson, writeJson, parseArgs } from './paths.mjs';
import { listPhotos } from './photos.mjs';
import { createRenderer, jpegSize, WIDTH, HEIGHT } from './render.mjs';
import { finishPhoto } from './finish.mjs';
import { makeContactSheet } from './sheet.mjs';
import { writeGallery } from './gallery.mjs';
import { seasonFor, inSeason } from './season.mjs';

const REPO = 'cransmontana-society';
const USED_FILE = path.join(STATE, 'used.json');
const PHOTOS_USED_FILE = path.join(STATE, 'photos-used.json');
const FALLBACK_THEME = 'mountain';
const MAX_HASHTAGS = 10;
const AI_LABEL = 'Image created with AI';

const args = parseArgs();
const today = new Date().toLocaleDateString('sv-SE'); // local date as YYYY-MM-DD
const batch = typeof args.batch === 'string' ? args.batch : today;
if (!/^[\w.-]+$/.test(batch)) throw new Error(`Invalid batch name: ${batch}`);
const outDir = path.join(OUT, batch);
const docsDir = path.join(DOCS, 'posts', batch);
const overlay = Boolean(args.overlay);

// --- public URLs ------------------------------------------------------------

function run(cmd, cmdArgs) {
  try {
    return execFileSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}
function githubUser() {
  const remote = run('git', ['remote', 'get-url', 'origin']).match(/github\.com[:/]([^/]+)\//);
  return remote?.[1] || run('gh', ['api', 'user', '--jq', '.login']) || null;
}
const PLACEHOLDER_BASE = `https://<github-user>.github.io/${REPO}`;
const user = githubUser();
const baseUrl = (typeof args['base-url'] === 'string' ? args['base-url'] : user ? `https://${user.toLowerCase()}.github.io/${REPO}` : PLACEHOLDER_BASE).replace(/\/$/, '');
const publicUrl = (file) => `${baseUrl}/posts/${batch}/${file}`;

// --- captions -----------------------------------------------------------------

const captionsData = await readJson(path.join(QUOTES, 'captions.json'));
function hashtagsFor(theme) {
  return [...new Set([...captionsData.hashtags.base, ...(captionsData.hashtags.themes[theme] ?? [])])].slice(0, MAX_HASHTAGS);
}
// Posts without `overlay` predate the plain style and carry the quote on the image.
function composeCaption(post) {
  const parts = [post.overlay === false ? post.quote : post.caption_line];
  if (post.credit) parts.push(post.credit);
  parts.push(hashtagsFor(post.theme).join(' '));
  if (post.ai) parts.push(AI_LABEL);
  return parts.join('\n\n');
}
function applyPhoto(post, photo) {
  post.ai = false;
  post.photo = photo.key;
  post.photo_theme = path.basename(photo.key).split('_')[0];
  post.photo_source = photo.source;
  post.photographer = photo.meta?.photographer ?? null;
  post.credit = photo.source === 'unsplash' ? `📷 ${photo.meta.photographer} via Unsplash` : null;
  post.credit_url = photo.meta?.profile_link ?? null;
  post.caption = composeCaption(post);
}

function captionsMarkdown(posts) {
  const blocks = posts.map((p) => `## ${p.file}

**${p.quote}** · ${p.theme}${p.photo_theme !== p.theme ? ` (photo from ${p.photo_theme})` : ''} · ${p.ai ? 'AI image' : p.photo_source === 'unsplash' ? `Unsplash, ${p.photographer}` : 'own photo'}

\`\`\`text
${p.caption}
\`\`\`

${p.public_url}
`);
  return `# Batch ${batch} · ${posts.length} posts

Copy each caption as is. The 📷 line credits the photographer, as the Unsplash API guidelines require for photos fetched through the API.
AI images end with "${AI_LABEL}": keep that line too.
Nothing is ever posted automatically from this repository.

${blocks.join('\n')}`;
}

async function writeBatchFiles(posts, { images = posts.map((p) => p.file) } = {}) {
  await writeJson(path.join(outDir, 'posts.json'), posts);
  await writeFile(path.join(outDir, 'captions.md'), captionsMarkdown(posts));
  await mkdir(docsDir, { recursive: true });
  for (const file of images) await copyFile(path.join(outDir, file), path.join(docsDir, file));
  await copyFile(path.join(outDir, 'posts.json'), path.join(docsDir, 'posts.json'));
  await writeGallery();
}

// --- modes ----------------------------------------------------------------------

const quotes = await readJson(path.join(QUOTES, 'quotes.json'));
const used = await readJson(USED_FILE, {});
const photosUsed = await readJson(PHOTOS_USED_FILE, {});

if (args.relink) await relink();
else if (args.redo) await redo(String(args.redo));
else if (args.restyle) await restyle(String(args.restyle));
else if (args.scenes) await scenes(String(args.scenes));
else await build(Number(args.count ?? 30));

async function build(count) {
  if (!Number.isInteger(count) || count < 1) throw new Error('--count must be a positive integer');
  if (existsSync(path.join(outDir, 'posts.json')) || existsSync(docsDir))
    throw new Error(`Batch ${batch} already exists. Use another --batch name, or --redo NN to replace posts.`);
  await rm(outDir, { recursive: true, force: true }); // leftovers of an interrupted build

  // Plan everything first, so a shortage stops the build before anything is rendered.
  const season = seasonFor(batch);
  const quotesLeft = Object.fromEntries(
    THEMES.map((t) => [t, quotes.filter((q) => q.theme === t && !used[q.id] && inSeason(q, season))])
  );
  const photosLeft = Object.fromEntries(
    await Promise.all(THEMES.map(async (t) => [t, (await listPhotos(t)).filter((p) => !photosUsed[p.key])]))
  );
  const photoCounts = THEMES.map((t) => `${t} ${photosLeft[t].length}`).join(', ');
  // Themes with the most quotes left go first in each round; themes take turns so posts alternate.
  const order = [...THEMES].sort((a, b) => quotesLeft[b].length - quotesLeft[a].length || THEMES.indexOf(a) - THEMES.indexOf(b));
  const plan = [];
  const roundRobin = (photoThemeFor) => {
    let added = true;
    while (plan.length < count && added) {
      added = false;
      for (const theme of order) {
        if (plan.length >= count) break;
        const photoTheme = photoThemeFor(theme);
        if (!quotesLeft[theme].length || !photosLeft[photoTheme].length) continue;
        plan.push({ quote: quotesLeft[theme].shift(), photo: photosLeft[photoTheme].shift() });
        added = true;
      }
    }
  };
  roundRobin((theme) => theme); // each quote with a photo of its own theme
  roundRobin(() => FALLBACK_THEME); // themes that ran out of photos borrow mountain photos
  if (plan.length < count)
    throw new Error(
      `Only ${plan.length} of ${count} posts can be matched with an unused photo ` +
        `(unused photos per theme: ${photoCounts}). Run npm run fetch or add photos to photos/own/.`
    );

  const captionOffset = Object.fromEntries(
    THEMES.map((t) => [t, quotes.filter((q) => q.theme === t && used[q.id]).length])
  );
  const posts = plan.map(({ quote, photo }, i) => {
    const lines = captionsData.lines[quote.theme];
    const file = `${String(i + 1).padStart(2, '0')}_${quote.id}.${overlay ? 'png' : 'jpg'}`;
    const post = {
      file,
      quote_id: quote.id,
      quote: quote.text,
      theme: quote.theme,
      caption_line: lines[captionOffset[quote.theme]++ % lines.length],
      overlay,
      public_url: publicUrl(file),
    };
    applyPhoto(post, photo);
    return post;
  });

  console.log(`Building batch ${batch}: ${posts.length} posts, ${overlay ? 'overlay' : 'plain'} style (season filter: ${season ?? 'all-season quotes only'})`);
  if (args['dry-run']) {
    for (const p of posts) console.log(`  ${p.file}  ${p.theme.padEnd(10)} ${p.photo}`);
    report(posts, 'Plan only, nothing written');
    return;
  }
  const renderer = overlay ? await createRenderer() : null;
  try {
    for (const [i, post] of posts.entries()) {
      const fontSize = await renderPost(renderer, post, plan[i].photo.file, path.join(outDir, post.file));
      console.log(`  ${post.file}  ${post.theme.padEnd(10)} ${post.photo}${fontSize ? `  ${fontSize}px` : ''}`);
    }
  } finally {
    await renderer?.close();
  }
  try {
    await makeContactSheet(posts.map((p) => path.join(outDir, p.file)), path.join(outDir, 'contact-sheet.png'), { title: batch });
    await writeBatchFiles(posts);
  } catch (err) {
    // Leave no half-published batch behind: the same --batch name can then simply be built again.
    await rm(docsDir, { recursive: true, force: true });
    await rm(path.join(outDir, 'posts.json'), { force: true });
    await writeGallery().catch(() => {});
    throw err;
  }

  // State is recorded only once every file of the batch has been written.
  for (const p of posts) {
    used[p.quote_id] = batch;
    photosUsed[p.photo] = { batch, file: p.file };
  }
  await writeJson(USED_FILE, used);
  await writeJson(PHOTOS_USED_FILE, photosUsed);
  report(posts);
}

async function redo(list) {
  const posts = await readJson(path.join(outDir, 'posts.json'), null);
  if (!posts) throw new Error(`No batch ${batch} in out/. Pass --batch <name> of an existing batch.`);
  const numbers = [...new Set(list.split(',').map((n) => n.trim().padStart(2, '0')))];

  // Choose every replacement photo before rendering anything.
  const taken = new Set(Object.keys(photosUsed));
  const jobs = [];
  for (const nn of numbers) {
    const post = posts.find((p) => p.file.startsWith(`${nn}_`));
    if (!post) throw new Error(`Batch ${batch} has no post number ${nn}.`);
    // Same theme as the quote; a post that already borrowed a mountain photo may take another one.
    const themes = post.photo_theme === post.theme ? [post.theme] : [post.theme, FALLBACK_THEME];
    let photo = null;
    for (const t of themes) photo ??= (await listPhotos(t)).find((p) => !taken.has(p.key) && p.key !== post.photo);
    if (!photo)
      throw new Error(`No unused ${post.theme} photo left for ${post.file}. Run npm run fetch or add photos/own/${post.theme}_*.jpg.`);
    taken.add(photo.key);
    jobs.push({ post, photo });
  }
  if (args['dry-run']) {
    for (const { post, photo } of jobs)
      console.log(`  ${post.file}  ${post.photo} -> ${photo.key}${photo.meta?.score ? `  (score ${photo.meta.score})` : ''}`);
    console.log('Plan only, nothing written.');
    return;
  }

  const renderer = jobs.some((j) => j.post.overlay !== false) ? await createRenderer() : null;
  try {
    for (const { post, photo } of jobs) {
      const previous = post.photo;
      await renderPost(renderer, post, photo.file, path.join(outDir, post.file));
      applyPhoto(post, photo);
      // The replaced photo stays recorded as used, so it does not come back in a later batch.
      photosUsed[previous] = { ...photosUsed[previous], replaced_by: photo.key };
      photosUsed[photo.key] = { batch, file: post.file };
      console.log(`  ${post.file}  ${previous} -> ${photo.key}`);
    }
  } finally {
    await renderer?.close();
  }
  await makeContactSheet(posts.map((p) => path.join(outDir, p.file)), path.join(outDir, 'contact-sheet.png'), { title: batch });
  await writeBatchFiles(posts, { images: jobs.map((j) => j.post.file) });
  await writeJson(PHOTOS_USED_FILE, photosUsed);
  console.log(`Redid ${jobs.length} post(s) in batch ${batch}; the other posts are unchanged.`);
}

// Renders a post in its own style; returns the quote font size for the overlay style.
async function renderPost(renderer, post, photoFile, outPath) {
  if (post.overlay !== false) return (await renderer.render(quotes.find((q) => q.id === post.quote_id), photoFile, outPath)).fontSize;
  await finishPhoto(photoFile, outPath);
  return null;
}

// 18_q192.png -> 18_q192-v2.jpg, 18_q192-v2.jpg -> 18_q192-v3.jpg
function nextVersion(file, ext) {
  const [, stem, version] = file.match(/^(.*?)(?:-v(\d+))?\.\w+$/);
  return `${stem}-v${Number(version ?? 1) + 1}.${ext}`;
}

async function restyle(list) {
  const posts = await readJson(path.join(outDir, 'posts.json'), null);
  if (!posts) throw new Error(`No batch ${batch} in out/. Pass --batch <name> of an existing batch.`);
  const numbers = [...new Set(list.split(',').map((n) => n.trim().padStart(2, '0')))];
  const jobs = numbers.map((nn) => {
    const post = posts.find((p) => p.file.startsWith(`${nn}_`));
    if (!post) throw new Error(`Batch ${batch} has no post number ${nn}.`);
    if (post.ai) throw new Error(`${post.file} is an AI image, already finished: it is not re-rendered.`);
    if (post.overlay === false) throw new Error(`${post.file} is already in the plain style.`);
    const photoFile = path.join(ROOT, 'photos', post.photo);
    if (!existsSync(photoFile)) throw new Error(`${post.file}: photo ${post.photo} is missing from photos/.`);
    return { post, photoFile, file: nextVersion(post.file, 'jpg') };
  });
  if (args['dry-run']) {
    for (const { post, file } of jobs) console.log(`  ${post.file} -> ${file}  (${post.photo})`);
    console.log('Plan only, nothing written.');
    return;
  }

  for (const job of jobs) await finishPhoto(job.photoFile, path.join(outDir, job.file));
  // The previous image stays in out/ and docs/, so its public URL keeps working.
  for (const { post, file } of jobs) {
    console.log(`  ${post.file} -> ${file}`);
    Object.assign(post, { file, overlay: false, ai: false, public_url: publicUrl(file) });
    post.caption = composeCaption(post);
    photosUsed[post.photo] = { ...photosUsed[post.photo], file };
  }
  await makeContactSheet(posts.map((p) => path.join(outDir, p.file)), path.join(outDir, 'contact-sheet.png'), { title: batch });
  await writeBatchFiles(posts, { images: jobs.map((j) => j.file) });
  await writeJson(PHOTOS_USED_FILE, photosUsed);
  console.log(`Restyled ${jobs.length} post(s) in batch ${batch}; the other posts are unchanged.`);
}

// Finished images listed in a mapping file: { batch, ai, posts: { "04": "scenes/x.jpg", ... } },
// paths relative to the mapping file. They are copied as they are: no crop, no finishing pass.
async function scenes(mappingFile) {
  const posts = await readJson(path.join(outDir, 'posts.json'), null);
  if (!posts) throw new Error(`No batch ${batch} in out/. Pass --batch <name> of an existing batch.`);
  const mapping = await readJson(path.resolve(mappingFile));
  if (mapping.batch !== batch) throw new Error(`${mappingFile} is for batch ${mapping.batch}, not ${batch}.`);
  const ai = mapping.ai !== false;
  const skip = new Set(typeof args.skip === 'string' ? args.skip.split(',').map((n) => n.trim().padStart(2, '0')) : []);
  const jobs = [];
  for (const [nn, rel] of Object.entries(mapping.posts).sort(([a], [b]) => a.localeCompare(b))) {
    if (skip.has(nn)) continue;
    const post = posts.find((p) => p.file.startsWith(`${nn}_`));
    if (!post) throw new Error(`Batch ${batch} has no post number ${nn}.`);
    const source = path.resolve(path.dirname(mappingFile), rel);
    const key = path.relative(path.join(ROOT, 'photos'), source).split(path.sep).join('/');
    if (key.startsWith('..')) throw new Error(`${rel}: images must be under photos/.`);
    const { width, height } = jpegSize(await readFile(source));
    if (width !== WIDTH || height !== HEIGHT) throw new Error(`${rel}: ${width}x${height}, expected ${WIDTH}x${HEIGHT}.`);
    jobs.push({ post, source, key, file: nextVersion(post.file, 'jpg') });
  }
  if (args['dry-run']) {
    for (const { post, key, file } of jobs) console.log(`  ${post.file} -> ${file}  (${key})`);
    console.log('Plan only, nothing written.');
    return;
  }

  // The previous image stays in out/ and docs/, so its public URL keeps working.
  for (const { post, source, key, file } of jobs) {
    await copyFile(source, path.join(outDir, file));
    console.log(`  ${post.file} -> ${file}  (${key})`);
    photosUsed[post.photo] = { ...photosUsed[post.photo], replaced_by: key };
    photosUsed[key] = { batch, file };
    Object.assign(post, {
      file,
      overlay: false,
      ai,
      public_url: publicUrl(file),
      photo: key,
      photo_theme: post.theme,
      photo_source: ai ? 'ai' : 'own',
      photographer: null,
      credit: null,
      credit_url: null,
    });
    post.caption = composeCaption(post);
  }
  await makeContactSheet(posts.map((p) => path.join(outDir, p.file)), path.join(outDir, 'contact-sheet.png'), { title: batch });
  await writeBatchFiles(posts, { images: jobs.map((j) => j.file) });
  await writeJson(PHOTOS_USED_FILE, photosUsed);
  console.log(`Placed ${jobs.length} finished image(s) in batch ${batch}; the other posts are unchanged.`);
}

async function relink() {
  const posts = await readJson(path.join(outDir, 'posts.json'), null);
  if (!posts) throw new Error(`No batch ${batch} in out/.`);
  for (const p of posts) p.public_url = publicUrl(p.file);
  await writeBatchFiles(posts, { images: [] });
  console.log(`Rewrote public_url for ${posts.length} posts with ${baseUrl}`);
}

function report(posts, heading = `${posts.length} posts in out/${batch}/ and docs/posts/${batch}/`) {
  const byTheme = posts.reduce((acc, p) => ({ ...acc, [p.theme]: (acc[p.theme] ?? 0) + 1 }), {});
  const own = posts.filter((p) => p.photo_source === 'own').length;
  const borrowed = posts.filter((p) => p.photo_theme !== p.theme).length;
  console.log(`\nBatch ${batch}: ${heading}`);
  console.log(`  themes: ${Object.entries(byTheme).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  console.log(`  photos: ${own} own, ${posts.length - own} Unsplash${borrowed ? `, ${borrowed} borrowed from ${FALLBACK_THEME}` : ''}`);
  console.log(`  public base: ${baseUrl}${baseUrl === PLACEHOLDER_BASE ? '  (placeholder: GitHub user unknown)' : ''}`);
}
