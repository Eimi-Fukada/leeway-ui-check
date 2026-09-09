import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { defaultProfile, Profile, Report } from '../../packages/contracts/src/index.js';
import {
  geometry,
  textSimilarity,
  inspectRegions,
} from '../../packages/core/src/scoring/evaluate.js';
import { normalizeImage, pixelCompare } from '../../packages/core/src/compare/images.js';
describe('comparison contracts', () => {
  it('measures a 16px position difference without post-alignment', () => {
    expect(
      geometry(
        { x: 0, y: 0, width: 100, height: 40 },
        { x: 0, y: 16, width: 100, height: 40 },
        16,
        16,
      ),
    ).toBe(75);
  });
  it('normalizes Unicode and whitespace without silently changing numbers', () => {
    expect(textSimilarity('café  10', 'cafe\u0301 10', 'unicode_whitespace')).toBe(100);
    expect(textSimilarity('￥100', '￥900', 'unicode_whitespace')).toBe(75);
  });
  it('requires calibrated evidence and rejects unknown fields, NaN and invalid tolerance', () => {
    expect(() => Profile.parse({ ...defaultProfile, status: 'validated' })).toThrow();
    expect(() =>
      Profile.parse({ ...defaultProfile, weights: { ...defaultProfile.weights, pixel: NaN } }),
    ).toThrow();
    expect(() => Profile.parse({ ...defaultProfile, extra: true })).toThrow();
  });
  it('has exact identity, explicit dimension rejection and a correct masked denominator', async () => {
    const image = await sharp({
        create: { width: 20, height: 20, channels: 4, background: '#ffffff' },
      })
        .png()
        .toBuffer(),
      ref = await normalizeImage(image);
    expect(pixelCompare(ref, ref, defaultProfile).difference_ratio).toBe(0);
    expect(() => pixelCompare(ref, { ...ref, width: 21 }, defaultProfile)).toThrow(
      'dimension_mismatch',
    );
    const other = await normalizeImage(
      await sharp({ create: { width: 20, height: 20, channels: 4, background: '#000000' } })
        .png()
        .toBuffer(),
    );
    const compared = pixelCompare(ref, other, {
      ...defaultProfile,
      masks: [{ x: 0, y: 0, width: 10, height: 20 }],
    });
    expect(compared.evaluated_pixels).toBe(200);
    expect(compared.mismatched_pixels).toBe(200);
    expect(compared.difference_ratio).toBe(1);
    expect(() =>
      pixelCompare(ref, other, {
        ...defaultProfile,
        masks: [{ x: 0, y: 0, width: 20, height: 20 }],
      }),
    ).toThrow('empty_evaluation_mask');
  });
  it('rejects non-image data', async () => {
    await expect(normalizeImage(Buffer.from('hello'))).rejects.toThrow();
  });
});
