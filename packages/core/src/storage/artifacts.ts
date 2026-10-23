import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import path from 'node:path';
/**
 * 计算内容 SHA-256，作为证据寻址与完整性校验依据。
 */
export const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
/**
 * 生成带类型前缀的随机业务 ID，便于区分任务、候选和评测。
 */
export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
/**
 * 用解析后的相对路径判断目标是否位于存储根目录内，避免越界文件访问。
 */
export function inside(root: string, target: string) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
export class ArtifactStore {
  /**
   * 记录证据文件根目录；文件在首次写入时创建。
   */
  constructor(readonly root: string) {}
  /**
   * 按内容哈希生成证据 ID，通过临时文件和 rename 写入完整内容，返回媒体类型等元数据。
   */
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
  /**
   * 解析真实路径并检查存储边界，读取后复核哈希，拒绝越界或被篡改的证据。
   */
  async read(record: { path: string; sha256: string }) {
    const filename = await realpath(record.path);
    if (!inside(await realpath(this.root), filename)) throw Error('artifact_outside_store');
    const data = await readFile(filename);
    if (hash(data) !== record.sha256) throw Error('artifact_hash_mismatch');
    return data;
  }
}
