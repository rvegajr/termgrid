export interface TabIdentifiable {
  readonly id: string;
  name: string;
  color?: string;
}

export interface TabPaneManager {
  addPane(paneId: string): void;
  removePane(paneId: string): void;
  getPaneIds(): string[];
  activePaneId: string | null;
}

export interface TabReorderable {
  moveBefore(targetTabId: string): void;
  moveAfter(targetTabId: string): void;
}

export interface TabMergeable {
  mergeFrom(sourceTabId: string): void;
  breakOutPane(paneId: string): string; // returns new tab id
}
