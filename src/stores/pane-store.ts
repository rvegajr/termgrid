export interface PaneInfo {
  id: string;
  shellType: string;
  cwd: string;
}

export interface PaneStore {
  addPane(info: PaneInfo): void;
  removePane(paneId: string): void;
  getPane(paneId: string): PaneInfo | undefined;
  getAllPanes(): PaneInfo[];
  setActivePane(paneId: string): void;
  getActivePaneId(): string | null;
  zoomPane(paneId: string): void;
  unzoom(): void;
  isZoomed(): boolean;
  getZoomedPaneId(): string | null;
  getVisiblePaneIds(): string[];
}

export function createPaneStore(): PaneStore {
  let panes: Map<string, PaneInfo> = new Map();
  let activePaneId: string | null = null;
  let zoomedPaneId: string | null = null;

  return {
    addPane(info: PaneInfo): void {
      panes.set(info.id, info);
      activePaneId = info.id;
    },

    removePane(paneId: string): void {
      panes.delete(paneId);
      if (activePaneId === paneId) {
        const ids = [...panes.keys()];
        activePaneId = ids.length > 0 ? ids[ids.length - 1] : null;
      }
      if (zoomedPaneId === paneId) zoomedPaneId = null;
    },

    getPane(paneId: string): PaneInfo | undefined {
      return panes.get(paneId);
    },

    getAllPanes(): PaneInfo[] {
      return [...panes.values()];
    },

    setActivePane(paneId: string): void {
      if (panes.has(paneId)) activePaneId = paneId;
    },

    getActivePaneId(): string | null {
      return activePaneId;
    },

    zoomPane(paneId: string): void {
      if (panes.has(paneId)) zoomedPaneId = paneId;
    },

    unzoom(): void {
      zoomedPaneId = null;
    },

    isZoomed(): boolean {
      return zoomedPaneId !== null;
    },

    getZoomedPaneId(): string | null {
      return zoomedPaneId;
    },

    getVisiblePaneIds(): string[] {
      if (zoomedPaneId) return [zoomedPaneId];
      return [...panes.keys()];
    },
  };
}
