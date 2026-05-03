import { describe, it, expect } from 'vitest';
import { createTabStore } from '../stores/tab-store';

describe('Tab Store', () => {
  it('creates a tab with a pane', () => {
    const store = createTabStore();
    const tabId = store.createTab('pane-1');
    const tab = store.getTab(tabId);
    expect(tab).toBeDefined();
    expect(tab!.paneIds).toContain('pane-1');
  });

  it('adds a pane to a tab', () => {
    const store = createTabStore();
    const tabId = store.createTab('pane-1');
    store.addPane(tabId, 'pane-2');
    expect(store.getTab(tabId)!.paneIds).toEqual(['pane-1', 'pane-2']);
  });

  it('removes a pane from a tab', () => {
    const store = createTabStore();
    const tabId = store.createTab('pane-1');
    store.addPane(tabId, 'pane-2');
    store.removePane(tabId, 'pane-1');
    expect(store.getTab(tabId)!.paneIds).toEqual(['pane-2']);
  });

  it('closes a tab and removes all panes', () => {
    const store = createTabStore();
    const tabId = store.createTab('pane-1');
    store.addPane(tabId, 'pane-2');
    store.closeTab(tabId);
    expect(store.getTab(tabId)).toBeUndefined();
    expect(store.getTabs()).toHaveLength(0);
  });

  it('reorders tabs', () => {
    const store = createTabStore();
    const t1 = store.createTab('p1');
    const t2 = store.createTab('p2');
    const t3 = store.createTab('p3');
    store.reorderTabs([t3, t1, t2]);
    expect(store.getTabs().map(t => t.id)).toEqual([t3, t1, t2]);
  });

  it('renames a tab', () => {
    const store = createTabStore();
    const tabId = store.createTab('p1');
    store.renameTab(tabId, 'My Tab');
    expect(store.getTab(tabId)!.name).toBe('My Tab');
  });

  it('merges tabs', () => {
    const store = createTabStore();
    const t1 = store.createTab('p1');
    store.addPane(t1, 'p2');
    const t2 = store.createTab('p3');
    store.mergeTabs(t1, t2); // merge t2 into t1
    expect(store.getTab(t1)!.paneIds).toEqual(['p1', 'p2', 'p3']);
    expect(store.getTab(t2)).toBeUndefined();
  });

  it('breaks out a pane into a new tab', () => {
    const store = createTabStore();
    const t1 = store.createTab('p1');
    store.addPane(t1, 'p2');
    store.addPane(t1, 'p3');
    const newTabId = store.breakOutPane(t1, 'p2');
    expect(store.getTab(t1)!.paneIds).toEqual(['p1', 'p3']);
    expect(store.getTab(newTabId)!.paneIds).toEqual(['p2']);
  });

  it('tracks active tab', () => {
    const store = createTabStore();
    const t1 = store.createTab('p1');
    const t2 = store.createTab('p2');
    expect(store.getActiveTabId()).toBe(t2); // latest created is active
    store.setActiveTab(t1);
    expect(store.getActiveTabId()).toBe(t1);
  });
});
