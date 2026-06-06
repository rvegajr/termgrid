import { describe, it, expect } from "vitest";
import { normalizeDirPath, findPaneIdByCwd, type PaneCwdEntry } from "../services/dir-match";

describe("dir-match", () => {
  describe("normalizeDirPath", () => {
    it("collapses /Users/x to ~", () => {
      expect(normalizeDirPath("/Users/alice/projects")).toBe("~/projects");
      expect(normalizeDirPath("/Users/bob")).toBe("~");
    });

    it("collapses /home/x to ~", () => {
      expect(normalizeDirPath("/home/alice/projects")).toBe("~/projects");
      expect(normalizeDirPath("/home/bob")).toBe("~");
    });

    it("strips trailing slashes except root", () => {
      expect(normalizeDirPath("/var/log/")).toBe("/var/log");
      expect(normalizeDirPath("~/foo/")).toBe("~/foo");
      expect(normalizeDirPath("/")).toBe("/");
      expect(normalizeDirPath("~/")).toBe("~");
    });

    it("converts Windows backslashes to forward slashes", () => {
      expect(normalizeDirPath("C:\\Users\\alice\\projects")).toBe("C:/Users/alice/projects");
      expect(normalizeDirPath("\\\\share\\folder")).toBe("//share/folder");
    });

    it("handles root directory", () => {
      expect(normalizeDirPath("/")).toBe("/");
    });

    it("handles empty or whitespace input", () => {
      expect(normalizeDirPath("")).toBe("");
      expect(normalizeDirPath("   ")).toBe("");
    });

    it("trims whitespace", () => {
      expect(normalizeDirPath("  /var/log  ")).toBe("/var/log");
    });

    it("handles already-prettified paths", () => {
      expect(normalizeDirPath("~/projects")).toBe("~/projects");
      expect(normalizeDirPath("~")).toBe("~");
    });
  });

  describe("findPaneIdByCwd", () => {
    const entries: PaneCwdEntry[] = [
      { paneId: "pane-0", cwd: "~/projects/foo" },
      { paneId: "pane-1", cwd: "/var/log" },
      { paneId: "pane-2", cwd: undefined },
      { paneId: "pane-3", cwd: "~" },
    ];

    it("finds exact match by paneId", () => {
      expect(findPaneIdByCwd("~/projects/foo", entries)).toBe("pane-0");
      expect(findPaneIdByCwd("/var/log", entries)).toBe("pane-1");
    });

    it("matches absolute path against prettified cwd", () => {
      // Assuming /Users/alice or /home/alice → ~
      expect(findPaneIdByCwd("/Users/testuser", entries)).toBe("pane-3");
      expect(findPaneIdByCwd("/home/testuser", entries)).toBe("pane-3");
    });

    it("normalizes both sides for comparison", () => {
      expect(findPaneIdByCwd("/var/log/", entries)).toBe("pane-1"); // trailing slash
      expect(findPaneIdByCwd("~/projects/foo/", entries)).toBe("pane-0");
    });

    it("returns null when no match", () => {
      expect(findPaneIdByCwd("/nonexistent", entries)).toBe(null);
      expect(findPaneIdByCwd("~/other", entries)).toBe(null);
    });

    it("returns null for empty target", () => {
      expect(findPaneIdByCwd("", entries)).toBe(null);
      expect(findPaneIdByCwd("   ", entries)).toBe(null);
    });

    it("skips entries with missing cwd", () => {
      expect(findPaneIdByCwd("pane-2", entries)).toBe(null);
    });

    it("returns first match if multiple panes have same cwd", () => {
      const dupes: PaneCwdEntry[] = [
        { paneId: "pane-0", cwd: "~/foo" },
        { paneId: "pane-1", cwd: "~/foo" },
      ];
      expect(findPaneIdByCwd("~/foo", dupes)).toBe("pane-0");
    });

    it("handles empty entries array", () => {
      expect(findPaneIdByCwd("~/foo", [])).toBe(null);
    });
  });
});
