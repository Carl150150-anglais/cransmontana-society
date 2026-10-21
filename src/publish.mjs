// Commits docs/ and state/ (and nothing else), then pushes. Run with: npm run publish
// This only updates the review gallery on GitHub Pages; nothing is ever posted to Instagram.
import { execFileSync } from 'node:child_process';
import { ROOT } from './paths.mjs';

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

git('add', '--', 'docs', 'state');
const changed = git('diff', '--cached', '--name-only', '--', 'docs', 'state');
if (!changed) {
  console.log('Nothing new to publish.');
  process.exit(0);
}
const batches = [...new Set(changed.split('\n').map((f) => f.match(/^docs\/posts\/([^/]+)\//)?.[1]).filter(Boolean))];
const message = batches.length ? `Publish batch ${batches.join(', ')}` : 'Update gallery and state';
git('commit', '-m', message, '--', 'docs', 'state');
console.log(`Committed: ${message}`);
execFileSync('git', ['push'], { cwd: ROOT, stdio: 'inherit' });
console.log('Pushed. GitHub Pages refreshes within a few minutes.');
