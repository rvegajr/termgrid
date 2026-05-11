import { createSignal, For, createMemo, onMount } from "solid-js";
import type { Terminal } from "@xterm/xterm";

export interface SearchResult {
  paneId: string;
  paneName: string;
  lineNumber: number;
  lineContent: string;
  matchIndex: number;
}

interface Props {
  panes: Array<{
    id: string;
    backendId: string;
    terminal: Terminal;
  }>;
  onClose: () => void;
  onSelectResult: (paneId: string, lineNumber: number) => void;
}

export function GlobalSearch(props: Props) {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  const results = createMemo(() => {
    const q = query().toLowerCase();
    if (!q || q.length < 2) return [];

    const found: SearchResult[] = [];

    for (const pane of props.panes) {
      try {
        const buffer = pane.terminal.buffer.active;
        for (let i = 0; i < buffer.length; i++) {
          const line = buffer.getLine(i);
          if (!line) continue;
          
          const text = line.translateToString(true);
          const lowerText = text.toLowerCase();
          const matchIndex = lowerText.indexOf(q);
          
          if (matchIndex >= 0) {
            found.push({
              paneId: pane.id,
              paneName: `Pane ${pane.backendId}`,
              lineNumber: i,
              lineContent: text.trim(),
              matchIndex,
            });
          }
        }
      } catch (err) {
        console.error("Search error for pane", pane.id, err);
      }
    }

    return found.slice(0, 100); // Limit to 100 results
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(i => Math.min(results().length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const result = results()[selectedIndex()];
      if (result) {
        props.onSelectResult(result.paneId, result.lineNumber);
        props.onClose();
      }
    }
  };

  onMount(() => {
    inputRef?.focus();
  });

  return (
    <div
      class="global-search-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="global-search">
        <input
          ref={inputRef}
          type="text"
          class="gs-input"
          placeholder="Search across all panes..."
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
        <div class="gs-results">
          <For each={results()}>
            {(result, idx) => (
              <button
                class={`gs-item ${idx() === selectedIndex() ? "selected" : ""}`}
                onClick={() => {
                  props.onSelectResult(result.paneId, result.lineNumber);
                  props.onClose();
                }}
                onMouseEnter={() => setSelectedIndex(idx())}
              >
                <div class="gs-item-header">
                  <span class="gs-pane-name">{result.paneName}</span>
                  <span class="gs-line-num">Line {result.lineNumber + 1}</span>
                </div>
                <div class="gs-line-content">
                  {result.lineContent.substring(0, result.matchIndex)}
                  <mark>
                    {result.lineContent.substring(
                      result.matchIndex,
                      result.matchIndex + query().length
                    )}
                  </mark>
                  {result.lineContent.substring(result.matchIndex + query().length)}
                </div>
              </button>
            )}
          </For>
          {query().length >= 2 && results().length === 0 && (
            <div class="gs-empty">No matches found</div>
          )}
          {query().length < 2 && query().length > 0 && (
            <div class="gs-empty">Type at least 2 characters to search</div>
          )}
        </div>
      </div>
    </div>
  );
}
