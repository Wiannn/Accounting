import { cpSync, mkdirSync, rmSync } from 'node:fs';

const assets = [
  'index.html',
  'favicon.ico',
  'app.css',
  'app.js',
  'xlsx.min.js',
  'manifest.webmanifest',
  'sw.js',
  'icons'
];

rmSync('www', { recursive: true, force: true });
mkdirSync('www', { recursive: true });
for (const asset of assets) {
  cpSync(asset, `www/${asset}`, { recursive: true });
}
