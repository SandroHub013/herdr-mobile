import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as DocumentPicker from 'expo-document-picker';
import { Effect, Either } from 'effect';

import { colors, space } from './src/theme';
import { Attachment, attachmentKind, isBusy, paneTitle } from './src/types';
import { BridgeError, describeError } from './src/errors';
import { discardLocalCopy } from './src/files';
import { ConnectionSettings, DEFAULT_SETTINGS, loadSettings, saveSettings } from './src/storage';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useSystemChrome } from './src/hooks/useSystemChrome';
import { useHerdrSession } from './src/hooks/useHerdrSession';
import { IconSinglePane, IconSplitDown, IconSplitRight } from './src/icons';
import { Divider, EmptyState, PrimaryButton, TextButton } from './src/components/Primitives';
import { Header } from './src/components/Header';
import { TabBar } from './src/components/TabBar';
import { Sidebar, collectAgents } from './src/components/Sidebar';
import { ChatFeed } from './src/components/chat/ChatFeed';
import { useConversation } from './src/hooks/useConversation';
import { Composer } from './src/components/Composer';
import type { Control } from './src/domain/events';
import { ActionSheet, Dialog, SheetAction, TextField } from './src/components/Overlays';
import { Toast, useToast } from './src/components/Toast';
import { UpdateBanner } from './src/components/UpdateBanner';
import { VersionRow } from './src/components/VersionRow';
import { useAppUpdate } from './src/hooks/useAppUpdate';

const SIDEBAR_WIDTH = 272;
const HISTORY_LIMIT = 50;

