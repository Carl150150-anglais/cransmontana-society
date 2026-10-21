// Launches the Playwright Chromium installed inside node_modules (npm run browsers),
// so nothing is read from or written to the user's global caches.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';
const { chromium } = await import('playwright');

export function launchBrowser() {
  return chromium.launch({ headless: true });
}
