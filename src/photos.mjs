// Photo library: photos/own/<theme>_* first, then photos/unsplash/<theme>_*.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { PHOTOS_OWN, PHOTOS_UNSPLASH, readJson } from './paths.mjs';

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

async function listDir(dir) {
  try {
    return (await readdir(dir)).filter((f) => IMAGE_EXT.test(f)).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Returns [{ key, file, source: 'own' | 'unsplash', meta }] for one theme, own photos first.
export async function listPhotos(theme) {
  const own = (await listDir(PHOTOS_OWN))
    .filter((f) => f.startsWith(`${theme}_`))
    .map((f) => ({ key: `own/${f}`, file: path.join(PHOTOS_OWN, f), source: 'own', meta: null }));
  const unsplash = [];
  for (const f of (await listDir(PHOTOS_UNSPLASH)).filter((f) => f.startsWith(`${theme}_`))) {
    const meta = await readJson(path.join(PHOTOS_UNSPLASH, f.replace(IMAGE_EXT, '.json')), null);
    if (!meta) continue; // without metadata there is no credit line, so the photo is not usable
    unsplash.push({ key: `unsplash/${f}`, file: path.join(PHOTOS_UNSPLASH, f), source: 'unsplash', meta });
  }
  return [...own, ...unsplash];
}
