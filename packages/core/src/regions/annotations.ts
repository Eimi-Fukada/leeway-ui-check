import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { bindAnnotations, ReferenceAnnotations } from '../../../contracts/src/annotations.js';
import { hash } from '../storage/artifacts.js';
import type { TaskConfig } from '../../../contracts/src/index.js';

/** Read each file once; the exact validated bytes are subsequently persisted as evidence. */
export async function loadAnnotations(
  input: NonNullable<TaskConfig['annotation_input']>,
  reference: Buffer,
) {
  const [referenceBytes, bindingBytes, preview] = await Promise.all([
    readFile(input.reference_path),
    readFile(input.bindings_path),
    readFile(input.preview_path),
  ]);
  const annotations = ReferenceAnnotations.parse(JSON.parse(referenceBytes.toString('utf8')));
  const regions = bindAnnotations(annotations, JSON.parse(bindingBytes.toString('utf8')));
  const image = await sharp(reference).metadata(),
    overlay = await sharp(preview).metadata();
  if (annotations.image_sha256 !== hash(reference))
    throw Error('annotation_reference_hash_mismatch');
  if (image.width !== annotations.image_width || image.height !== annotations.image_height)
    throw Error('annotation_reference_dimension_mismatch');
  if (overlay.format !== 'png' || overlay.width !== image.width || overlay.height !== image.height)
    throw Error('annotation_preview_dimension_mismatch');
  // Preview provenance is checked through the renderer's manifest, not the review declaration.
  const manifestBytes = await readFile(`${input.preview_path}.json`);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (
    manifest.annotations_sha256 !== hash(referenceBytes) ||
    manifest.preview_sha256 !== hash(preview) ||
    manifest.image_sha256 !== hash(reference)
  )
    throw Error('annotation_preview_stale');
  return { regions, referenceBytes, bindingBytes, preview, manifestBytes };
}
