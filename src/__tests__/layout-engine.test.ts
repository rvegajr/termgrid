import { describe, it, expect } from 'vitest';
import { calculateLayout } from '../services/layout-engine';

describe('Layout Engine', () => {
  const W = 1200;
  const H = 800;

  it('returns empty array for 0 panes', () => {
    const layout = calculateLayout(0, W, H);
    expect(layout).toEqual([]);
  });

  it('1 pane fills entire container', () => {
    const layout = calculateLayout(1, W, H);
    expect(layout).toHaveLength(1);
    expect(layout[0]).toEqual({ paneId: '0', x: 0, y: 0, width: 100, height: 100 });
  });

  it('2 panes split side-by-side', () => {
    const layout = calculateLayout(2, W, H);
    expect(layout).toHaveLength(2);
    expect(layout[0]).toEqual({ paneId: '0', x: 0, y: 0, width: 50, height: 100 });
    expect(layout[1]).toEqual({ paneId: '1', x: 50, y: 0, width: 50, height: 100 });
  });

  it('3 panes: one left, two stacked right', () => {
    const layout = calculateLayout(3, W, H);
    expect(layout).toHaveLength(3);
    // Left pane takes 50% width, full height
    expect(layout[0]).toEqual({ paneId: '0', x: 0, y: 0, width: 50, height: 100 });
    // Right top
    expect(layout[1]).toEqual({ paneId: '1', x: 50, y: 0, width: 50, height: 50 });
    // Right bottom
    expect(layout[2]).toEqual({ paneId: '2', x: 50, y: 50, width: 50, height: 50 });
  });

  it('4 panes form a 2x2 grid', () => {
    const layout = calculateLayout(4, W, H);
    expect(layout).toHaveLength(4);
    expect(layout[0]).toEqual({ paneId: '0', x: 0, y: 0, width: 50, height: 50 });
    expect(layout[1]).toEqual({ paneId: '1', x: 50, y: 0, width: 50, height: 50 });
    expect(layout[2]).toEqual({ paneId: '2', x: 0, y: 50, width: 50, height: 50 });
    expect(layout[3]).toEqual({ paneId: '3', x: 50, y: 50, width: 50, height: 50 });
  });

  it('5 panes: 3 top, 2 bottom', () => {
    const layout = calculateLayout(5, W, H);
    expect(layout).toHaveLength(5);
    // Top row: 3 panes
    const topWidth = 100 / 3;
    expect(layout[0].y).toBe(0);
    expect(layout[1].y).toBe(0);
    expect(layout[2].y).toBe(0);
    expect(layout[0].width).toBeCloseTo(topWidth);
    expect(layout[0].height).toBe(50);
    // Bottom row: 2 panes
    expect(layout[3].y).toBe(50);
    expect(layout[4].y).toBe(50);
    expect(layout[3].width).toBe(50);
  });

  it('6 panes form a 3x2 grid', () => {
    const layout = calculateLayout(6, W, H);
    expect(layout).toHaveLength(6);
    const colWidth = 100 / 3;
    // Top row
    expect(layout[0]).toEqual({ paneId: '0', x: 0, y: 0, width: colWidth, height: 50 });
    expect(layout[1].x).toBeCloseTo(colWidth, 5);
    expect(layout[2].x).toBeCloseTo(colWidth * 2, 5);
    // Bottom row
    expect(layout[3].y).toBe(50);
    expect(layout[4].y).toBe(50);
    expect(layout[5].y).toBe(50);
  });

  it('all panes cover 100% of the area without overlap', () => {
    for (let count = 1; count <= 9; count++) {
      const layout = calculateLayout(count, W, H);
      // Total area should be ~100%
      const totalArea = layout.reduce((sum, p) => sum + (p.width * p.height) / 100, 0);
      expect(totalArea).toBeCloseTo(100, 0);
    }
  });

  it('no pane has zero dimensions', () => {
    for (let count = 1; count <= 9; count++) {
      const layout = calculateLayout(count, W, H);
      for (const pane of layout) {
        expect(pane.width).toBeGreaterThan(0);
        expect(pane.height).toBeGreaterThan(0);
      }
    }
  });
});
