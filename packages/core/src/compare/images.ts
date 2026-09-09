import sharp from 'sharp';
import pixelmatch from 'pixelmatch';
import type { EvaluationProfile } from '../../../contracts/src/index.js';
export const MAX_PIXELS = 32_000_000;
export async function normalizeImage(
  input: Buffer,
  crop?: { x: number; y: number; width: number; height: number },
) {
  const metadata = await sharp(input, { limitInputPixels: MAX_PIXELS }).metadata();
  if (!['png', 'jpeg'].includes(metadata.format ?? '')) throw Error('unsupported_image_format');
  let pipeline = sharp(input, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .toColourspace('srgb')
    .flatten({ background: '#ffffff' })
    .ensureAlpha();
  // Materialize orientation before interpreting crop coordinates.
  const normalized = await pipeline.png().toBuffer();
  pipeline = sharp(normalized);
  if (crop)
    pipeline = pipeline.extract({
      left: crop.x,
      top: crop.y,
      width: crop.width,
      height: crop.height,
    });
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    png: await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png()
      .toBuffer(),
  };
}
export type Normalized = Awaited<ReturnType<typeof normalizeImage>>;
export function pixelCompare(
  reference: Normalized,
  actual: Normalized,
  profile: EvaluationProfile,
) {
  if (reference.width !== actual.width || reference.height !== actual.height)
    throw Error('dimension_mismatch');
  const { width, height } = reference,
    a = Buffer.from(reference.data),
    b = Buffer.from(actual.data),
    mask = new Uint8Array(width * height);
  for (const r of profile.masks) {
    if (r.x + r.width > width || r.y + r.height > height) throw Error('mask_out_of_bounds');
    for (let y = r.y; y < r.y + r.height; y++)
      for (let x = r.x; x < r.x + r.width; x++) mask[y * width + x] = 1;
  }
  let excluded = 0;
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      excluded++;
      a.fill(255, i * 4, i * 4 + 4);
      b.fill(255, i * 4, i * 4 + 4);
    }
  const evaluated = width * height - excluded;
  if (!evaluated) throw Error('empty_evaluation_mask');
  const diff = Buffer.alloc(a.length),
    strict = Buffer.alloc(a.length);
  pixelmatch(a, b, diff, width, height, {
    threshold: profile.pixel.threshold,
    includeAA: profile.pixel.include_aa,
  });
  pixelmatch(a, b, strict, width, height, { threshold: 0, includeAA: true });
  // Count mismatches only outside the approved mask (pixelmatch's default red output).
  const count = (pixels: Buffer) => {
    let n = 0;
    for (let i = 0; i < mask.length; i++)
      if (!mask[i] && pixels[i * 4] === 255 && pixels[i * 4 + 1] === 0 && pixels[i * 4 + 2] === 0)
        n++;
    return n;
  };
  const mismatched = count(diff),
    strictCount = count(strict);
  return {
    diff,
    strict,
    mismatched_pixels: mismatched,
    strict_mismatched_pixels: strictCount,
    evaluated_pixels: evaluated,
    difference_ratio: mismatched / evaluated,
    mask_coverage: excluded / (width * height),
    mask,
  };
}
export function regionPixels(
  reference: Normalized,
  actual: Normalized,
  regions: { region_id: string; bbox: { x: number; y: number; width: number; height: number } }[],
  profile: EvaluationProfile,
) {
  return regions.map((region) => {
    const r = region.bbox,
      x = Math.floor(r.x),
      y = Math.floor(r.y),
      width = Math.ceil(r.x + r.width) - x,
      height = Math.ceil(r.y + r.height) - y;
    const extract = (input: Normalized) => {
      const data = Buffer.alloc(width * height * 4);
      for (let row = 0; row < height; row++)
        input.data.copy(
          data,
          row * width * 4,
          ((y + row) * input.width + x) * 4,
          ((y + row) * input.width + x + width) * 4,
        );
      return { data, width, height, png: Buffer.alloc(0) };
    };
    const masks = profile.masks
      .map((m) => ({
        x: Math.max(x, m.x),
        y: Math.max(y, m.y),
        right: Math.min(x + width, m.x + m.width),
        bottom: Math.min(y + height, m.y + m.height),
      }))
      .filter((m) => m.right > m.x && m.bottom > m.y)
      .map((m) => ({ x: m.x - x, y: m.y - y, width: m.right - m.x, height: m.bottom - m.y }));
    const metric = pixelCompare(extract(reference), extract(actual), { ...profile, masks });
    return {
      region_id: region.region_id,
      evaluated_pixels: metric.evaluated_pixels,
      difference_ratio: metric.difference_ratio,
      pixel_score:
        100 * Math.max(0, Math.min(1, 1 - metric.difference_ratio / profile.pixel.d_bad)),
    };
  });
}
