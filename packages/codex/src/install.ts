import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import os from 'node:os';

// Produce concrete project-local wiring; never edit global Codex config or remove other hooks.
export async function installCodexWorkflow(
  projectDir: string,
  harnessHome = process.env.HARNESS_HOME ?? path.join(os.homedir(), '.leeway-ui-check'),
) {
  const project = path.resolve(projectDir);
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const launcher = path.join(repo, 'scripts/codex-hook.mjs');
  const home = path.resolve(harnessHome);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const command = [process.execPath, launcher, home].map(quote).join(' ');
  // Invoke PowerShell explicitly so Windows shell differences do not change quoting semantics.
  const ps = '& ' + [process.execPath, launcher, home].map(psQuote).join(' ');
  const commandWindows =
    'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' +
    Buffer.from(ps, 'utf16le').toString('base64');
  const handler = {
    type: 'command',
    command,
    commandWindows,
    timeout: 10,
    statusMessage: 'Checking Leeway UI task',
  };
  const file = path.join(project, '.codex/hooks.json');
  let config: {
    hooks?: Record<string, { matcher?: string; hooks: Record<string, unknown>[] }[]>;
    [key: string]: unknown;
  } = {};
  try {
    config = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const hooks = (config.hooks ??= {});
  for (const event of ['PostToolUse', 'Stop', 'Interrupt']) {
    const entries = (hooks[event] ??= []);
    for (const entry of entries)
      entry.hooks = entry.hooks.filter((h) => h.statusMessage !== handler.statusMessage);
    const entry = {
      ...(event === 'PostToolUse' ? { matcher: '^mcp__leeway-ui-check__ui_check_start$' } : {}),
      hooks: [{ ...handler, timeout: event === 'Interrupt' ? 3 : 10 }],
    };
    hooks[event] = [...entries.filter((e) => e.hooks.length), entry];
  }
  await mkdir(path.dirname(file), { recursive: true });
  const skillDir = path.join(project, '.agents/skills/leeway-ui-check');
  await mkdir(skillDir, { recursive: true });
  const source = path.join(repo, '.agents/skills/leeway-ui-check/SKILL.md');
  const target = path.join(skillDir, 'SKILL.md');
  if (path.resolve(source) !== path.resolve(target)) await copyFile(source, target);
  await writeFile(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return {
    hooks: file,
    skill: target,
    harness_home: home,
    next: 'Use the same HARNESS_HOME in MCP; review and trust these project hooks in Codex before starting a new UI task.',
  };
}
