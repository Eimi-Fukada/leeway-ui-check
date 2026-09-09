import { z } from 'zod';
export const SandboxPolicy = z
  .object({
    enabled: z.boolean().default(false),
    network: z.enum(['disabled', 'loopback', 'inherit']).default('loopback'),
    max_memory_mb: z.number().int().positive().default(2048),
    max_cpu_seconds: z.number().int().positive().default(600),
    max_processes: z.number().int().positive().default(128),
    read_only_source: z.boolean().default(true),
  })
  .strict();
export function sandboxEnvironment(p: z.infer<typeof SandboxPolicy>) {
  return {
    HARNESS_SANDBOX: p.enabled ? '1' : '0',
    HARNESS_NETWORK: p.network,
    HARNESS_SOURCE_READ_ONLY: p.read_only_source ? '1' : '0',
    NODE_OPTIONS: `--max-old-space-size=${p.max_memory_mb}`,
  };
}
