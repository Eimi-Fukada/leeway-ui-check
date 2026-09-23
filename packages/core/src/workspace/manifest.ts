import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { hash } from '../storage/artifacts.js';
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
      const absolute = path.join(dir, file.name),
        relative = path.relative(root, absolute).split(path.sep).join('/');
      if (relative.startsWith('.next/cache')) continue;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw Error('workspace_symlink_rejected');
      if (stat.isDirectory()) await visit(absolute);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 256_000_000 || entries.length >= 20000) throw Error('workspace_limit_exceeded');
        entries.push({ path: relative, sha256: hash(await readFile(absolute)), size: stat.size });
      }
    }
  }
  await visit(root);
  return entries;
}
