"""One bounded JSONL request. stdout is protocol-only; paths and hashes are verified."""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity

Image.MAX_IMAGE_PIXELS = 32_000_000

def load(item, root):
    file = Path(item['path']).resolve()
    if not file.is_relative_to(root):
        raise ValueError('artifact_outside_store')
    raw = file.read_bytes()
    if hashlib.sha256(raw).hexdigest() != item['sha256']:
        raise ValueError('artifact_hash_mismatch')
    with Image.open(file) as image:
        if image.width * image.height > 32_000_000:
            raise ValueError('pixel_limit_exceeded')
        return np.array(image.convert('RGB'), dtype=np.uint8)

def evaluate(request):
    root = Path(request['artifact_root']).resolve()
    a, b = load(request['reference'], root), load(request['actual'], root)
    window = request['window']
    if a.shape != b.shape:
        raise ValueError('dimension_mismatch')
    if min(a.shape[:2]) < window:
        raise ValueError('ssim_region_too_small')
    valid = np.ones(a.shape[:2], dtype=bool)
    # Exclude every SSIM center whose neighborhood intersects a mask.
    radius = max((window-1)//2, 5 if request['gaussian_weights'] else 0)
    for r in request['masks']:
        x, y, w, h = r['x'], r['y'], r['width'], r['height']
        valid[max(0,y-radius):y+h+radius, max(0,x-radius):x+w+radius] = False
        a[y:y+h,x:x+w] = 255
        b[y:y+h,x:x+w] = 255
    _, similarity = structural_similarity(a,b,data_range=255,channel_axis=2,win_size=window,
        gaussian_weights=request['gaussian_weights'],sigma=1.5,use_sample_covariance=True,full=True)
    valid[:radius,:] = False
    valid[-radius:,:] = False
    valid[:,:radius] = False
    valid[:,-radius:] = False
    if not valid.any():
        raise ValueError('ssim_no_evaluated_pixels')
    return {'ssim':float(np.mean(similarity[valid])), 'implementation':'scikit-image-0.25.2'}

for line in sys.stdin:
    try:
        print(json.dumps({'ok':True,**evaluate(json.loads(line))},allow_nan=False),flush=True)
    except Exception as error:
        print(json.dumps({'ok':False,'error':str(error)}),flush=True)
