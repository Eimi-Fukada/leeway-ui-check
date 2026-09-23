import type { Page } from 'playwright';
import type { DOMEvidence } from '../../../contracts/src/feedback.js';
export async function collectDOM(
  page: Page,
  dpr: number,
  origin: { x: number; y: number },
  crop: { x: number; y: number } | undefined,
  width: number,
  height: number,
): Promise<{ elements: DOMEvidence[]; truncated: boolean }> {
  return page.evaluate(
    ({ dpr, origin, crop, width, height }) => {
      const elements: DOMEvidence[] = [];
      let truncated = false;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let visited = 0;
      const properties = [
        'font-size',
        'line-height',
        'font-family',
        'color',
        'background-color',
        'padding',
        'margin',
        'display',
        'position',
        'width',
        'height',
        'box-sizing',
        'overflow',
        'white-space',
        'text-overflow',
      ];
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (++visited > 20000) {
          truncated = true;
          break;
        }
        const el = node as HTMLElement,
          tag = el.tagName.toLowerCase();
        if (
          ['script', 'style', 'meta', 'link', 'noscript'].includes(tag) ||
          (tag === 'input' && ['hidden', 'password'].includes((el as HTMLInputElement).type))
        )
          continue;
        const s = getComputedStyle(el),
          r = el.getBoundingClientRect();
        if (
          s.display === 'none' ||
          s.visibility === 'hidden' ||
          Number(s.opacity) === 0 ||
          !r.width ||
          !r.height
        )
          continue;
        const x = Math.max(0, Math.floor((r.x - origin.x) * dpr - (crop?.x ?? 0))),
          y = Math.max(0, Math.floor((r.y - origin.y) * dpr - (crop?.y ?? 0)));
        const right = Math.min(width, Math.ceil((r.right - origin.x) * dpr - (crop?.x ?? 0))),
          bottom = Math.min(height, Math.ceil((r.bottom - origin.y) * dpr - (crop?.y ?? 0)));
        if (right <= x || bottom <= y) continue;
        if (elements.length >= 2000) {
          truncated = true;
          break;
        }
        let selector: string | null = null;
        const testId = el.getAttribute('data-testid');
        const guesses = [
          ...(testId ? [`[data-testid=${CSS.escape(testId)}]`] : []),
          ...(el.id ? [`#${CSS.escape(el.id)}`] : []),
        ];
        let current: Element | null = el;
        const parts: string[] = [];
        for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
          const name = current.tagName.toLowerCase();
          const siblings = current.parentElement
            ? Array.from(current.parentElement.children).filter(
                (c) => c.tagName === current!.tagName,
              )
            : [current];
          parts.unshift(`${name}:nth-of-type(${siblings.indexOf(current) + 1})`);
          guesses.push(parts.join(' > '));
        }
        for (const guess of guesses) {
          try {
            const matches = document.querySelectorAll(guess);
            if (matches.length === 1 && matches[0] === el) {
              selector = guess;
              break;
            }
          } catch {}
        }
        const directText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent ?? '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200);
        elements.push({
          selector,
          match_status: selector ? 'unique' : 'unavailable',
          tag,
          text_excerpt: directText,
          bbox_px: { x, y, width: right - x, height: bottom - y },
          full_bbox_px: {
            x: (r.x - origin.x) * dpr - (crop?.x ?? 0),
            y: (r.y - origin.y) * dpr - (crop?.y ?? 0),
            width: r.width * dpr,
            height: r.height * dpr,
          },
          actual_styles: Object.fromEntries(
            properties.map((p) => [p, s.getPropertyValue(p).slice(0, 200)]),
          ),
        });
      }
      return { elements, truncated };
    },
    { dpr, origin, crop, width, height },
  );
}
