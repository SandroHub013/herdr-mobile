export type AgentStatus = 'working' | 'blocked' | 'idle' | 'unknown' | string;

export interface Workspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status?: AgentStatus;
  git_branch?: string;
}

export interface Tab {
  tab_id: string;
  workspace_id: string;
  label?: string;
  number: number;
  focused?: boolean;
}

export interface Pane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent?: string;
  agent_status?: AgentStatus;
  terminal_title?: string;
  terminal_title_stripped?: string;
  cwd?: string;
}

export interface Snapshot {
  workspaces: Workspace[];
  tabs: Tab[];
  panes: Pane[];
}

export interface Attachment {
  name: string;
  state: 'uploading' | 'ready' | 'failed';
  path?: string;
  ref?: string;
}

const MAX_TITLE_LENGTH = 24;

/**
 * Shell panes report titles like "MINGW64:/c/Users/nome/Favorites", which
 * swallow the whole header and the composer placeholder. Keep the part that
 * identifies the pane and drop the path that leads to it.
 */
function compactTitle(raw: string): string {
  const trimmed = raw.trim();
  const truncate = (value: string) =>
    value.length > MAX_TITLE_LENGTH ? `${value.slice(0, MAX_TITLE_LENGTH - 1)}…` : value;

  if (!/[\\/]/.test(trimmed)) return truncate(trimmed);

  const withoutPrefix = trimmed.includes(':') ? trimmed.slice(trimmed.lastIndexOf(':') + 1) : trimmed;
  const segments = withoutPrefix.split(/[\\/]/).filter(Boolean);
  const last = segments.length > 0 ? segments[segments.length - 1] : '';
  return truncate(last || trimmed);
}

/** Human-readable name for a pane, never empty. */
export function paneTitle(pane: Pane | undefined, fallbackIndex = 0): string {
  if (!pane) return 'Finestra';
  if (pane.agent) return pane.agent;
  const raw = pane.terminal_title_stripped || pane.terminal_title;
  return raw ? compactTitle(raw) : `Finestra ${fallbackIndex + 1}`;
}

export function isBusy(status?: AgentStatus): boolean {
  return status === 'working';
}

export function isBlocked(status?: AgentStatus): boolean {
  return status === 'blocked';
}
