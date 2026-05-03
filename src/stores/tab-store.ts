export interface Tab {
  id: string;
  name: string;
  color?: string;
  paneIds: string[];
}

export interface TabStore {
  createTab(initialPaneId: string, name?: string): string;
  getTab(tabId: string): Tab | undefined;
  getTabs(): Tab[];
  closeTab(tabId: string): void;
  addPane(tabId: string, paneId: string): void;
  removePane(tabId: string, paneId: string): void;
  reorderTabs(tabIds: string[]): void;
  renameTab(tabId: string, name: string): void;
  mergeTabs(targetTabId: string, sourceTabId: string): void;
  breakOutPane(tabId: string, paneId: string): string;
  getActiveTabId(): string | null;
  setActiveTab(tabId: string): void;
}

let nextId = 0;

export function createTabStore(): TabStore {
  let tabs: Tab[] = [];
  let activeTabId: string | null = null;

  return {
    createTab(initialPaneId: string, name?: string): string {
      const id = `tab-${nextId++}`;
      const tab: Tab = {
        id,
        name: name ?? `Tab ${tabs.length + 1}`,
        paneIds: [initialPaneId],
      };
      tabs.push(tab);
      activeTabId = id;
      return id;
    },

    getTab(tabId: string): Tab | undefined {
      return tabs.find(t => t.id === tabId);
    },

    getTabs(): Tab[] {
      return [...tabs];
    },

    closeTab(tabId: string): void {
      tabs = tabs.filter(t => t.id !== tabId);
      if (activeTabId === tabId) {
        activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
      }
    },

    addPane(tabId: string, paneId: string): void {
      const tab = tabs.find(t => t.id === tabId);
      if (tab) tab.paneIds.push(paneId);
    },

    removePane(tabId: string, paneId: string): void {
      const tab = tabs.find(t => t.id === tabId);
      if (tab) tab.paneIds = tab.paneIds.filter(id => id !== paneId);
    },

    reorderTabs(tabIds: string[]): void {
      const tabMap = new Map(tabs.map(t => [t.id, t]));
      tabs = tabIds.map(id => tabMap.get(id)!).filter(Boolean);
    },

    renameTab(tabId: string, name: string): void {
      const tab = tabs.find(t => t.id === tabId);
      if (tab) tab.name = name;
    },

    mergeTabs(targetTabId: string, sourceTabId: string): void {
      const target = tabs.find(t => t.id === targetTabId);
      const source = tabs.find(t => t.id === sourceTabId);
      if (target && source) {
        target.paneIds.push(...source.paneIds);
        tabs = tabs.filter(t => t.id !== sourceTabId);
        if (activeTabId === sourceTabId) activeTabId = targetTabId;
      }
    },

    breakOutPane(tabId: string, paneId: string): string {
      const tab = tabs.find(t => t.id === tabId);
      if (tab) {
        tab.paneIds = tab.paneIds.filter(id => id !== paneId);
      }
      return this.createTab(paneId);
    },

    getActiveTabId(): string | null {
      return activeTabId;
    },

    setActiveTab(tabId: string): void {
      if (tabs.find(t => t.id === tabId)) {
        activeTabId = tabId;
      }
    },
  };
}
