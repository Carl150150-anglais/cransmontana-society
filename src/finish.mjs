// The finishing pass of the plain posts: the photo alone, as a 1080x1350 JPEG, with the same
// ffmpeg pass as the AI scenes. The reel has its own grading (GRADE in src/reel.mjs).
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { WIDTH, HEIGHT, jpegSize } from './render.mjs';

// Centre crop to 4:5 first (a no-op for photos already 1080x1350), then the pass itself, unchanged.
const CROP = "crop='min(iw,ih*4/5)':'min(ih,iw*5/4)'";
export const FINISH =
  'scale=1080:1350:flags=lanczos,eq=contrast=1.05:saturation=0.94:gamma=0.98,' +
  'vignette=angle=PI/6:mode=forward,noise=alls=7:allf=t+u,unsharp=3:3:0.3';

export async function finishPhoto(input, output) {
  await mkdir(path.dirname(output), { recursive: true });
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', `${CROP},${FINISH}`, '-frames:v', '1', '-q:v', '2', output], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const { width, height } = jpegSize(await readFile(output));
  if (width !== WIDTH || height !== HEIGHT) throw new Error(`${output}: ${width}x${height}, expected ${WIDTH}x${HEIGHT}`);
}
