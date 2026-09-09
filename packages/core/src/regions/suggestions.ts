import { readFile } from 'node:fs/promises';
export type RegionSuggestion = {
  source: 'dom' | 'ocr' | 'visual';
  selector?: string;
  expected_text?: string;
  confidence: number;
  reason: string;
  requires_confirmation: true;
};
export async function suggestRegions(sourceDir: string): Promise<RegionSuggestion[]> {
  const html = await readFile(`${sourceDir}/index.html`, 'utf8').catch(() => ''),
    out: RegionSuggestion[] = [];
  for (const m of html.matchAll(
    /<(h[1-6]|button|input|img|nav|header|main|footer)\b[^>]*(?:data-testid=["']([^"']+)["'])?[^>]*>([^<]{2,120})/gi,
  )) {
    const tag = m[1].toLowerCase(),
      id = m[2],
      text = m[3]?.replace(/\s+/g, ' ').trim();
    out.push({
      source: 'dom',
      selector: id ? `[data-testid="${id}"]` : tag,
      expected_text: text || undefined,
      confidence: id ? 0.95 : 0.55,
      reason: 'visible semantic DOM candidate',
      requires_confirmation: true,
    });
  }
  out.push(
    {
      source: 'ocr',
      confidence: 0,
      reason: 'OCR provider not configured; manual confirmation required',
      requires_confirmation: true,
    },
    {
      source: 'visual',
      confidence: 0,
      reason: 'visual model provider not configured; diagnostic only',
      requires_confirmation: true,
    },
  );
  return out;
}
