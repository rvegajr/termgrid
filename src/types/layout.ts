export interface PaneLayout {
  paneId: string;
  x: number;      // percentage 0-100
  y: number;      // percentage 0-100
  width: number;  // percentage 0-100
  height: number; // percentage 0-100
}

export interface LayoutCalculator {
  calculate(paneCount: number, containerWidth: number, containerHeight: number): PaneLayout[];
}

export interface LayoutPersister {
  save(name: string, layout: PaneLayout[]): void;
  load(name: string): PaneLayout[] | null;
  list(): string[];
  delete(name: string): void;
}
