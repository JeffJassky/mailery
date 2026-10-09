/** Pure tooltip placement (components/tip.tsx). */
const GAP = 6
const EDGE = 8

/** Pure placement: where a tooltip of (w, h) goes for an anchor rect. */
export function placeTip(
  anchor: { left: number; right: number; top: number; bottom: number },
  size: { w: number; h: number },
  viewport: { w: number },
): { left: number; top: number; place: 'above' | 'below' } {
  const cx = (anchor.left + anchor.right) / 2
  const left = Math.max(EDGE, Math.min(cx - size.w / 2, viewport.w - size.w - EDGE))
  const aboveTop = anchor.top - size.h - GAP
  if (aboveTop >= EDGE) return { left, top: aboveTop, place: 'above' }
  return { left, top: anchor.bottom + GAP, place: 'below' }
}
