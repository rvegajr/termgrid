import { describe, it, expect, beforeEach } from 'vitest';
import { defaultShell, setDefaultShell } from '../services/default-shell';

const KEY = 'termgrid.defaultShell';

describe('Default Shell', () => {
  beforeEach(() => {
    localStorage.clear();
    setDefaultShell(null);
  });

  it('defaults to null when nothing is set', () => {
    expect(defaultShell()).toBeNull();
  });

  it('stores the chosen shell path and persists it', () => {
    setDefaultShell('/usr/bin/zsh');
    expect(defaultShell()).toBe('/usr/bin/zsh');
    expect(localStorage.getItem(KEY)).toBe('/usr/bin/zsh');
  });

  it('clears the default and removes it from storage', () => {
    setDefaultShell('/usr/bin/zsh');
    setDefaultShell(null);
    expect(defaultShell()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
