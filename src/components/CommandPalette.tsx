import { createSignal, For, createEffect, onMount } from "solid-js";

export interface Command {
  id: string;
  name: string;
  description: string;
  keywords?: string[];
  action: () => void | Promise<void>;
}

interface Props {
  commands: Command[];
  onClose: () => void;
}

export function CommandPalette(props: Props) {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  const filteredCommands = () => {
    const q = query().toLowerCase();
    if (!q) return props.commands;
    
    return props.commands.filter((cmd) => {
      const searchText = [
        cmd.name,
        cmd.description,
        ...(cmd.keywords || []),
      ].join(" ").toLowerCase();
      return searchText.includes(q);
    });
  };

  const executeCommand = (cmd: Command) => {
    props.onClose();
    cmd.action();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(i => Math.min(filteredCommands().length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(i => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filteredCommands()[selectedIndex()];
      if (cmd) executeCommand(cmd);
    }
  };

  onMount(() => {
    inputRef?.focus();
  });

  createEffect(() => {
    // Reset selection when filter changes
    query();
    setSelectedIndex(0);
  });

  return (
    <div
      class="command-palette-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="command-palette">
        <input
          ref={inputRef}
          type="text"
          class="cp-input"
          placeholder="Type a command..."
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <div class="cp-results">
          <For each={filteredCommands()}>
            {(cmd, idx) => (
              <button
                class={`cp-item ${idx() === selectedIndex() ? "selected" : ""}`}
                onClick={() => executeCommand(cmd)}
                onMouseEnter={() => setSelectedIndex(idx())}
              >
                <div class="cp-item-name">{cmd.name}</div>
                <div class="cp-item-desc">{cmd.description}</div>
              </button>
            )}
          </For>
          {filteredCommands().length === 0 && (
            <div class="cp-empty">No commands found</div>
          )}
        </div>
      </div>
    </div>
  );
}
