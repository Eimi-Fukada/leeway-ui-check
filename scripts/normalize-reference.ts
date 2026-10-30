import { readFile, writeFile } from 'node:fs/promises';
import { normalizeImage } from '../packages/core/src/compare/images.js';
import { hash } from '../packages/core/src/storage/artifacts.js';

const [source, output] = process.argv.slice(2);
if (!source || !output || source === output)
  throw Error(
    'usage: tsx scripts/normalize-reference.ts source.png normalized.png (distinct paths)',
  );
const normalized = await normalizeImage(await readFile(source));
await writeFile(output, normalized.png, { flag: 'wx' });
console.log(
  JSON.stringify({
    image_sha256: hash(normalized.png),
    image_width: normalized.width,
    image_height: normalized.height,
  }),
);
