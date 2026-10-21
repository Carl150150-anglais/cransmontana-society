// Shared paths and small JSON helpers.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC = path.join(ROOT, 'src');
export const QUOTES = path.join(ROOT, 'quotes');
export const FONTS_CSS = path.join(ROOT, 'assets/fonts/fonts.css');
export const PHOTOS_OWN = path.join(ROOT, 'photos/own');
export const PHOTOS_UNSPLASH = path.join(ROOT, 'photos/unsplash');
export const STATE = path.join(ROOT, 'state');
export const OUT = path.join(ROOT, 'out');
export const DOCS = path.join(ROOT, 'docs');

export const THEMES = ['ambition', 'mountain', 'discipline', 'cars', 'watches', 'chalets', 'ski', 'golf', 'dining'];

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

export async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
}

// Minimal "--name value" / "--flag" argument parser.
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}
