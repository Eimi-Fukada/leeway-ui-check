import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../runtime/subprocess.js';
import type { EvaluationProfile } from '../../../contracts/src/index.js';
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
/**
 * 选择 SSIM 使用的 Python：优先 HARNESS_PYTHON，否则使用 Harness 自己的虚拟环境。
 */
export const pythonPath = () =>
  process.env.HARNESS_PYTHON ??
  path.join(repoRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
/**
 * 通过有超时限制的 Python 子进程计算两份图像证据的 SSIM，并校验返回值范围。
 * 输入通过 JSONL 传入；执行的是 Harness 自身计算脚本。
 */
export async function ssim(
  root: string,
  reference: { path: string; sha256: string },
  actual: { path: string; sha256: string },
  profile: EvaluationProfile,
  signal: AbortSignal,
) {
  const result = await runCommand(
    { executable: pythonPath(), args: [path.join(repoRoot, 'workers/ssim_worker.py')] },
    repoRoot,
    AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    JSON.stringify({
      artifact_root: root,
      reference,
      actual,
      window: profile.ssim.window,
      gaussian_weights: profile.ssim.gaussian_weights,
      masks: profile.masks,
    }) + '\n',
  );
  const value = JSON.parse(result.stdout.trim());
  if (!value.ok) throw Error(value.error);
  if (
    typeof value.ssim !== 'number' ||
    !Number.isFinite(value.ssim) ||
    value.ssim < -1 ||
    value.ssim > 1
  )
    throw Error('invalid_ssim_response');
  return value.ssim as number;
}
