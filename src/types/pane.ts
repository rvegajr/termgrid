export interface PaneIdentifiable {
  readonly id: string;
  readonly shellType: string;
  readonly cwd: string;
}

export interface PaneRenderer {
  mount(container: HTMLElement): void;
  dispose(): void;
  focus(): void;
  blur(): void;
}

export interface PaneResizable {
  resize(cols: number, rows: number): void;
  fit(): void;
}

export interface PaneWritable {
  write(data: string): void;
  writeln(line: string): void;
}

export interface PaneSelectable {
  getSelection(): string;
  selectAll(): void;
  clearSelection(): void;
  hasSelection(): boolean;
}

export interface PaneSearchable {
  findNext(query: string): boolean;
  findPrevious(query: string): boolean;
  clearFind(): void;
}

export interface PaneScrollable {
  scrollToTop(): void;
  scrollToBottom(): void;
  scrollPageUp(): void;
  scrollPageDown(): void;
}

export interface TerminalPane extends
  PaneIdentifiable,
  PaneRenderer,
  PaneResizable,
  PaneWritable,
  PaneSelectable,
  PaneSearchable,
  PaneScrollable {}
