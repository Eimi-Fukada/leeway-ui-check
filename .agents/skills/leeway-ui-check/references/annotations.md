# Reference annotation workflow

Use Codex vision to propose annotations. No external model API or OCR service is called by Harness.
Only annotate reference evidence; implementation DOM supplies selectors, never expected values.

1. In the Harness checkout run `npx tsx scripts/normalize-reference.ts original.png normalized.png`.
   This prints the SHA-256 and dimensions. Use the resulting normalized PNG as `reference_image_path`.
2. View that PNG. Write `reference-annotations.json` using the contract below. Start with visible
   cards, buttons and images (`element_box`) and important copy/prices (`content_only`).
   A text glyph rectangle is not a CSS box. Do not infer exact font weight from pixels.
3. Run the bundled renderer with Harness's `.venv` Python (or Python with Pillow):
   `python render_annotations.py normalized.png reference-annotations.json preview.png`.
   Open `preview.png`, its numbered crops and the JSON text list. Correct inaccurate boxes/copy.
   Content-only entries deliberately have no visual box. Record unreadable content in `unresolved`.
4. After actual inspection set `preview_reviewed=true`, clear only resolved uncertainties, and
   rerun the renderer. Every annotation file edit invalidates the previous preview manifest.
   This flag is a caller declaration, not independent proof of review. Do not automate setting it.
5. Read implementation source/DOM and write bindings. Use stable unique selectors, preferably
   `data-testid`. Do not select a large ancestor to hide a missing child. Match the same semantic box.
6. Pass all three absolute paths under `annotation_input` to `ui_check_start`:
   `reference_path`, `bindings_path`, `preview_path`. Keep `preview.png.json` beside the preview.
   Do not also pass `regions`. The server checks normalized image hash/dimensions, matching IDs,
   unresolved items and preview manifest. It freezes imported files in evidence storage.

Reference file (coordinates are normalized image pixels, not CSS pixels):

```json
{
  "version": "1",
  "image_sha256": "<64 lowercase hex characters from normalization>",
  "image_width": 390,
  "image_height": 844,
  "source": "codex",
  "preview_reviewed": false,
  "unresolved": [],
  "regions": [
    {
      "region_id": "subscribe",
      "kind": "component",
      "boundary": "element_box",
      "bbox": { "x": 12, "y": 760, "width": 366, "height": 40 }
    },
    { "region_id": "price", "kind": "text", "boundary": "content_only", "expected_text": "¥136" }
  ]
}
```

Bindings file:

```json
{
  "version": "1",
  "bindings": [
    { "region_id": "subscribe", "selector": "[data-testid='subscribe']" },
    { "region_id": "price", "selector": "[data-testid='price']" }
  ]
}
```

Initial fixed policy: every selected region is required (`critical=true`), equal regional weight,
10-image-pixel position/size deduction scales. These are provisional policy values, not proven
human acceptance tolerances. The existing critical geometry/pixel gates apply to boxes; content-only
regions get text/visibility checks without local pixel or geometry scores. This is selected-region
coverage, not a guarantee that Codex found every relevant element. Do not change rules to pass.

If annotation cannot be completed reliably, report why. Image-only evaluation is an explicit fallback,
not an annotated acceptance result. No OCR, font identification, or independent review is implied.
