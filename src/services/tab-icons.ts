/**
 * Service for determining tab icons based on CWD and shell type.
 * Provides smart icons for common project types and directories.
 */

export function getTabIcon(cwd?: string, shell?: string): string {
  if (!cwd) {
    // Default shell icons
    if (shell?.toLowerCase().includes("bash")) return "🐚";
    if (shell?.toLowerCase().includes("zsh")) return "⚡";
    if (shell?.toLowerCase().includes("fish")) return "🐟";
    if (shell?.toLowerCase().includes("pwsh") || shell?.toLowerCase().includes("powershell")) return "💠";
    return "▪";
  }

  const lower = cwd.toLowerCase();
  const parts = cwd.split("/").filter(Boolean);
  const lastPart = parts[parts.length - 1] || "";

  // Project types (check filename patterns first)
  if (hasFile(cwd, "package.json")) return "📦"; // Node.js
  if (hasFile(cwd, "Cargo.toml")) return "🦀"; // Rust
  if (hasFile(cwd, "go.mod")) return "🐹"; // Go
  if (hasFile(cwd, "requirements.txt") || hasFile(cwd, "pyproject.toml")) return "🐍"; // Python
  if (hasFile(cwd, "Gemfile")) return "💎"; // Ruby
  if (hasFile(cwd, "composer.json")) return "🐘"; // PHP
  if (hasFile(cwd, "pom.xml") || hasFile(cwd, "build.gradle")) return "☕"; // Java
  if (hasFile(cwd, "Dockerfile")) return "🐳"; // Docker

  // Common directory names
  if (lower.includes("/documents")) return "📄";
  if (lower.includes("/downloads")) return "📥";
  if (lower.includes("/desktop")) return "🖥️";
  if (lower.includes("/pictures") || lower.includes("/photos")) return "🖼️";
  if (lower.includes("/music")) return "🎵";
  if (lower.includes("/videos") || lower.includes("/movies")) return "🎬";
  if (lastPart.startsWith(".") && lastPart !== ".") return "⚙️"; // Config dirs

  // Version control
  if (lower.includes("/.git/") || lastPart === ".git") return "🔀";

  // Special folders
  if (lastPart === "src" || lastPart === "source") return "📁";
  if (lastPart === "test" || lastPart === "tests") return "🧪";
  if (lastPart === "docs" || lastPart === "documentation") return "📚";
  if (lastPart === "dist" || lastPart === "build" || lastPart === "target") return "📦";
  if (lastPart === "node_modules") return "📦";

  // Home directory
  if (cwd === "~" || cwd.endsWith("/~") || lower.includes("/home/") || lower.includes("/users/")) return "🏠";

  // Default
  return "📂";
}

/**
 * Check if a file likely exists in the CWD.
 * This is heuristic-based since we don't have direct fs access from the frontend.
 * In practice, we could enhance this by passing detected files from the backend.
 */
function hasFile(_cwd: string, _filename: string): boolean {
  // TODO: We could send a list of files from backend when CWD changes
  // For now, return false and rely on directory-based heuristics
  return false;
}
