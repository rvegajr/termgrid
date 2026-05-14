/**
 * Tests for `services/adoption.ts`.
 *
 * Scope: the transport wrappers and the `formatAge` helper. The Rust
 * backend is exercised by its own unit tests; here we only verify that we
 * hit the right Tauri command names with the right arg shapes, and that
 * `formatAge` produces sane picker copy.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

beforeEach(() => {
  invokeMock.mockReset();
});

describe("adoption service", () => {
  it("listAdoptableSessions invokes the discover command and forwards rows", async () => {
    const row = {
      pid: 4421,
      shell: "zsh",
      cwd: "/Users/me/src",
      tty: "/dev/ttys003",
      parent: "Terminal",
      last_command: "git status",
      started_at: 1700000000,
      via_ssh: false,
    };
    invokeMock.mockResolvedValueOnce([row]);

    const { listAdoptableSessions } = await import("../services/adoption");
    const out = await listAdoptableSessions();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("list_adoptable_sessions_cmd");
    expect(out).toEqual([row]);
  });

  it("snapshotSession forwards the pid argument under the expected key", async () => {
    const snap = {
      pid: 4421,
      shell: "zsh",
      cwd: "/Users/me/src",
      tty: "/dev/ttys003",
      recent_history: ["ls", "git status"],
      banner: "adopted from /dev/ttys003 (zsh, pid 4421)",
      buffer_preview: "user@host:~/src$ ls\nfile.txt\n",
      env_vars: [{ name: "VIRTUAL_ENV", value: "/Users/me/.venv" }],
      ssh_target: null,
    };
    invokeMock.mockResolvedValueOnce(snap);

    const { snapshotSession } = await import("../services/adoption");
    const out = await snapshotSession(4421);

    expect(invokeMock).toHaveBeenCalledWith("snapshot_session_cmd", { pid: 4421 });
    expect(out).toEqual(snap);
  });

  it("listAdoptableSessions surfaces backend rejections to the caller", async () => {
    invokeMock.mockRejectedValueOnce(new Error("denied"));
    const { listAdoptableSessions } = await import("../services/adoption");
    await expect(listAdoptableSessions()).rejects.toThrow("denied");
  });

  describe("formatAge", () => {
    it("renders 'just now' for sub-30s ages", async () => {
      const { formatAge } = await import("../services/adoption");
      expect(formatAge(1_000_000, 1_000_010)).toBe("just now");
      expect(formatAge(1_000_000, 1_000_000)).toBe("just now");
    });

    it("renders seconds, minutes, hours, and days as the gap grows", async () => {
      const { formatAge } = await import("../services/adoption");
      const t0 = 1_000_000;
      expect(formatAge(t0, t0 + 45)).toBe("45s");
      expect(formatAge(t0, t0 + 60 * 5)).toBe("5m");
      expect(formatAge(t0, t0 + 60 * 60 * 3)).toBe("3h");
      expect(formatAge(t0, t0 + 60 * 60 * 24 * 7)).toBe("7d");
    });

    it("clamps very old ages to '30d+'", async () => {
      const { formatAge } = await import("../services/adoption");
      const t0 = 1_000_000;
      expect(formatAge(t0, t0 + 60 * 60 * 24 * 90)).toBe("30d+");
    });

    it("treats future timestamps (clock skew) as 'just now'", async () => {
      const { formatAge } = await import("../services/adoption");
      expect(formatAge(2_000_000, 1_000_000)).toBe("just now");
    });
  });

  describe("isLikelySystemShell", () => {
    it("flags shells with no tty, no parent, root cwd", async () => {
      const { isLikelySystemShell } = await import("../services/adoption");
      const s = {
        pid: 1,
        shell: "bash",
        cwd: "/",
        tty: null,
        parent: null,
        last_command: null,
        started_at: 0,
        via_ssh: false,
      };
      expect(isLikelySystemShell(s)).toBe(true);
    });

    it("does not flag shells with an active tty", async () => {
      const { isLikelySystemShell } = await import("../services/adoption");
      const s = {
        pid: 1,
        shell: "bash",
        cwd: "/",
        tty: "/dev/ttys003",
        parent: null,
        last_command: null,
        started_at: 0,
        via_ssh: false,
      };
      expect(isLikelySystemShell(s)).toBe(false);
    });

    it("does not flag shells with a recognized terminal host", async () => {
      const { isLikelySystemShell } = await import("../services/adoption");
      const s = {
        pid: 1,
        shell: "zsh",
        cwd: "/",
        tty: null,
        parent: "Terminal",
        last_command: null,
        started_at: 0,
        via_ssh: false,
      };
      expect(isLikelySystemShell(s)).toBe(false);
    });

    it("does not flag shells with a user-meaningful cwd", async () => {
      const { isLikelySystemShell } = await import("../services/adoption");
      const s = {
        pid: 1,
        shell: "zsh",
        cwd: "/Users/me/src",
        tty: null,
        parent: null,
        last_command: null,
        started_at: 0,
        via_ssh: false,
      };
      expect(isLikelySystemShell(s)).toBe(false);
    });
  });

  describe("renderSshReconnect", () => {
    it("emits the minimal form when no port or command", async () => {
      const { renderSshReconnect } = await import("../services/adoption");
      expect(
        renderSshReconnect({
          destination: "me@host",
          port: null,
          command: null,
          argv: [],
        }),
      ).toBe("ssh me@host");
    });

    it("emits port and trailing command in argv order", async () => {
      const { renderSshReconnect } = await import("../services/adoption");
      expect(
        renderSshReconnect({
          destination: "me@host",
          port: 2222,
          command: "htop -d 5",
          argv: [],
        }),
      ).toBe("ssh -p 2222 me@host htop -d 5");
    });
  });

  describe("renderSshReconnect SendEnv (v3)", () => {
    it("emits -o SendEnv= flags before the destination", async () => {
      const { renderSshReconnect } = await import("../services/adoption");
      const out = renderSshReconnect(
        { destination: "me@host", port: null, command: null, argv: [] },
        ["VIRTUAL_ENV", "AWS_PROFILE"],
      );
      expect(out).toBe("ssh -o SendEnv=VIRTUAL_ENV -o SendEnv=AWS_PROFILE me@host");
    });

    it("filters invalid env names defensively (mirrors Rust)", async () => {
      const { renderSshReconnect } = await import("../services/adoption");
      const out = renderSshReconnect(
        { destination: "me@host", port: null, command: null, argv: [] },
        ["1BAD", "OK", "WITH-DASH", "$(boom)", "GOOD_NAME"],
      );
      expect(out).toBe("ssh -o SendEnv=OK -o SendEnv=GOOD_NAME me@host");
    });

    it("caps the SendEnv list at 16", async () => {
      const { renderSshReconnect } = await import("../services/adoption");
      const names = Array.from({ length: 30 }, (_, i) => `V_${i}`);
      const out = renderSshReconnect(
        { destination: "me@host", port: null, command: null, argv: [] },
        names,
      );
      expect((out.match(/SendEnv=/g) ?? []).length).toBe(16);
    });

    it("respects port and command alongside SendEnv flags", async () => {
      const { renderSshReconnect } = await import("../services/adoption");
      const out = renderSshReconnect(
        { destination: "me@host", port: 2222, command: "htop", argv: [] },
        ["FOO"],
      );
      expect(out).toBe("ssh -o SendEnv=FOO -p 2222 me@host htop");
    });
  });

  describe("diffStaleRows (v3)", () => {
    const makeRow = (pid: number, started: number) => ({
      pid,
      shell: "zsh",
      cwd: null,
      tty: null,
      parent: null,
      last_command: null,
      started_at: started,
      via_ssh: false,
    });

    it("returns PIDs that vanished between polls", async () => {
      const { diffStaleRows } = await import("../services/adoption");
      const prev = [makeRow(1, 100), makeRow(2, 200), makeRow(3, 300)];
      const next = [makeRow(1, 100), makeRow(3, 300)];
      expect(diffStaleRows(prev, next)).toEqual([2]);
    });

    it("treats PID reuse with a new start time as 'vanished'", async () => {
      const { diffStaleRows } = await import("../services/adoption");
      const prev = [makeRow(1, 100)];
      // Same pid but different started_at → the old process is gone,
      // even though a new one happens to share the PID.
      const next = [makeRow(1, 999)];
      expect(diffStaleRows(prev, next)).toEqual([1]);
    });

    it("returns empty when the two lists match", async () => {
      const { diffStaleRows } = await import("../services/adoption");
      const prev = [makeRow(1, 100), makeRow(2, 200)];
      const next = [makeRow(2, 200), makeRow(1, 100)];
      expect(diffStaleRows(prev, next)).toEqual([]);
    });
  });

  describe("snapshot cache (v3)", () => {
    const sample = {
      pid: 9999,
      shell: "zsh",
      cwd: null,
      tty: null,
      recent_history: [],
      banner: "test",
      buffer_preview: null,
      env_vars: [],
      ssh_target: null,
    };

    it("returns null for unknown PID and stores writes", async () => {
      const adoption = await import("../services/adoption");
      adoption.clearSnapshotCache();
      expect(adoption.getCachedSnapshot(sample.pid)).toBeNull();
      adoption.rememberSnapshot(sample.pid, sample);
      expect(adoption.getCachedSnapshot(sample.pid)).toEqual(sample);
    });

    it("evicts entries older than MAX_AGE_MS on next read", async () => {
      vi.useFakeTimers();
      try {
        const adoption = await import("../services/adoption");
        adoption.clearSnapshotCache();
        adoption.rememberSnapshot(sample.pid, sample);
        vi.advanceTimersByTime(31_000);
        expect(adoption.getCachedSnapshot(sample.pid)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("snapshotSessionCached returns cached value without invoking", async () => {
      const adoption = await import("../services/adoption");
      adoption.clearSnapshotCache();
      adoption.rememberSnapshot(sample.pid, sample);
      invokeMock.mockClear();
      const out = await adoption.snapshotSessionCached(sample.pid);
      expect(invokeMock).not.toHaveBeenCalled();
      expect(out).toEqual(sample);
    });

    it("snapshotSessionCached falls through to invoke on miss", async () => {
      const adoption = await import("../services/adoption");
      adoption.clearSnapshotCache();
      invokeMock.mockResolvedValueOnce(sample);
      const out = await adoption.snapshotSessionCached(sample.pid);
      expect(invokeMock).toHaveBeenCalledWith("snapshot_session_cmd", {
        pid: sample.pid,
      });
      expect(out).toEqual(sample);
    });
  });

  describe("describeSshTarget", () => {
    it("returns null for null target", async () => {
      const { describeSshTarget } = await import("../services/adoption");
      expect(describeSshTarget(null)).toBeNull();
    });

    it("returns just the destination when no port", async () => {
      const { describeSshTarget } = await import("../services/adoption");
      expect(
        describeSshTarget({
          destination: "me@host",
          port: null,
          command: null,
          argv: [],
        }),
      ).toBe("me@host");
    });

    it("appends :port when port is present", async () => {
      const { describeSshTarget } = await import("../services/adoption");
      expect(
        describeSshTarget({
          destination: "me@host",
          port: 2222,
          command: null,
          argv: [],
        }),
      ).toBe("me@host:2222");
    });
  });
});
