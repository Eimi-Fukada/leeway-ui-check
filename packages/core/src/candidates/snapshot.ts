import { readdir, readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { hash, inside } from '../storage/artifacts.js';
import type { TaskConfig } from '../../../contracts/src/index.js';
const excluded = new Set([
  'node_modules',
  '.git',
  '.venv',
  '.next',
  'dist',
  'build',
  'coverage',
  '.harness',
  '.cache',
]);
function secret(name: string) {
  return (
    /^\.env(?:\.|$)/i.test(name) ||
    /\.(pem|key|p12|pfx)$/i.test(name) ||
    ['.npmrc', '.pypirc', 'credentials.json', 'id_rsa', 'id_ed25519'].includes(name)
  );
}
export async function manifest(root: string, includeBuildOutputs = false) {
  const entries: { path: string; sha256: string; size: number }[] = [];
  let bytes = 0;
  async function visit(dir: string) {
    for (const file of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      if (
        (excluded.has(file.name) &&
          !(includeBuildOutputs && ['dist', 'build', '.next'].includes(file.name))) ||
        secret(file.name)
      )
        continue;
      if (
        path
          .relative(root, path.join(dir, file.name))
          .split(path.sep)
          .join('/')
          .startsWith('.next/cache')
      )
        continue;
      const absolute = path.join(dir, file.name),
        stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw Error('snapshot_symlink_rejected');
      if (stat.isDirectory()) await visit(absolute);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 256_000_000 || entries.length >= 20000) throw Error('snapshot_limit_exceeded');
        entries.push({
          path: path.relative(root, absolute).split(path.sep).join('/'),
          sha256: hash(await readFile(absolute)),
          size: stat.size,
        });
      }
    }
  }
  await visit(root);
  return entries;
}
export async function snapshot(
  source: string,
  destination: string,
  storeRoot: string,
  target: TaskConfig['target'],
) {
  const sourceRoot = await realpath(source);
  if (inside(sourceRoot, storeRoot) || inside(storeRoot, sourceRoot))
    throw Error('artifact_store_must_be_outside_target');
  const before = await manifest(sourceRoot);
  await mkdir(destination, { recursive: true });
  for (const file of before) {
    const bytes = await readFile(path.join(sourceRoot, file.path));
    if (hash(bytes) !== file.sha256) throw Error('source_changed_during_snapshot');
    const dest = path.join(destination, file.path);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes, { flag: 'wx' });
  }
  const after = await manifest(sourceRoot);
  if (hash(JSON.stringify(before)) !== hash(JSON.stringify(after)))
    throw Error('source_changed_during_snapshot');
  const assets =
    target.mode === 'managed'
      ? before.filter((e) => target.asset_extensions.includes(path.extname(e.path)))
      : [];
  return {
    entries: before,
    source_hash: hash(JSON.stringify(before)),
    asset_hash: hash(JSON.stringify(assets)),
    build_hash: hash(JSON.stringify(target)),
  };
}
