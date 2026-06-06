import { describe, it, expect } from 'vitest';
import { markPaneExited, isPaneExited } from '../services/pane-exit';

describe('pane-exit', () => {
  describe('markPaneExited', () => {
    it('adds a pane id to the exited set', () => {
      const initial = new Set<string>();
      const result = markPaneExited(initial, 'pane-1');
      
      expect(result.has('pane-1')).toBe(true);
      expect(result.size).toBe(1);
    });

    it('returns a new Set instance (immutable)', () => {
      const initial = new Set<string>();
      const result = markPaneExited(initial, 'pane-1');
      
      expect(result).not.toBe(initial);
      expect(initial.size).toBe(0);
    });

    it('is idempotent - adding same id twice', () => {
      const initial = new Set<string>();
      const first = markPaneExited(initial, 'pane-1');
      const second = markPaneExited(first, 'pane-1');
      
      expect(second.size).toBe(1);
      expect(second.has('pane-1')).toBe(true);
    });

    it('preserves existing ids when adding new ones', () => {
      const initial = new Set(['pane-1', 'pane-2']);
      const result = markPaneExited(initial, 'pane-3');
      
      expect(result.size).toBe(3);
      expect(result.has('pane-1')).toBe(true);
      expect(result.has('pane-2')).toBe(true);
      expect(result.has('pane-3')).toBe(true);
    });
  });

  describe('isPaneExited', () => {
    it('returns true for exited panes', () => {
      const set = new Set(['pane-1', 'pane-2']);
      expect(isPaneExited(set, 'pane-1')).toBe(true);
    });

    it('returns false for non-exited panes', () => {
      const set = new Set(['pane-1']);
      expect(isPaneExited(set, 'pane-2')).toBe(false);
    });

    it('returns false for empty set', () => {
      const set = new Set<string>();
      expect(isPaneExited(set, 'pane-1')).toBe(false);
    });
  });
});
