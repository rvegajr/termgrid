/**
 * Lazy-loaded terminal modules.
 * This keeps xterm + addons out of the main bundle for faster initial load.
 */

import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { WebLinksAddon } from "@xterm/addon-web-links";

export interface TerminalModules {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
  SearchAddon: typeof SearchAddon;
  WebglAddon: typeof WebglAddon;
  WebLinksAddon: typeof WebLinksAddon;
}

let cachedModules: TerminalModules | null = null;

/**
 * Load xterm and addons dynamically.
 * Caches the result so subsequent calls are instant.
 */
export async function loadTerminalModules(): Promise<TerminalModules> {
  if (cachedModules) {
    return cachedModules;
  }

  const [xterm, fit, search, webgl, weblinks] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-search"),
    import("@xterm/addon-webgl"),
    import("@xterm/addon-web-links"),
  ]);

  cachedModules = {
    Terminal: xterm.Terminal,
    FitAddon: fit.FitAddon,
    SearchAddon: search.SearchAddon,
    WebglAddon: webgl.WebglAddon,
    WebLinksAddon: weblinks.WebLinksAddon,
  };

  return cachedModules;
}

/**
 * Prefetch terminal modules for faster first use.
 * Call this on hover over shell buttons on the welcome screen.
 */
export function prefetchTerminalModules(): void {
  // Create <link rel="modulepreload"> for each chunk
  const chunks = [
    "@xterm/xterm",
    "@xterm/addon-fit",
    "@xterm/addon-search",
    "@xterm/addon-webgl",
    "@xterm/addon-web-links",
  ];

  for (const chunk of chunks) {
    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.href = chunk;
    document.head.appendChild(link);
  }
}