function HerdrApp() {
  const chrome = useSystemChrome();
  const toast = useToast();

  const [settings, setSettings] = useState<ConnectionSettings>(() => Effect.runSync(loadSettings));
  const session = useHerdrSession(settings.host, settings.port, settings.token);
  const { api, subscribe, sendText, sendKeys, submit, connected, unauthorized, snapshot } = session;
  const { workspaces, tabs, panes } = snapshot;
  const appUpdate = useAppUpdate(api, connected, toast.show);

  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);

  /**
   * The conversation in the focused pane. Held here rather than inside the
   * feed because the composer needs the same manifest: it is what decides
   * which pills it shows, and one pane must not be read twice.
   */
  const conversation = useConversation(api, activePaneId);

  const [drawerOpen, setDrawerOpen] = useState(false);

  const [composerText, setComposerText] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const draftRef = useRef('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentIdRef = useRef(0);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [spaceDialogOpen, setSpaceDialogOpen] = useState(false);
  const [draftHost, setDraftHost] = useState(settings.host);
  const [draftPort, setDraftPort] = useState(settings.port);
  const [draftToken, setDraftToken] = useState(settings.token);
  const [newSpaceLabel, setNewSpaceLabel] = useState('');

  const sidebarIsPermanent = chrome.isLandscape;
  const drawerVisible = !sidebarIsPermanent && drawerOpen;

  // ---------------------------------------------------------------- selection

  const currentTabs = useMemo(
    () => tabs.filter((tab) => tab.workspace_id === activeWorkspaceId),
    [tabs, activeWorkspaceId],
  );
  const activeTabPanes = useMemo(() => panes.filter((pane) => pane.tab_id === activeTabId), [panes, activeTabId]);
  const activeWorkspace = workspaces.find((workspace) => workspace.workspace_id === activeWorkspaceId);
  const activePane = panes.find((pane) => pane.pane_id === activePaneId);
  const agents = useMemo(() => collectAgents(panes, workspaces, tabs), [panes, workspaces, tabs]);
  const busyTabIds = useMemo(() => {
    const busy = new Set<string>();
    panes.forEach((pane) => {
      if (isBusy(pane.agent_status)) busy.add(pane.tab_id);
    });
    return busy;
  }, [panes]);

  // Keeps the selected workspace, tab and pane pointing at something that exists,
  // without ever overriding a choice the user just made.
  useEffect(() => {
    if (workspaces.length === 0) return;

    const workspaceExists = activeWorkspaceId && workspaces.some((w) => w.workspace_id === activeWorkspaceId);
    if (!workspaceExists) {
      const preferred = workspaces.find((w) => w.focused) ?? workspaces[0];
      setActiveWorkspaceId(preferred.workspace_id);
      setActiveTabId(null);
      setActivePaneId(null);
      return;
    }

    const tabsHere = tabs.filter((tab) => tab.workspace_id === activeWorkspaceId);
    const tabExists = activeTabId && tabsHere.some((tab) => tab.tab_id === activeTabId);
    if (!tabExists) {
      if (tabsHere.length === 0) return;
      const preferred = tabsHere.find((tab) => tab.focused) ?? tabsHere[0];
      setActiveTabId(preferred.tab_id);
      setActivePaneId(null);
      return;
    }

    const panesHere = panes.filter((pane) => pane.tab_id === activeTabId);
    if (panesHere.length === 0) return;
    const paneExists = activePaneId && panesHere.some((pane) => pane.pane_id === activePaneId);
    if (!paneExists) {
      setActivePaneId(panesHere[0].pane_id);
    }
  }, [workspaces, tabs, panes, activeWorkspaceId, activeTabId, activePaneId]);

  // Stream the panes of the visible tab, and nothing else.
  const paneIdsKey = activeTabPanes.map((pane) => pane.pane_id).join('|');
  useEffect(() => {
    subscribe(paneIdsKey ? paneIdsKey.split('|') : []);
  }, [paneIdsKey, subscribe]);

  // ------------------------------------------------------------------ actions

  // Every bridge call ends here. The error channel is a closed union, so the
  // compiler is the thing that guarantees a failure always reaches the user.
  const run = useCallback(
    <A,>(description: string, action: Effect.Effect<A, BridgeError>) => {
      Effect.runFork(
        action.pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => toast.show(`${description}: ${describeError(error)}`)),
          ),
        ),
      );
    },
    [toast],
  );

  const handleSelectWorkspace = useCallback(
    (workspaceId: string) => {
      setActiveWorkspaceId(workspaceId);
      setActiveTabId(null);
      setActivePaneId(null);
      setDrawerOpen(false);
      run('Spazio non attivato', api.focusWorkspace(workspaceId));
    },
    [api, run],
  );

  const handleSelectTab = useCallback(
    (tabId: string) => {
      setActiveTabId(tabId);
      setActivePaneId(null);
      run('Scheda non attivata', api.focusTab(tabId));
    },
    [api, run],
  );

  const handleSelectPane = useCallback(
    (paneId: string) => {
      // Changing pane changes the conversation being read; the hook watching
      // it starts over on its own.
      setActivePaneId(paneId);
      run('Finestra non attivata', api.focusPane(paneId));
    },
    [api, run],
  );

  const handleNewTab = useCallback(() => {
    const workspaceId = activeWorkspaceId ?? workspaces[0]?.workspace_id;
    if (!workspaceId) {
      toast.show('Nessuno spazio in cui creare una scheda');
      return;
    }
    run(
      'Scheda non creata',
      api.createTab(workspaceId).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result?.tab?.tab_id) setActiveTabId(result.tab.tab_id);
            if (result?.root_pane?.pane_id) setActivePaneId(result.root_pane.pane_id);
          }),
        ),
      ),
    );
  }, [activeWorkspaceId, api, run, toast, workspaces]);

  const handleSplit = useCallback(
    (direction: 'right' | 'down') => {
      const paneId = activePaneId ?? activeTabPanes[0]?.pane_id;
      if (!paneId) {
        toast.show('Nessuna finestra da dividere');
        return;
      }
      run(
        'Divisione non riuscita',
        api.splitPane(paneId, direction).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              // The new pane becomes the one being read: splitting on the PC
              // is still useful, but the phone shows one conversation.
              if (result?.pane?.pane_id) setActivePaneId(result.pane.pane_id);
            }),
          ),
        ),
      );
    },
    [activePaneId, activeTabPanes, api, run, toast],
  );

  const handleClosePane = useCallback(
    (paneId: string) => {
      run('Finestra non chiusa', api.closePane(paneId));
    },
    [api, run],
  );

  const handleZoomPane = useCallback(
    (paneId: string) => {
      run('Zoom non riuscito', api.zoomPane(paneId));
    },
    [api, run],
  );

  const handleCreateWorkspace = useCallback(() => {
    const label = newSpaceLabel.trim();
    if (!label) return;
    setSpaceDialogOpen(false);
    setNewSpaceLabel('');
    run('Spazio non creato', api.createWorkspace(label));
  }, [api, newSpaceLabel, run]);

  const emit = useCallback(
    (text: string) => {
      if (!activePaneId) {
        toast.show('Nessuna finestra selezionata');
        return;
      }
      sendText(activePaneId, text);
    },
    [activePaneId, sendText, toast],
  );

  /** The thumbnails are done with the picker's copies once the message has gone. */
  const clearAttachments = useCallback(() => {
    attachments.forEach((item) => discardLocalCopy(item.uri));
    setAttachments([]);
  }, [attachments]);

  const handleSend = useCallback(() => {
    const text = composerText.trim();
    if (!text) return;
    // Nothing leaves the composer until there is somewhere for it to go: the
    // draft used to be wiped even when the send was refused for lack of a pane.
    if (!activePaneId) {
      toast.show('Nessuna finestra selezionata');
      return;
    }
    submit(activePaneId, text);
    setHistory((previous) =>
      previous[previous.length - 1] === text ? previous : [...previous, text].slice(-HISTORY_LIMIT),
    );
    setComposerText('');
    setHistoryIndex(-1);
    draftRef.current = '';
    clearAttachments();
  }, [activePaneId, clearAttachments, composerText, submit, toast]);

  /**
   * A control on the composer is not a request to the bridge: it is the
   * keystrokes the agent's own manifest said would change that setting, typed
   * into its pane. The app never decides what `/model opus` means, or whether
   * this agent has models at all.
   */
  const handleControl = useCallback(
    (_control: Control, _optionId: string, keys: string) => {
      if (!keys) return;
      if (!activePaneId) {
        toast.show('Nessuna finestra selezionata');
        return;
      }
      // Typed and submitted like a message: the line, then Enter as its own
      // event. A newline inside the text would be kept as text, not sent.
      submit(activePaneId, keys);
      // The setting lands in the transcript a moment later; ask sooner than
      // the idle poll would, so the pill agrees with the agent.
      void conversation.refresh();
    },
    [activePaneId, conversation, submit, toast],
  );

  /** Stops the agent with the keys its manifest names, not with a guess. */
  const handleInterrupt = useCallback(() => {
    if (!activePaneId) {
      toast.show('Nessuna finestra selezionata');
      return;
    }
    run('Interruzione non riuscita', api.interruptPane(activePaneId));
  }, [activePaneId, api, run, toast]);

  const handleAttach = useCallback(() => {
    const program = Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        try: () => DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: '*/*', multiple: true }),
        catch: () => 'picker' as const,
      });
      if (result.canceled || !result.assets || result.assets.length === 0) return;

      // One upload at a time: a handful of files at most, and the references
      // land in the composer in the order they were picked.
      for (const picked of result.assets) {
        const id = ++attachmentIdRef.current;
        yield* Effect.sync(() =>
          setAttachments((previous) => [
            ...previous,
            {
              id,
              name: picked.name,
              uri: picked.uri,
              kind: attachmentKind(picked.name, picked.mimeType),
              state: 'uploading',
            },
          ]),
        );

        // The pane decides the upload directory, so the reference the agent reads
        // resolves against the working directory it is actually running in.
        const outcome = yield* Effect.either(
          api.upload({ uri: picked.uri, name: picked.name, mimeType: picked.mimeType }, activeWorkspaceId, activePaneId),
        );

        yield* Effect.sync(() => {
          if (Either.isLeft(outcome)) {
            setAttachments((previous) =>
              previous.map((item): Attachment => (item.id === id ? { ...item, state: 'failed' } : item)),
            );
            toast.show(`Caricamento non riuscito: ${describeError(outcome.left)}`);
            return;
          }
          const uploaded = outcome.right;
          const reference = uploaded.rel_ref || `@${uploaded.filename}`;
          setAttachments((previous) =>
            previous.map(
              (item): Attachment =>
                item.id === id
                  ? { ...item, name: uploaded.filename, state: 'ready', path: uploaded.path, ref: reference }
                  : item,
            ),
          );
          setComposerText((previous) => {
            if (previous.includes(reference)) return previous;
            return previous.trim() ? `${previous.trim()} ${reference}` : reference;
          });
        });
      }
    });

    Effect.runFork(program.pipe(Effect.catchAll(() => Effect.sync(() => toast.show('Selezione del file non riuscita')))));
  }, [activePaneId, activeWorkspaceId, api, toast]);

  const handleRemoveAttachment = useCallback(
    (id: number) => {
      const removed = attachments.find((item) => item.id === id);
      if (!removed) return;
      const reference = removed.ref;
      if (reference) {
        setComposerText((previous) => previous.replace(reference, '').replace(/\s{2,}/g, ' ').trim());
      }
      discardLocalCopy(removed.uri);
      setAttachments((previous) => previous.filter((item) => item.id !== id));
    },
    [attachments],
  );

  const handleSaveConnection = useCallback(() => {
    const host = draftHost.trim();
    const port = draftPort.trim() || DEFAULT_SETTINGS.port;
    if (!host) return;
    const next = { host, port, token: draftToken.trim() };
    setSettings(next);
    Effect.runFork(saveSettings(next));
    setActiveWorkspaceId(null);
    setActiveTabId(null);
    setActivePaneId(null);
    setConnectionOpen(false);
  }, [draftHost, draftPort, draftToken]);

  const openConnection = useCallback(() => {
    setDraftHost(settings.host);
    setDraftPort(settings.port);
    setDraftToken(settings.token);
    setConnectionOpen(true);
  }, [settings]);

  // ------------------------------------------------------------------ render

  const sheetActions: SheetAction[] = useMemo(() => {
    const actions: SheetAction[] = [
      {
        key: 'split-right',
        label: 'Dividi a destra',
        icon: <IconSplitRight size={16} color={colors.textMuted} />,
        onPress: () => handleSplit('right'),
      },
      {
        key: 'split-down',
        label: 'Dividi in basso',
        icon: <IconSplitDown size={16} color={colors.textMuted} />,
        onPress: () => handleSplit('down'),
      },
    ];

    if (activePaneId && activeTabPanes.length > 1) {
      actions.push({
        key: 'close-pane',
        label: 'Chiudi questa finestra',
        destructive: true,
        onPress: () => handleClosePane(activePaneId),
      });
    }

    if (activeTabId) {
      actions.push({
        key: 'close-tab',
        label: 'Chiudi la scheda',
        destructive: true,
        onPress: () => run('Scheda non chiusa', api.closeTab(activeTabId)),
      });
    }

    actions.push({
      key: 'connection',
      label: 'Connessione',
      detail: `${settings.host}:${settings.port}`,
      onPress: openConnection,
    });

    return actions;
  }, [
    activePaneId,
    activeTabId,
    activeTabPanes.length,
    api,
    handleClosePane,
    handleSplit,
    openConnection,
    run,
    settings,
  ]);

  const sidebar = (
    <Sidebar
      workspaces={workspaces}
      activeWorkspaceId={activeWorkspaceId}
      agents={agents}
      onSelectWorkspace={handleSelectWorkspace}
      onSelectAgent={(entry) => {
        setActiveWorkspaceId(entry.pane.workspace_id);
        setActiveTabId(entry.pane.tab_id);
        setActivePaneId(entry.pane.pane_id);
        setDrawerOpen(false);
        run('Agente non attivato', api.focusPane(entry.pane.pane_id));
      }}
      onNewWorkspace={() => {
        setDrawerOpen(false);
        setNewSpaceLabel('');
        setSpaceDialogOpen(true);
      }}
      onClose={sidebarIsPermanent ? undefined : () => setDrawerOpen(false)}
    />
  );

  const hasPanes = activePane !== undefined || activeTabPanes.length > 0;

  const content = () => {
    if (!connected && workspaces.length === 0) {
      return unauthorized ? (
        <EmptyState
          title="Il bridge chiede un token"
          detail="Lo stampa il bridge alla partenza e sta nel file bridge.token sul PC. Inseriscilo nel pannello Connessione."
          action={<PrimaryButton label="Inserisci il token" onPress={openConnection} />}
        />
      ) : (
        <EmptyState
          title="Non connesso a Herdr"
          detail={`Nessuna risposta da ${settings.host}:${settings.port}. Verifica che il bridge sia in esecuzione sul PC.`}
          action={<PrimaryButton label="Configura la connessione" onPress={openConnection} />}
        />
      );
    }
    if (workspaces.length === 0) {
      return <EmptyState title="Nessuno spazio aperto" detail="Crea uno spazio dal pannello laterale." />;
    }
    if (!hasPanes) {
      return <EmptyState title="Nessuna finestra in questa scheda" detail="Aprine una dal menu della scheda." />;
    }
    // One conversation at a time. Splitting the screen was a terminal's idea:
    // two chats side by side on a phone leaves neither of them readable.
    return <ChatFeed conversation={conversation} />;
  };

  const bottomPadding = chrome.keyboardVisible ? chrome.keyboardOffset : chrome.bottomInset;

  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: chrome.topInset,
          paddingBottom: bottomPadding,
          paddingRight: chrome.isLandscape ? space.md : 0,
        },
      ]}
    >
      <StatusBar style="light" />

      <View style={styles.shell}>
        {sidebarIsPermanent ? <View style={styles.sidebarColumn}>{sidebar}</View> : null}

        <View style={styles.main}>
          <Header
            title={activeWorkspace ? activeWorkspace.label : 'Herdr'}
            branch={activeWorkspace?.git_branch}
            connected={connected}
            showMenuButton={!sidebarIsPermanent}
            onOpenMenu={() => setDrawerOpen(true)}
            onOpenConnection={openConnection}
          />

          <UpdateBanner state={appUpdate.state} onUpdate={appUpdate.update} onDismiss={appUpdate.dismiss} />

          {currentTabs.length > 0 ? (
            <TabBar
              tabs={currentTabs}
              activeTabId={activeTabId}
              busyTabIds={busyTabIds}
              onSelect={handleSelectTab}
              onNewTab={handleNewTab}
              onOpenMenu={() => setSheetOpen(true)}
            />
          ) : null}

          {content()}

          <Composer
            value={composerText}
            onChangeText={setComposerText}
            onSend={handleSend}
            onAttach={handleAttach}
            onRemoveAttachment={handleRemoveAttachment}
            onControl={handleControl}
            onInterrupt={handleInterrupt}
            attachments={attachments}
            capabilities={conversation.agent?.capabilities ?? null}
            targetLabel={activePane ? paneTitle(activePane) : null}
            busy={conversation.busy}
            disabled={!activePaneId}
          />
        </View>

        {drawerVisible ? (
          <>
            <Pressable
              style={styles.scrim}
              accessibilityLabel="Chiudi il pannello"
              onPress={() => setDrawerOpen(false)}
            />
            <View style={[styles.drawer, { width: Math.min(SIDEBAR_WIDTH, chrome.width * 0.84) }]}>{sidebar}</View>
          </>
        ) : null}
      </View>

      <ActionSheet
        visible={sheetOpen}
        title="Scheda e finestre"
        actions={sheetActions}
        bottomInset={chrome.bottomInset}
        onClose={() => setSheetOpen(false)}
      />

      <Dialog
        visible={connectionOpen}
        title="Connessione"
        onClose={() => setConnectionOpen(false)}
        footer={
          <>
            <TextButton label="Annulla" onPress={() => setConnectionOpen(false)} />
            <PrimaryButton label="Salva" onPress={handleSaveConnection} />
          </>
        }
      >
        <TextField label="Host" value={draftHost} onChangeText={setDraftHost} placeholder="192.168.1.10" />
        <TextField
          label="Porta"
          value={draftPort}
          onChangeText={setDraftPort}
          placeholder={DEFAULT_SETTINGS.port}
          keyboardType="numeric"
        />
        <TextField label="Token" value={draftToken} onChangeText={setDraftToken} placeholder="dal file bridge.token sul PC" />
        <View style={styles.dialogRule}>
          <Divider />
        </View>
        <VersionRow
          state={appUpdate.state}
          lastCheck={appUpdate.lastCheck}
          onCheck={appUpdate.checkNow}
          onUpdate={() => {
            // The banner under the header shows the progress; the dialog gets out of its way.
            setConnectionOpen(false);
            appUpdate.update();
          }}
        />
      </Dialog>

      <Dialog
        visible={spaceDialogOpen}
        title="Nuovo spazio"
        onClose={() => setSpaceDialogOpen(false)}
        footer={
          <>
            <TextButton label="Annulla" onPress={() => setSpaceDialogOpen(false)} />
            <PrimaryButton label="Crea" onPress={handleCreateWorkspace} disabled={!newSpaceLabel.trim()} />
          </>
        }
      >
        <TextField
          label="Nome"
          value={newSpaceLabel}
          onChangeText={setNewSpaceLabel}
          placeholder="backend, web, docs"
          autoFocus
        />
      </Dialog>

      <Toast message={toast.message} top={chrome.topInset + 8} />
    </View>
  );
}

/** The provider has to sit above every hook that asks for the insets. */
export default function App() {
  return (
    <SafeAreaProvider>
      <HerdrApp />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  shell: {
    flex: 1,
    flexDirection: 'row',
  },
  sidebarColumn: {
    width: SIDEBAR_WIDTH,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
  },
  main: {
    flex: 1,
  },
  panes: {
    flex: 1,
    paddingHorizontal: space.md,
    paddingBottom: space.xs,
    gap: space.sm,
  },
  splitRow: {
    flexDirection: 'row',
  },
  splitColumn: {
    flexDirection: 'column',
  },
  dialogRule: {
    marginTop: space.xs,
    marginBottom: space.md,
  },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.scrim,
    zIndex: 10,
  },
  drawer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    zIndex: 20,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
    elevation: 16,
  },
});
