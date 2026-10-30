"""Render candidate annotations; never infer reference truth from the implementation.

Usage: python render_annotations.py reference.png reference-annotations.json output.png
Requires Pillow (available in the Harness .venv).
"""
import hashlib
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


def digest(data):
    return hashlib.sha256(data).hexdigest()


def normalized_image(path):
    # Match Harness's orientation/white-background normalization. For embedded ICC profiles,
    # use the Harness-normalized reference PNG instead of assuming Pillow converts to sRGB.
    with Image.open(path) as source:
        source = ImageOps.exif_transpose(source).convert('RGBA')
        background = Image.new('RGBA', source.size, 'white')
        background.alpha_composite(source)
        return background.convert('RGB')


def render(reference_path, annotations_path, output_path):
    reference_path, annotations_path, output_path = map(Path, (reference_path, annotations_path, output_path))
    data = json.loads(annotations_path.read_text(encoding='utf-8-sig'))
    image = normalized_image(reference_path)
    # Hash is the exact normalized PNG produced by normalize-reference.ts.
    if data['image_sha256'] != digest(reference_path.read_bytes()):
        raise ValueError('reference hash mismatch; use the normalized PNG')
    if (data['image_width'], data['image_height']) != image.size:
        raise ValueError('reference dimensions mismatch')
    if data.get('version') != '1' or not data.get('regions'):
        raise ValueError('version 1 with nonempty regions required')
    seen, entries = set(), []
    # Validate everything before writing output, so a partial preview cannot look successful.
    for index, region in enumerate(data['regions'], 1):
        identity = region['region_id']
        if identity in seen or not identity or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in identity):
            raise ValueError('invalid or duplicate region id')
        seen.add(identity)
        box = region.get('bbox')
        if region['boundary'] == 'content_only':
            if box is not None or not isinstance(region.get('expected_text'), str):
                raise ValueError('content_only requires text and omits bbox')
        elif region['boundary'] == 'element_box' and box:
            x, y, width, height = (box[k] for k in ('x', 'y', 'width', 'height'))
            if not all(type(v) in (int, float) and math.isfinite(v) for v in (x, y, width, height)):
                raise ValueError('nonfinite bbox')
            if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > image.width or y + height > image.height:
                raise ValueError('bbox out of bounds')
        else:
            raise ValueError('element_box requires bbox')
        entries.append({'number': index, **region})
    output_path.parent.mkdir(parents=True, exist_ok=True)
    crops = output_path.parent / (output_path.stem + '-crops')
    crops.mkdir(exist_ok=True)
    overlay, draw = image.copy(), None
    draw = ImageDraw.Draw(overlay)
    for entry in entries:
        if 'bbox' not in entry:
            continue  # Content-only entries are listed in validation JSON, not invented boxes.
        b = entry['bbox']
        x, y, right, bottom = b['x'], b['y'], b['x'] + b['width'], b['y'] + b['height']
        draw.rectangle((x, y, right - 1, bottom - 1), outline='#e6003d', width=2)
        label = f"{entry['number']}: {entry['region_id']}"
        draw.text((x + 2, y + 2), label, fill='black', stroke_width=1, stroke_fill='white')
        crop = image.crop((max(0, math.floor(x) - 8), max(0, math.floor(y) - 8),
                           min(image.width, math.ceil(right) + 8), min(image.height, math.ceil(bottom) + 8)))
        crop.resize((crop.width * 2, crop.height * 2)).save(crops / f"{entry['number']:03}.png")
    overlay.save(output_path, format='PNG')
    manifest = {
        'image_sha256': data['image_sha256'],
        'annotations_sha256': digest(annotations_path.read_bytes()),
        'preview_sha256': digest(output_path.read_bytes()),
        'valid': True, 'regions': entries,
        'note': 'Preview generation does not prove visual review or annotation accuracy.',
    }
    Path(str(output_path) + '.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return manifest


if __name__ == '__main__':
    try:
        render(*sys.argv[1:])
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
