import { chromium } from 'playwright-core';
import { initStorage, closeStorage } from './src/storage';
import { loadSettings } from './src/settings';
import { createServer } from './src/server';
import fs from 'fs';
import path from 'path';
import { loadScenarioFile } from './src/parser';
import { runScenario } from './src/runner';

const PORT = 3099;
const DB_PATH = path.join(__dirname, 'db-screenshots', 'scenarii.db');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

async function main() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // Init storage with a real file
  initStorage(DB_PATH);
  loadSettings();

  // Run a scenario so we have data
  const scenario = loadScenarioFile(path.join(__dirname, 'scenarios', 'lusk.yml'));
  console.log('Running scenario to populate data...');
  await runScenario(scenario, { headless: true, persist: true });
  console.log('Scenario done.\n');

  // Start the Express server
  const server = createServer(PORT);
  await new Promise(r => setTimeout(r, 1000));
  console.log(`Server on http://localhost:${PORT}\n`);

  // Launch system Chromium
  const browser = await chromium.launch({
    executablePath: '/usr/bin/chromium-browser',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    // ---------- Light theme ----------
    // Scenario list
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForSelector('app-root', { timeout: 10000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'scenario-list.png'), fullPage: true });
    console.log('✓ scenario-list.png');

    // Scenario detail
    await page.goto(`http://localhost:${PORT}/scenario/Lusk.bzh%20validation`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForSelector('app-root', { timeout: 10000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'scenario-detail.png'), fullPage: true });
    console.log('✓ scenario-detail.png');

    // ---------- Dark theme ----------
    await page.evaluate(`document.documentElement.setAttribute("data-bs-theme", "dark"); localStorage.setItem("scenarii-theme", "dark");`);

    // Scenario list (dark)
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForSelector('app-root', { timeout: 10000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'scenario-list-dark.png'), fullPage: true });
    console.log('✓ scenario-list-dark.png');

    // Scenario detail (dark)
    await page.goto(`http://localhost:${PORT}/scenario/Lusk.bzh%20validation`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForSelector('app-root', { timeout: 10000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'scenario-detail-dark.png'), fullPage: true });
    console.log('✓ scenario-detail-dark.png');

    console.log(`\nAll screenshots in ${SCREENSHOTS_DIR}/`);
  } finally {
    await browser.close();
    server.close();
    closeStorage();
    // Cleanup temp DB
    try {
      fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true });
    } catch {}
  }
}

main().catch(err => {
  console.error('Screenshot failed:', err);
  process.exit(1);
});
