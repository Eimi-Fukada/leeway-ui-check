import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
export type ProjectDetection = {
  framework: 'react' | 'vue' | 'svelte' | 'unknown';
  bundler: 'vite' | 'next' | 'unknown';
  styling: string[];
  entrypoints: string[];
  start: { executable: string; args: string[] };
  confidence: number;
  signals: string[];
};
export async function detectProject(root: string): Promise<ProjectDetection> {
  const pkg = JSON.parse(
      await readFile(path.join(root, 'package.json'), 'utf8').catch(() => '{"dependencies":{}}'),
    ),
    deps = { ...pkg.dependencies, ...pkg.devDependencies },
    signals: string[] = [];
  const framework = deps.react ? 'react' : deps.vue ? 'vue' : deps.svelte ? 'svelte' : 'unknown',
    bundler = deps.next ? 'next' : deps.vite ? 'vite' : 'unknown';
  if (framework !== 'unknown') signals.push(`dependency:${framework}`);
  if (bundler !== 'unknown') signals.push(`dependency:${bundler}`);
  const styling: string[] = [];
  if (deps.tailwindcss) styling.push('tailwind');
  const entrypoints: string[] = [];
  for (const p of [
    'src/main.tsx',
    'src/main.jsx',
    'src/main.ts',
    'src/main.js',
    'app/page.tsx',
    'pages/index.tsx',
    'src/App.vue',
    'src/routes/+page.svelte',
  ])
    try {
      await readFile(path.join(root, p));
      entrypoints.push(p);
    } catch {}
  return {
    framework,
    bundler,
    styling,
    entrypoints,
    start:
      bundler === 'next'
        ? { executable: 'npm', args: ['run', 'dev', '--', '--hostname', '127.0.0.1'] }
        : { executable: 'npm', args: ['run', 'dev', '--', '--host', '127.0.0.1'] },
    confidence: Math.min(1, (signals.length + entrypoints.length) / 4),
    signals,
  };
}
