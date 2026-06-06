import { describe, it, expect, vi, beforeEach } from 'vitest';
import { disposePaneResources, type DisposablePaneState, type DisposeDeps } from '../services/pane-lifecycle';

// Mock the IPC module
vi.mock('../services/tauri-ipc', () => ({
  closePane: vi.fn().mockResolvedValue(undefined),
}));

// Mock the service modules (they import IPC internally)
vi.mock('../services/pane-meta', () => ({
  detachMeta: vi.fn(),
}));
vi.mock('../services/pane-host', () => ({
  forgetPaneHost: vi.fn(),
}));
vi.mock('../services/history', () => ({
  detachRecorder: vi.fn(),
}));
vi.mock('../services/pane-snapshot', () => ({
  forgetPaneId: vi.fn(),
}));

describe('pane-lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('disposePaneResources', () => {
    it('disconnects the resize observer', async () => {
      const disconnectSpy = vi.fn();
      const pane: DisposablePaneState = {
        backendId: 'backend-1',
        stableId: 'stable-1',
        terminal: { dispose: vi.fn() } as any,
        snapshot: { destroy: vi.fn().mockResolvedValue(undefined) } as any,
        resizeObserver: { disconnect: disconnectSpy } as any,
      };
      
      const deps: DisposeDeps = {
        paneEls: new Map(),
        closedStableIds: new Set(),
      };
      
      await disposePaneResources(pane, deps);
      
      expect(disconnectSpy).toHaveBeenCalledOnce();
    });

    it('disposes the terminal', async () => {
      const disposeSpy = vi.fn();
      const pane: DisposablePaneState = {
        backendId: 'backend-1',
        stableId: 'stable-1',
        terminal: { dispose: disposeSpy } as any,
        snapshot: { destroy: vi.fn().mockResolvedValue(undefined) } as any,
      };
      
      const deps: DisposeDeps = {
        paneEls: new Map(),
        closedStableIds: new Set(),
      };
      
      await disposePaneResources(pane, deps);
      
      expect(disposeSpy).toHaveBeenCalledOnce();
    });

    it('destroys the snapshot with deleteFromDisk=true', async () => {
      const destroySpy = vi.fn().mockResolvedValue(undefined);
      const pane: DisposablePaneState = {
        backendId: 'backend-1',
        stableId: 'stable-1',
        terminal: { dispose: vi.fn() } as any,
        snapshot: { destroy: destroySpy } as any,
      };
      
      const deps: DisposeDeps = {
        paneEls: new Map(),
        closedStableIds: new Set(),
      };
      
      await disposePaneResources(pane, deps);
      
      expect(destroySpy).toHaveBeenCalledWith(true);
    });

    it('marks the stable ID as closed', async () => {
      const pane: DisposablePaneState = {
        backendId: 'backend-1',
        stableId: 'stable-1',
        terminal: { dispose: vi.fn() } as any,
        snapshot: { destroy: vi.fn().mockResolvedValue(undefined) } as any,
      };
      
      const deps: DisposeDeps = {
        paneEls: new Map(),
        closedStableIds: new Set(),
      };
      
      await disposePaneResources(pane, deps);
      
      expect(deps.closedStableIds.has('stable-1')).toBe(true);
    });

    it('removes the pane from paneEls map', async () => {
      const pane: DisposablePaneState = {
        backendId: 'backend-1',
        stableId: 'stable-1',
        terminal: { dispose: vi.fn() } as any,
        snapshot: { destroy: vi.fn().mockResolvedValue(undefined) } as any,
      };
      
      const mockEl = document.createElement('div');
      const deps: DisposeDeps = {
        paneEls: new Map([['backend-1', mockEl]]),
        closedStableIds: new Set(),
      };
      
      expect(deps.paneEls.has('backend-1')).toBe(true);
      
      await disposePaneResources(pane, deps);
      
      expect(deps.paneEls.has('backend-1')).toBe(false);
    });

    it('handles missing resizeObserver gracefully', async () => {
      const pane: DisposablePaneState = {
        backendId: 'backend-1',
        stableId: 'stable-1',
        terminal: { dispose: vi.fn() } as any,
        snapshot: { destroy: vi.fn().mockResolvedValue(undefined) } as any,
        // No resizeObserver
      };
      
      const deps: DisposeDeps = {
        paneEls: new Map(),
        closedStableIds: new Set(),
      };
      
      // Should not throw
      await expect(disposePaneResources(pane, deps)).resolves.toBeUndefined();
    });
  });
});
