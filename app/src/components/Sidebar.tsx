import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space, type } from '../theme';
import { IconChevron, IconClose, IconPlus, StatusDot } from '../icons';
import { Divider, IconButton } from './Primitives';
import { AgentStatus, isBlocked, isBusy, Pane, Tab, Workspace } from '../types';

export interface AgentEntry {
  pane: Pane;
  workspaceLabel: string;
  tabLabel: string;
}

/**
 * The states Herdr reports for an agent, in the order they matter to the
 * reader: what is waiting on them first, then what is running, then the rest.
 */
const AGENT_GROUPS: { status: AgentStatus; title: string }[] = [
  { status: 'blocked', title: 'In attesa di te' },
  { status: 'working', title: 'Al lavoro' },
  { status: 'idle', title: 'Fermi' },
];
const OTHER_GROUP = 'Altro';

/** A section title that folds its section away, so a long list can be put aside. */
function SectionHeader({
  title,
  count,
  open,
  onToggle,
  trailing,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`${title}, ${open ? 'comprimi' : 'espandi'}`}
      onPress={onToggle}
      style={({ pressed }) => [styles.sectionHeader, pressed && styles.sectionHeaderPressed]}
    >
      <View style={styles.sectionChevron}>
        <IconChevron size={11} color={colors.textFaint} direction={open ? 'down' : 'right'} />
      </View>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      {count ? <Text style={styles.count}>{String(count)}</Text> : null}
      <View style={styles.sectionSpacer} />
      {trailing}
    </Pressable>
  );
}

