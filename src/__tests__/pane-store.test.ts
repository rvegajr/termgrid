import { describe, it, expect } from 'vitest';
import { createPaneStore } from '../stores/pane-store';

describe('Pane Store', () => {
  it('creates a pane and adds to store', () => {
    const store = createPaneStore();
    store.addPane({ id: 'p1', shellType: 'bash', cwd: '/home' });
    expect(store.getPane('p1')).toBeDefined();
    expect(store.getAllPanes()).toHaveLength(1);
  });

  it('closes a pane and removes from store', () => {
    const store = createPaneStore();
    store.addPane({ id: 'p1', shellType: 'bash', cwd: '/home' });
    store.removePane('p1');
    expect(store.getPane('p1')).toBeUndefined();
    expect(store.getAllPanes()).toHaveLength(0);
  });

  it('tracks active pane', () => {
    const store = createPaneStore();
    store.addPane({ id: 'p1', shellType: 'bash', cwd: '/home' });
    store.addPane({ id: 'p2', shellType: 'zsh', cwd: '/home' });
    store.setActivePane('p1');
    expect(store.getActivePaneId()).toBe('p1');
    store.setActivePane('p2');
    expect(store.getActivePaneId()).toBe('p2');
  });

  it('zoom pane hides others', () => {
    const store = createPaneStore();
    store.addPane({ id: 'p1', shellType: 'bash', cwd: '/home' });
    store.addPane({ id: 'p2', shellType: 'zsh', cwd: '/home' });
    store.addPane({ id: 'p3', shellType: 'fish', cwd: '/home' });

    store.zoomPane('p2');
    expect(store.isZoomed()).toBe(true);
    expect(store.getZoomedPaneId()).toBe('p2');
    expect(store.getVisiblePaneIds()).toEqual(['p2']);
  });

  it('unzoom restores all panes', () => {
    const store = createPaneStore();
    store.addPane({ id: 'p1', shellType: 'bash', cwd: '/home' });
    store.addPane({ id: 'p2', shellType: 'zsh', cwd: '/home' });

    store.zoomPane('p1');
    expect(store.getVisiblePaneIds()).toEqual(['p1']);

    store.unzoom();
    expect(store.isZoomed()).toBe(false);
    expect(store.getVisiblePaneIds()).toHaveLength(2);
  });
});
