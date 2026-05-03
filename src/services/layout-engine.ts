import type { PaneLayout } from '../types/layout';

export type LayoutPreset =
  | 'auto'
  | 'single'
  | 'columns'
  | 'rows'
  | 'grid'
  | 'main-right'
  | 'main-left';

export const LAYOUT_PRESETS: { id: LayoutPreset; label: string; icon: string; help: string }[] = [
  { id: 'auto', label: 'Auto', icon: '▦', help: 'Smart tiling — picks the best layout based on the number of panes (1=full, 2=side, 3=L-stack, 4+=grid).' },
  { id: 'single', label: 'Single', icon: '▢', help: 'Stack all panes full-screen; only the active one is visible (use tabs to switch).' },
  { id: 'columns', label: 'Columns', icon: '▌▌', help: 'Equal-width vertical columns, one per pane.' },
  { id: 'rows', label: 'Rows', icon: '☰', help: 'Equal-height horizontal rows, one per pane.' },
  { id: 'grid', label: 'Grid', icon: '▦', help: 'Uniform grid layout (cols = ⌈√n⌉).' },
  { id: 'main-left', label: 'Main-L', icon: '◧', help: 'Big main pane on the left, others stacked on the right.' },
  { id: 'main-right', label: 'Main-R', icon: '◨', help: 'Big main pane on the right, others stacked on the left.' },
];

export function calculateLayoutPreset(
  preset: LayoutPreset,
  paneCount: number,
): PaneLayout[] {
  if (paneCount === 0) return [];
  if (preset === 'auto' || paneCount === 1) return calculateLayout(paneCount, 0, 0);

  const layouts: PaneLayout[] = [];

  if (preset === 'single') {
    // Stack all to full; UI may zoom the active one
    for (let i = 0; i < paneCount; i++)
      layouts.push({ paneId: String(i), x: 0, y: 0, width: 100, height: 100 });
    return layouts;
  }

  if (preset === 'columns') {
    const w = 100 / paneCount;
    for (let i = 0; i < paneCount; i++)
      layouts.push({ paneId: String(i), x: i * w, y: 0, width: w, height: 100 });
    return layouts;
  }

  if (preset === 'rows') {
    const h = 100 / paneCount;
    for (let i = 0; i < paneCount; i++)
      layouts.push({ paneId: String(i), x: 0, y: i * h, width: 100, height: h });
    return layouts;
  }

  if (preset === 'grid') {
    const cols = Math.ceil(Math.sqrt(paneCount));
    const rows = Math.ceil(paneCount / cols);
    const cw = 100 / cols;
    const rh = 100 / rows;
    for (let i = 0; i < paneCount; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      layouts.push({ paneId: String(i), x: c * cw, y: r * rh, width: cw, height: rh });
    }
    return layouts;
  }

  if (preset === 'main-left' || preset === 'main-right') {
    if (paneCount === 1)
      return [{ paneId: '0', x: 0, y: 0, width: 100, height: 100 }];
    const sideCount = paneCount - 1;
    const sideH = 100 / sideCount;
    const mainOnLeft = preset === 'main-left';
    layouts.push({
      paneId: '0',
      x: mainOnLeft ? 0 : 50,
      y: 0,
      width: 50,
      height: 100,
    });
    for (let i = 0; i < sideCount; i++) {
      layouts.push({
        paneId: String(i + 1),
        x: mainOnLeft ? 50 : 0,
        y: i * sideH,
        width: 50,
        height: sideH,
      });
    }
    return layouts;
  }

  return calculateLayout(paneCount, 0, 0);
}


/**
 * Calculate auto-tiling layout for N panes.
 * Returns percentage-based positions for equal distribution.
 *
 * Strategy:
 * - 1: full screen
 * - 2: side-by-side (2 cols)
 * - 3: 1 left + 2 stacked right
 * - 4+: grid with cols = ceil(sqrt(n)), rows to fill
 */
export function calculateLayout(
  paneCount: number,
  _containerWidth: number,
  _containerHeight: number,
): PaneLayout[] {
  if (paneCount === 0) return [];

  if (paneCount === 1) {
    return [{ paneId: '0', x: 0, y: 0, width: 100, height: 100 }];
  }

  if (paneCount === 2) {
    return [
      { paneId: '0', x: 0, y: 0, width: 50, height: 100 },
      { paneId: '1', x: 50, y: 0, width: 50, height: 100 },
    ];
  }

  if (paneCount === 3) {
    return [
      { paneId: '0', x: 0, y: 0, width: 50, height: 100 },
      { paneId: '1', x: 50, y: 0, width: 50, height: 50 },
      { paneId: '2', x: 50, y: 50, width: 50, height: 50 },
    ];
  }

  // General grid layout for 4+
  const cols = Math.ceil(Math.sqrt(paneCount));
  const rows = Math.ceil(paneCount / cols);
  const layouts: PaneLayout[] = [];
  let idx = 0;

  for (let row = 0; row < rows; row++) {
    // How many panes in this row?
    const remaining = paneCount - idx;
    const rowsLeft = rows - row;
    const panesInRow = Math.ceil(remaining / rowsLeft);
    const colWidth = 100 / panesInRow;
    const rowHeight = 100 / rows;

    for (let col = 0; col < panesInRow; col++) {
      layouts.push({
        paneId: String(idx),
        x: col * colWidth,
        y: row * rowHeight,
        width: colWidth,
        height: rowHeight,
      });
      idx++;
    }
  }

  return layouts;
}
