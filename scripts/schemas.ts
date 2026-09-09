import { mkdir, writeFile } from 'node:fs/promises';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { TaskInput, Profile, Report } from '../packages/contracts/src/index.js';
await mkdir('packages/contracts/schemas', { recursive: true });
for (const [name, schema] of Object.entries({ task: TaskInput, profile: Profile, report: Report }))
  await writeFile(
    `packages/contracts/schemas/${name}.schema.json`,
    JSON.stringify(zodToJsonSchema(schema, { name, $refStrategy: 'none' }), null, 2) + '\n',
  );
