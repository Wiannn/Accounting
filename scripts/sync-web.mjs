import { cpSync, mkdirSync, rmSync } from 'node:fs';

const assets = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'assets'
];

rmSync('www', { recursive: true, force: true });
mkdirSync('www', { recursive: true });
for (const asset of assets) {
  cpSync(asset, `www/${asset}`, { recursive: true });
}
