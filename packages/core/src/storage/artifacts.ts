import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import path from 'node:path';
export const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export function inside(root: string, target: string) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
export class ArtifactStore {
  constructor(readonly root: string) {}
  async put(data: Buffer | string, extension: string) {
    if (!/^[a-z]+$/.test(extension)) throw Error('invalid_artifact_extension');
    await mkdir(this.root, { recursive: true });
    const sha256 = hash(data),
      artifact_id = `art_${sha256}_${extension}`,
      filename = path.join(this.root, `${artifact_id}.${extension}`);
    const temp = filename + '.' + randomUUID() + '.tmp';
    await writeFile(temp, data, { flag: 'wx' });
    await rename(temp, filename);
    return {
      artifact_id,
      sha256,
      path: filename,
      media_type:
        extension === 'png'
          ? 'image/png'
          : extension === 'json'
            ? 'application/json'
            : extension === 'bin'
              ? 'application/octet-stream'
              : 'text/plain',
    };
  }
  async read(record: { path: string; sha256: string }) {
    const filename = await realpath(record.path);
    if (!inside(await realpath(this.root), filename)) throw Error('artifact_outside_store');
    const data = await readFile(filename);
    if (hash(data) !== record.sha256) throw Error('artifact_hash_mismatch');
    return data;
  }
}
