import { mkdir, writeFile } from 'node:fs/promises';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { TaskInput, Profile, Report } from '../packages/contracts/src/index.js';
import {
  ReferenceAnnotations,
  ImplementationBindings,
} from '../packages/contracts/src/annotations.js';
// 将运行时 Zod 合同导出为可供外部工具阅读的 JSON Schema，不执行任何评测。
await mkdir('packages/contracts/schemas', { recursive: true });
for (const [name, schema] of Object.entries({
  task: TaskInput,
  profile: Profile,
  report: Report,
  annotations: ReferenceAnnotations,
  bindings: ImplementationBindings,
}))
  await writeFile(
    `packages/contracts/schemas/${name}.schema.json`,
    JSON.stringify(zodToJsonSchema(schema, { name, $refStrategy: 'none' }), null, 2) + '\n',
  );