export function Sidebar({
  workspaces,
  activeWorkspaceId,
  agents,
  onSelectWorkspace,
  onSelectAgent,
  onNewWorkspace,
  onClose,
}: {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  agents: AgentEntry[];
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectAgent: (entry: AgentEntry) => void;
  onNewWorkspace: () => void;
  onClose?: () => void;
}) {
  const [spacesOpen, setSpacesOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(true);

  const groups = groupAgents(agents);

  return (
    <View style={styles.sidebar}>
      <SectionHeader
        title="Spazi"
        count={workspaces.length}
        open={spacesOpen}
        onToggle={() => setSpacesOpen((open) => !open)}
        trailing={
          onClose ? (
            <IconButton accessibilityLabel="Chiudi il pannello" onPress={onClose} size={28}>
              <IconClose size={13} color={colors.textMuted} />
            </IconButton>
          ) : undefined
        }
      />

      <ScrollView style={styles.scroll} contentContainerStyle={styles.listContent}>
        {spacesOpen ? (
          <>
            {workspaces.length === 0 ? (
              <Text style={styles.placeholder}>Nessuno spazio aperto</Text>
            ) : (
              workspaces.map((workspace) => {
                const active = workspace.workspace_id === activeWorkspaceId;
                const blocked = isBlocked(workspace.agent_status);
                const busy = isBusy(workspace.agent_status);
                return (
                  <Pressable
                    key={workspace.workspace_id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => onSelectWorkspace(workspace.workspace_id)}
                    style={({ pressed }) => [styles.row, active && styles.rowActive, pressed && styles.rowPressed]}
                  >
                    <View style={styles.rowDot}>
                      <StatusDot
                        size={7}
                        hollow={busy}
                        color={blocked ? colors.busy : busy ? colors.online : colors.textFaint}
                      />
                    </View>
                    <View style={styles.rowText}>
                      <Text numberOfLines={1} style={[styles.rowLabel, active && styles.rowLabelActive]}>
                        {workspace.label}
                      </Text>
                      {workspace.git_branch ? (
                        <Text numberOfLines={1} style={styles.rowSub}>
                          {workspace.git_branch}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })
            )}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Nuovo spazio"
              onPress={onNewWorkspace}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.rowDot}>
                <IconPlus size={12} color={colors.textMuted} />
              </View>
              <Text style={styles.newLabel}>Nuovo spazio</Text>
            </Pressable>
          </>
        ) : null}

        <View style={styles.separator}>
          <Divider />
        </View>

        <SectionHeader
          title="Agenti"
          count={agents.length}
          open={agentsOpen}
          onToggle={() => setAgentsOpen((open) => !open)}
        />

        {agentsOpen ? (
          agents.length === 0 ? (
            <Text style={styles.placeholder}>Nessun agente attivo</Text>
          ) : (
            groups.map((group) => (
              <View key={group.title}>
                <View style={styles.groupLabel}>
                  <Text style={styles.groupTitle}>{group.title}</Text>
                  <Text style={styles.count}>{String(group.entries.length)}</Text>
                </View>
                {group.entries.map((entry) => (
                  <Pressable
                    key={entry.pane.pane_id}
                    accessibilityRole="button"
                    accessibilityLabel={`Vai all'agente ${entry.pane.agent ?? ''} in ${entry.workspaceLabel}`}
                    onPress={() => onSelectAgent(entry)}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  >
                    <View style={styles.rowDot}>
                      <StatusDot
                        size={7}
                        hollow={isBusy(entry.pane.agent_status)}
                        color={isBlocked(entry.pane.agent_status) ? colors.busy : colors.online}
                      />
                    </View>
                    <View style={styles.rowText}>
                      <Text numberOfLines={1} style={styles.agentName}>
                        {entry.pane.agent || entry.pane.terminal_title_stripped || 'agente'}
                      </Text>
                      <Text numberOfLines={1} style={styles.rowSub}>
                        {entry.workspaceLabel}
                        {entry.tabLabel ? ` · ${entry.tabLabel}` : ''}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ))
          )
        ) : null}
      </ScrollView>
    </View>
  );
}

/** Builds the agent list shown in the sidebar, newest workspace order preserved. */
export function collectAgents(panes: Pane[], workspaces: Workspace[], tabs: Tab[]): AgentEntry[] {
  return panes
    .filter((pane) => Boolean(pane.agent) && Boolean(pane.agent_status) && pane.agent_status !== 'unknown')
    .map((pane) => {
      const workspace = workspaces.find((item) => item.workspace_id === pane.workspace_id);
      const tab = tabs.find((item) => item.tab_id === pane.tab_id);
      return {
        pane,
        workspaceLabel: workspace ? workspace.label : 'Spazio',
        tabLabel: tab ? tab.label || `Scheda ${tab.number}` : '',
      };
    });
}

/**
 * Splits the agents by the state Herdr reports for them. Groups with nobody
 * in them are left out, so the panel never shows an empty heading.
 */
export function groupAgents(agents: AgentEntry[]): { title: string; entries: AgentEntry[] }[] {
  const known = new Set(AGENT_GROUPS.map((group) => group.status));
  const groups = AGENT_GROUPS.map((group) => ({
    title: group.title,
    entries: agents.filter((entry) => entry.pane.agent_status === group.status),
  }));
  groups.push({ title: OTHER_GROUP, entries: agents.filter((entry) => !known.has(entry.pane.agent_status ?? '')) });
  return groups.filter((group) => group.entries.length > 0);
}

const styles = StyleSheet.create({
  sidebar: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  scroll: {
    flex: 1,
  },
  listContent: {
    paddingBottom: space.lg,
  },
  separator: {
    marginTop: space.md,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: space.md,
    paddingRight: space.sm,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  sectionHeaderPressed: {
    opacity: 0.7,
  },
  sectionChevron: {
    width: 12,
    alignItems: 'center',
  },
  sectionTitle: {
    ...type.section,
    color: colors.textFaint,
  },
  sectionSpacer: {
    flex: 1,
  },
  groupLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingTop: space.sm,
    paddingBottom: 4,
  },
  groupTitle: {
    ...type.caption,
    color: colors.textMuted,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 10,
    marginHorizontal: space.sm,
    borderRadius: radius.sm,
  },
  rowActive: {
    backgroundColor: colors.surfaceActive,
  },
  rowPressed: {
    backgroundColor: colors.surfaceRaised,
  },
  rowDot: {
    width: 12,
    paddingTop: 5,
    alignItems: 'center',
  },
  rowText: {
    flex: 1,
  },
  rowLabel: {
    ...type.label,
    color: colors.textMuted,
  },
  rowLabelActive: {
    color: colors.text,
    fontWeight: '600',
  },
  rowSub: {
    ...type.mono,
    fontSize: 11,
    color: colors.textFaint,
    marginTop: 2,
  },
  agentName: {
    ...type.mono,
    fontSize: 12.5,
    color: colors.text,
  },
  newLabel: {
    ...type.label,
    color: colors.textMuted,
  },
  count: {
    ...type.caption,
    color: colors.textFaint,
  },
  placeholder: {
    ...type.caption,
    color: colors.textFaint,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
});
