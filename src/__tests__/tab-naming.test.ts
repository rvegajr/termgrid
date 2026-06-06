import { describe, it, expect } from 'vitest';
import { deriveAutoTabName, type PaneMeta } from '../services/tab-naming';

describe('tab-naming', () => {
  describe('deriveAutoTabName', () => {
    it('returns cwd basename when available', () => {
      const meta: PaneMeta = {
        cwd: '/Users/admin/projects/termgrid',
        shell: '/bin/zsh',
      };
      
      const result = deriveAutoTabName(meta, 'Tab 1', 1);
      expect(result).toBe('termgrid');
    });

    it('falls back to shell name if cwd is unavailable', () => {
      const meta: PaneMeta = {
        shell: '/bin/zsh',
      };
      
      const result = deriveAutoTabName(meta, 'Tab 2', 2);
      expect(result).toBe('zsh');
    });

    it('returns null if user renamed the tab', () => {
      const meta: PaneMeta = {
        cwd: '/Users/admin/projects/termgrid',
      };
      
      const result = deriveAutoTabName(meta, 'My Custom Tab', 1);
      expect(result).toBeNull();
    });

    it('returns null if no meta is available', () => {
      const result = deriveAutoTabName(null, 'Tab 1', 1);
      expect(result).toBeNull();
    });

    it('returns null if cwd is just home (~)', () => {
      const meta: PaneMeta = {
        cwd: '~',
      };
      
      const result = deriveAutoTabName(meta, 'Tab 1', 1);
      expect(result).toBeNull();
    });

    it('handles cwd with trailing slash', () => {
      const meta: PaneMeta = {
        cwd: '/Users/admin/projects/termgrid/',
      };
      
      const result = deriveAutoTabName(meta, 'Tab 1', 1);
      expect(result).toBe('termgrid');
    });

    it('handles root directory', () => {
      const meta: PaneMeta = {
        cwd: '/',
        shell: '/bin/sh',
      };
      
      // Root has no basename, falls back to shell
      const result = deriveAutoTabName(meta, 'Tab 1', 1);
      expect(result).toBe('sh');
    });

    it('respects tab number in default name check', () => {
      const meta: PaneMeta = {
        cwd: '/Users/admin/projects/termgrid',
      };
      
      // Tab 2 should match "Tab 2", not "Tab 1"
      const result = deriveAutoTabName(meta, 'Tab 2', 2);
      expect(result).toBe('termgrid');
    });
  });
});
