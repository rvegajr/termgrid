import { invoke } from '@tauri-apps/api/core';

export interface ShellInfo {
  name: string;
  path: string;
  kind: string;
}

export interface ShellsWithDefault {
  shells: ShellInfo[];
  default: ShellInfo;
}

export interface CreatePaneResult {
  pane_id: string;
}

export async function listShellsWithDefault(): Promise<ShellsWithDefault> {
  return invoke<ShellsWithDefault>('list_shells_with_default');
}

export async function listShells(): Promise<ShellInfo[]> {
  return invoke<ShellInfo[]>('list_shells');
}

export async function defaultShell(): Promise<ShellInfo> {
  return invoke<ShellInfo>('default_shell');
}

export async function createPane(
  shell?: string,
  cwd?: string,
  cols?: number,
  rows?: number,
): Promise<CreatePaneResult> {
  return invoke<CreatePaneResult>('create_pane', { shell, cwd, cols, rows });
}

export async function writePane(paneId: string, data: string): Promise<void> {
  return invoke<void>('write_pane', { paneId, data });
}

export async function resizePane(paneId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>('resize_pane', { paneId, cols, rows });
}

export async function closePane(paneId: string): Promise<void> {
  return invoke<void>('close_pane', { paneId });
}

export async function snapshotSave(paneId: string, contents: string): Promise<void> {
  return invoke<void>('snapshot_save', { paneId, contents });
}

export async function snapshotLoad(paneId: string): Promise<string | null> {
  return invoke<string | null>('snapshot_load', { paneId });
}

export async function snapshotDelete(paneId: string): Promise<void> {
  return invoke<void>('snapshot_delete', { paneId });
}

export async function snapshotList(): Promise<string[]> {
  return invoke<string[]>('snapshot_list');
}

export interface HistoryRow {
  pane_id: string;
  session_id: string;
  shell?: string;
  cwd?: string;
  cmd: string;
  exit_code?: number;
  started_at: number;
  duration_ms?: number;
  source: string;
}

export interface HistoryRecord extends HistoryRow {
  id: number;
}

export type HistoryScope =
  | { kind: 'global' }
  | { kind: 'pane'; pane_id: string }
  | { kind: 'session'; session_id: string };

export async function historyRecord(row: HistoryRow): Promise<number> {
  return invoke<number>('history_record', { row });
}
export async function historySearch(scope: HistoryScope, query: string, limit = 100): Promise<HistoryRecord[]> {
  return invoke<HistoryRecord[]>('history_search', { scope, query, limit });
}
export async function historyRecent(paneId: string, limit = 50): Promise<HistoryRecord[]> {
  return invoke<HistoryRecord[]>('history_recent', { paneId, limit });
}
