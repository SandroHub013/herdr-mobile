import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  SafeAreaView,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';

const { width } = Dimensions.get('window');

// Default host address (User PC on Wi-Fi)
const DEFAULT_HOST = '192.168.1.10';
const DEFAULT_PORT = '43737';

interface Workspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  tab_count: number;
  active_tab_id: string;
  agent_status?: string;
}

interface Pane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent?: string;
  agent_status?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  cwd?: string;
}

export default function App() {
  const [host, setHost] = useState<string>(DEFAULT_HOST);
  const [port, setPort] = useState<string>(DEFAULT_PORT);
  const [connected, setConnected] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'workspaces' | 'agents' | 'host'>('workspaces');
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // Data
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [panes, setPanes] = useState<Pane[]>([]);
  const [bridgeStatus, setBridgeStatus] = useState<any>(null);

  // Interaction Modal (Agent / Pane)
  const [selectedPane, setSelectedPane] = useState<Pane | null>(null);
  const [modalVisible, setModalVisible] = useState<boolean>(false);
  const [terminalOutput, setTerminalOutput] = useState<string>('');
  const [promptText, setPromptText] = useState<string>('');
  const [loadingAction, setLoadingAction] = useState<boolean>(false);

  // New Workspace Modal
  const [newWsModalVisible, setNewWsModalVisible] = useState<boolean>(false);
  const [newWsLabel, setNewWsLabel] = useState<string>('');
  const [newWsCwd, setNewWsCwd] = useState<string>('');

  const wsRef = useRef<WebSocket | null>(null);
  const terminalScrollRef = useRef<ScrollView | null>(null);

  const baseUrl = `http://${host}:${port}`;
  const wsUrl = `ws://${host}:${port}/ws`;

  // Connect WebSocket for live state push
  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'snapshot_update' && msg.snapshot) {
            if (msg.snapshot.workspaces) setWorkspaces(msg.snapshot.workspaces);
            if (msg.snapshot.panes) setPanes(msg.snapshot.panes);
          }
        } catch (e) {
          console.error('Error parsing WS message:', e);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        // Auto-reconnect after 3s
        setTimeout(() => {
          connectWebSocket();
        }, 3000);
      };

      ws.onerror = () => {
        setConnected(false);
      };
    } catch (err) {
      setConnected(false);
    }
  }, [wsUrl]);

  // Initial fetch and WebSocket connection
  const fetchData = async () => {
    try {
      setRefreshing(true);
      const [statusRes, snapRes] = await Promise.all([
        fetch(`${baseUrl}/api/status`).then((r) => r.json()).catch(() => null),
        fetch(`${baseUrl}/api/snapshot`).then((r) => r.json()).catch(() => null),
      ]);

      if (statusRes) {
        setBridgeStatus(statusRes);
        setConnected(true);
      }
      if (snapRes) {
        if (snapRes.workspaces) setWorkspaces(snapRes.workspaces);
        if (snapRes.panes) setPanes(snapRes.panes);
      }
    } catch (e) {
      setConnected(false);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
    connectWebSocket();
    return () => {
      if (wsRef.current) wsRef.current.close();
    };
  }, [host, port, connectWebSocket]);

  // Read terminal output of selected pane
  const readPaneOutput = async (paneId: string) => {
    try {
      const res = await fetch(`${baseUrl}/api/panes/${paneId}/read?lines=60`);
      const data = await res.json();
      setTerminalOutput(data.text || 'Nessun output recente.');
    } catch (e) {
      setTerminalOutput('Errore durante la lettura dell\'output.');
    }
  };

  // Open interaction sheet
  const openAgentInteraction = (pane: Pane) => {
    setSelectedPane(pane);
    setTerminalOutput('Caricamento terminale...');
    setModalVisible(true);
    readPaneOutput(pane.pane_id);
  };

  // Send prompt to pane
  const handleSendPrompt = async (textToSend?: string) => {
    const text = textToSend !== undefined ? textToSend : promptText;
    if (!text.trim() || !selectedPane) return;

    try {
      setLoadingAction(true);
      await fetch(`${baseUrl}/api/panes/${selectedPane.pane_id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (textToSend === undefined) setPromptText('');
      setTimeout(() => {
        readPaneOutput(selectedPane.pane_id);
        setLoadingAction(false);
      }, 700);
    } catch (e) {
      setLoadingAction(false);
    }
  };

  // Send special keys (Ctrl+C, Enter, etc.)
  const handleSendKeys = async (keys: string[]) => {
    if (!selectedPane) return;
    try {
      await fetch(`${baseUrl}/api/panes/${selectedPane.pane_id}/send-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys }),
      });
      setTimeout(() => readPaneOutput(selectedPane.pane_id), 400);
    } catch (e) {}
  };

  // Focus a workspace on the PC
  const handleFocusWorkspace = async (workspaceId: string) => {
    try {
      await fetch(`${baseUrl}/api/workspaces/${workspaceId}/focus`, { method: 'POST' });
    } catch (e) {}
  };

  // Create new workspace
  const handleCreateWorkspace = async () => {
    if (!newWsLabel.trim()) return;
    try {
      await fetch(`${baseUrl}/api/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: newWsLabel.trim(),
          cwd: newWsCwd.trim() || undefined,
          focus: true,
        }),
      });
      setNewWsLabel('');
      setNewWsCwd('');
      setNewWsModalVisible(false);
      fetchData();
    } catch (e) {}
  };

  const agentPanes = panes.filter((p) => p.agent || p.terminal_title_stripped);

  const getStatusBadge = (status?: string) => {
    const s = (status || 'unknown').toLowerCase();
    if (s === 'working') {
      return <View style={[styles.badge, styles.badgeWorking]}><Text style={styles.badgeTextWorking}>WORKING</Text></View>;
    }
    if (s === 'blocked') {
      return <View style={[styles.badge, styles.badgeBlocked]}><Text style={styles.badgeTextBlocked}>BLOCKED</Text></View>;
    }
    if (s === 'idle' || s === 'done') {
      return <View style={[styles.badge, styles.badgeIdle]}><Text style={styles.badgeTextIdle}>IDLE</Text></View>;
    }
    return <View style={[styles.badge, styles.badgeUnknown]}><Text style={styles.badgeTextUnknown}>{s.toUpperCase()}</Text></View>;
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#090A0F" />

      {/* Top Header */}
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <View style={styles.brandIcon}>
            <Text style={styles.brandEmoji}>🦙</Text>
          </View>
          <View>
            <Text style={styles.brandTitle}>Herdr Mobile</Text>
            <Text style={styles.brandSub}>Remote Companion</Text>
          </View>
        </View>
        <View style={[styles.statusPill, connected ? styles.statusConnected : styles.statusDisconnected]}>
          <View style={[styles.statusDot, connected ? styles.dotConnected : styles.dotDisconnected]} />
          <Text style={[styles.statusText, connected ? styles.textConnected : styles.textDisconnected]}>
            {connected ? 'ONLINE' : 'OFFLINE'}
          </Text>
        </View>
      </View>

      {/* Main Content Area */}
      <ScrollView
        style={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={fetchData} tintColor="#00D2FF" />}
      >
        {/* SPACES TAB */}
        {activeTab === 'workspaces' && (
          <View>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Workspaces ({workspaces.length})</Text>
              <TouchableOpacity style={styles.btnPrimarySmall} onPress={() => setNewWsModalVisible(true)}>
                <Text style={styles.btnPrimarySmallText}>+ Nuovo Space</Text>
              </TouchableOpacity>
            </View>

            {workspaces.map((ws) => (
              <TouchableOpacity
                key={ws.workspace_id}
                style={[styles.card, ws.focused && styles.cardFocused]}
                onPress={() => handleFocusWorkspace(ws.workspace_id)}
                activeOpacity={0.8}
              >
                <View style={styles.cardTop}>
                  <Text style={styles.cardTitle}>
                    {ws.focused ? '⭐ ' : ''}{ws.label}
                  </Text>
                  {getStatusBadge(ws.agent_status)}
                </View>
                <View style={styles.cardMeta}>
                  <Text style={styles.metaItem}>#️⃣ Spazio: {ws.number}</Text>
                  <Text style={styles.metaItem}>📑 Tabs: {ws.tab_count}</Text>
                  <Text style={styles.metaItem}>🔲 Riquadri: {ws.pane_count}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* AGENTS TAB */}
        {activeTab === 'agents' && (
          <View>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Agenti Attivi ({agentPanes.length})</Text>
              <TouchableOpacity style={styles.chip} onPress={fetchData}>
                <Text style={styles.chipText}>🔄 Aggiorna</Text>
              </TouchableOpacity>
            </View>

            {agentPanes.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateText}>Nessun agente attivo nei workspace.</Text>
              </View>
            ) : (
              agentPanes.map((p) => {
                const name = p.agent || p.terminal_title_stripped || 'Shell';
                return (
                  <View key={p.pane_id} style={styles.card}>
                    <View style={styles.cardTop}>
                      <Text style={styles.cardTitle}>🤖 {name}</Text>
                      {getStatusBadge(p.agent_status)}
                    </View>
                    {p.terminal_title_stripped && (
                      <Text style={styles.agentSub} numberOfLines={1}>
                        {p.terminal_title_stripped}
                      </Text>
                    )}
                    <View style={styles.cardMeta}>
                      <Text style={styles.metaItem}>🔲 Pane: {p.pane_id}</Text>
                      <Text style={styles.metaItem}>
                        📁 {(p.cwd || '').split('\\').filter(Boolean).pop() || ''}
                      </Text>
                    </View>

                    <View style={styles.agentActionsRow}>
                      <TouchableOpacity
                        style={[styles.btnAction, styles.btnPrompt]}
                        onPress={() => openAgentInteraction(p)}
                      >
                        <Text style={styles.btnPromptText}>💬 Invia Prompt</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.btnAction, styles.btnInterrupt]}
                        onPress={() => {
                          setSelectedPane(p);
                          handleSendKeys(['ctrl+c']);
                        }}
                      >
                        <Text style={styles.btnInterruptText}>🛑 Stop (Ctrl+C)</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                );
              })
            )}
          </View>
        )}

        {/* HOST PC SETTINGS TAB */}
        {activeTab === 'host' && (
          <View>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Configurazione Host PC</Text>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>💻 Connessione Bridge Daemon</Text>
              <Text style={styles.inputLabel}>Indirizzo IP del PC (Wi-Fi):</Text>
              <TextInput
                style={styles.input}
                value={host}
                onChangeText={setHost}
                placeholder="192.168.1.10"
                placeholderTextColor="#555"
              />

              <Text style={styles.inputLabel}>Porta:</Text>
              <TextInput
                style={styles.input}
                value={port}
                onChangeText={setPort}
                placeholder="43737"
                placeholderTextColor="#555"
                keyboardType="numeric"
              />

              <TouchableOpacity style={styles.btnPrimary} onPress={fetchData}>
                <Text style={styles.btnPrimaryText}>Riconnetti al PC</Text>
              </TouchableOpacity>
            </View>

            {bridgeStatus && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>ℹ️ Info Sistema</Text>
                <View style={styles.cardMetaCol}>
                  <Text style={styles.metaItem}>Versione Bridge: {bridgeStatus.bridge_version}</Text>
                  <Text style={styles.metaItem}>Herdr Socket: {bridgeStatus.herdr_alive ? '🟢 Connesso' : '🔴 Non trovato'}</Text>
                  <Text style={styles.metaItem}>Client WS attivi: {bridgeStatus.ws_clients}</Text>
                </View>
              </View>
            )}
          </View>
        )}
      </ScrollView>

      {/* Bottom Navigation Bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'workspaces' && styles.tabBtnActive]}
          onPress={() => setActiveTab('workspaces')}
        >
          <Text style={styles.tabEmoji}>🧭</Text>
          <Text style={[styles.tabText, activeTab === 'workspaces' && styles.tabTextActive]}>Spaces</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'agents' && styles.tabBtnActive]}
          onPress={() => setActiveTab('agents')}
        >
          <Text style={styles.tabEmoji}>⚡</Text>
          <Text style={[styles.tabText, activeTab === 'agents' && styles.tabTextActive]}>Agenti</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'host' && styles.tabBtnActive]}
          onPress={() => setActiveTab('host')}
        >
          <Text style={styles.tabEmoji}>⚙️</Text>
          <Text style={[styles.tabText, activeTab === 'host' && styles.tabTextActive]}>Host PC</Text>
        </TouchableOpacity>
      </View>

      {/* MODAL: Interaction Sheet for Agent */}
      <Modal visible={modalVisible} animationType="slide" transparent onRequestClose={() => setModalVisible(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>
                  {selectedPane?.agent || selectedPane?.terminal_title_stripped || 'Agente'}
                </Text>
                <Text style={styles.modalSub}>ID: {selectedPane?.pane_id}</Text>
              </View>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Text style={styles.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>

            {/* Terminal output box */}
            <ScrollView
              ref={terminalScrollRef}
              style={styles.terminalBox}
              contentContainerStyle={{ padding: 10 }}
              onContentSizeChange={() => terminalScrollRef.current?.scrollToEnd({ animated: true })}
            >
              <Text style={styles.terminalText}>{terminalOutput}</Text>
            </ScrollView>

            {/* Quick response chips */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipsRow}>
              <TouchableOpacity style={styles.chip} onPress={() => handleSendKeys(['enter'])}>
                <Text style={styles.chipText}>↵ Invio</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.chip} onPress={() => handleSendKeys(['ctrl+c'])}>
                <Text style={styles.chipText}>🛑 Ctrl+C</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.chip} onPress={() => handleSendPrompt('y')}>
                <Text style={styles.chipText}>✅ yes (y)</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.chip} onPress={() => handleSendPrompt('n')}>
                <Text style={styles.chipText}>❌ no (n)</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.chip} onPress={() => handleSendPrompt('proceed')}>
                <Text style={styles.chipText}>▶ proceed</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.chip}
                onPress={() => selectedPane && readPaneOutput(selectedPane.pane_id)}
              >
                <Text style={styles.chipText}>🔄 Aggiorna</Text>
              </TouchableOpacity>
            </ScrollView>

            {/* Input row */}
            <View style={styles.promptInputRow}>
              <TextInput
                style={styles.promptInput}
                value={promptText}
                onChangeText={setPromptText}
                placeholder="Invia prompt o comando..."
                placeholderTextColor="#666"
                onSubmitEditing={() => handleSendPrompt()}
              />
              <TouchableOpacity style={styles.btnSend} onPress={() => handleSendPrompt()}>
                {loadingAction ? (
                  <ActivityIndicator size="small" color="#000" />
                ) : (
                  <Text style={styles.btnSendText}>Invia</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* MODAL: New Workspace */}
      <Modal visible={newWsModalVisible} animationType="fade" transparent onRequestClose={() => setNewWsModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { maxHeight: 340 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Crea Nuovo Workspace</Text>
              <TouchableOpacity onPress={() => setNewWsModalVisible(false)}>
                <Text style={styles.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>Nome Workspace:</Text>
            <TextInput
              style={styles.input}
              value={newWsLabel}
              onChangeText={setNewWsLabel}
              placeholder="Es. MobileProject"
              placeholderTextColor="#555"
            />

            <Text style={styles.inputLabel}>Cartella sul PC (opzionale):</Text>
            <TextInput
              style={styles.input}
              value={newWsCwd}
              onChangeText={setNewWsCwd}
              placeholder="Default: C:\Users\nome\Favorites"
              placeholderTextColor="#555"
            />

            <TouchableOpacity style={styles.btnPrimary} onPress={handleCreateWorkspace}>
              <Text style={styles.btnPrimaryText}>Crea Space</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#090A0F',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2433',
    backgroundColor: '#0E111A',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  brandIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#00D2FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandEmoji: {
    fontSize: 18,
  },
  brandTitle: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  brandSub: {
    color: '#717D96',
    fontSize: 11,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 99,
  },
  statusConnected: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.3)',
  },
  statusDisconnected: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotConnected: {
    backgroundColor: '#10B981',
  },
  dotDisconnected: {
    backgroundColor: '#EF4444',
  },
  statusText: {
    fontSize: 11,
    fontWeight: '700',
  },
  textConnected: {
    color: '#10B981',
  },
  textDisconnected: {
    color: '#EF4444',
  },
  content: {
    flex: 1,
    padding: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#828A9E',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  btnPrimarySmall: {
    backgroundColor: '#00D2FF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  btnPrimarySmallText: {
    color: '#000',
    fontSize: 12,
    fontWeight: '700',
  },
  card: {
    backgroundColor: '#151824',
    borderWidth: 1,
    borderColor: '#23283B',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
  },
  cardFocused: {
    borderColor: 'rgba(0, 210, 255, 0.6)',
    backgroundColor: '#181C2C',
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFF',
    flex: 1,
  },
  agentSub: {
    fontSize: 13,
    color: '#CBD5E1',
    marginBottom: 6,
  },
  cardMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 4,
  },
  cardMetaCol: {
    flexDirection: 'column',
    gap: 6,
    marginTop: 8,
  },
  metaItem: {
    fontSize: 12,
    color: '#828A9E',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeWorking: {
    backgroundColor: 'rgba(0, 210, 255, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(0, 210, 255, 0.4)',
  },
  badgeTextWorking: {
    color: '#00D2FF',
    fontSize: 10,
    fontWeight: '700',
  },
  badgeBlocked: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.4)',
  },
  badgeTextBlocked: {
    color: '#F59E0B',
    fontSize: 10,
    fontWeight: '700',
  },
  badgeIdle: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.4)',
  },
  badgeTextIdle: {
    color: '#10B981',
    fontSize: 10,
    fontWeight: '700',
  },
  badgeUnknown: {
    backgroundColor: 'rgba(130, 138, 158, 0.15)',
  },
  badgeTextUnknown: {
    color: '#828A9E',
    fontSize: 10,
    fontWeight: '700',
  },
  agentActionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.06)',
  },
  btnAction: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrompt: {
    backgroundColor: 'rgba(0, 210, 255, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0, 210, 255, 0.3)',
  },
  btnPromptText: {
    color: '#00D2FF',
    fontSize: 12,
    fontWeight: '600',
  },
  btnInterrupt: {
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  btnInterruptText: {
    color: '#EF4444',
    fontSize: 12,
    fontWeight: '600',
  },
  emptyState: {
    padding: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyStateText: {
    color: '#717D96',
    fontSize: 14,
  },
  inputLabel: {
    color: '#A0AEC0',
    fontSize: 12,
    marginTop: 10,
    marginBottom: 4,
  },
  input: {
    backgroundColor: '#0A0C14',
    borderWidth: 1,
    borderColor: '#23283B',
    borderRadius: 8,
    color: '#FFF',
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
  },
  btnPrimary: {
    backgroundColor: '#00D2FF',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 14,
  },
  btnPrimaryText: {
    color: '#000',
    fontWeight: '700',
    fontSize: 14,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#0E111A',
    borderTopWidth: 1,
    borderTopColor: '#1F2433',
    paddingVertical: 8,
    paddingBottom: Platform.OS === 'ios' ? 24 : 8,
  },
  tabBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabBtnActive: {},
  tabEmoji: {
    fontSize: 18,
  },
  tabText: {
    fontSize: 11,
    color: '#717D96',
    marginTop: 2,
    fontWeight: '600',
  },
  tabTextActive: {
    color: '#00D2FF',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: '#121520',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTitle: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  modalSub: {
    color: '#717D96',
    fontSize: 11,
  },
  closeBtn: {
    color: '#717D96',
    fontSize: 20,
    padding: 4,
  },
  terminalBox: {
    backgroundColor: '#05060A',
    borderWidth: 1,
    borderColor: '#1F2433',
    borderRadius: 10,
    maxHeight: 220,
    minHeight: 120,
    marginBottom: 10,
  },
  terminalText: {
    color: '#D1D5DB',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    lineHeight: 16,
  },
  chipsRow: {
    flexDirection: 'row',
    marginBottom: 10,
    maxHeight: 34,
  },
  chip: {
    backgroundColor: '#1A1E2E',
    borderWidth: 1,
    borderColor: '#2B3248',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    marginRight: 6,
  },
  chipText: {
    color: '#CBD5E1',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  promptInputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  promptInput: {
    flex: 1,
    backgroundColor: '#0A0C14',
    borderWidth: 1,
    borderColor: '#2B3248',
    borderRadius: 10,
    color: '#FFF',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  btnSend: {
    backgroundColor: '#00D2FF',
    borderRadius: 10,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSendText: {
    color: '#000',
    fontWeight: '700',
    fontSize: 14,
  },
});
