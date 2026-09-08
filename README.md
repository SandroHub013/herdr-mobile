# Herdr Mobile

Controller remoto per **Herdr**, il gestore di workspace e agenti AI per Windows.
Due client parlano con lo stesso daemon: un'app nativa per Android e iPhone, e
una web app servita dal bridge.

---

## Bridge

Il daemon espone l'API REST, lo streaming WebSocket e la web app.

1. Avvia il server con un doppio clic su [start_bridge.bat](start_bridge.bat).
2. Dal browser del telefono, sulla stessa rete, apri `http://<ip-del-pc>:43737`.

Il bridge dialoga con Herdr attraverso la named pipe `%APPDATA%\herdr\herdr.sock`.

---

## App

Il progetto React Native si trova in [app/](app/).

Sviluppo con Expo Go:

```bash
cd app
bun x expo start
```

L'indirizzo del bridge si imposta dall'app, dal badge di stato in alto a destra,
e viene ricordato tra un avvio e l'altro.

---

## Installare l'app

Ogni versione è una [release su GitHub](../../releases/latest) con due pacchetti
e le loro impronte sha256.

### Android

Scarica `HerdrMobile-x.y.z-arm64.apk` e aprilo. La prima volta Android chiede di
permettere l'installazione da questa origine; sopra una versione precedente si
installa come aggiornamento, senza perdere le impostazioni. Da lì in poi l'app si
aggiorna da sola attraverso il bridge (vedi sotto).

### iPhone

Scarica `HerdrMobile-x.y.z-ios.ipa`. Apple non permette di aprire un IPA sul
telefono e installarlo: va firmato con un Apple ID, e la firma si fa da un
computer.

Con un Apple ID normale, gratis:

1. Sul computer installa [Sideloadly](https://sideloadly.io) (Windows o Mac). Su
   Windows servono iTunes e iCloud nelle versioni scaricate dal sito Apple, non
   quelle del Microsoft Store.
2. Collega l'iPhone con il cavo, trascina l'IPA su Sideloadly e inserisci il tuo
   Apple ID: serve solo a firmare, e la firma resta sul tuo computer.
3. Sull'iPhone, in Impostazioni → Generali → VPN e gestione dispositivo, dai
   fiducia allo sviluppatore che compare, cioè il tuo Apple ID. Se il telefono lo
   chiede, attiva anche la Modalità sviluppatore in Privacy e sicurezza.

L'app così firmata funziona per sette giorni, con al massimo tre app firmate in
questo modo alla volta; ricollegando il telefono Sideloadly la rinnova, e può
farlo da solo via Wi-Fi. Una versione nuova si installa come la prima.
[AltStore](https://altstore.io) fa la stessa cosa.

Con un [Apple Developer Program](https://developer.apple.com/programs/) (99 dollari
l'anno) il workflow iOS può firmare da solo: l'IPA dura un anno, oppure va su
TestFlight e gli amici lo installano da un link, con gli aggiornamenti automatici.
I segreti da impostare sono elencati in [CI/CD](#cicd).

---

## Release e aggiornamenti

Non c'è uno store tra il PC e il telefono: le release le pubblica lo script, il
bridge le offre, l'app le scarica e le passa all'installatore di Android.

Per pubblicare una versione:

```bash
node release.mjs --bump patch --notes "Cosa è cambiato"
```

Lo script alza `version`, `android.versionCode` e `ios.buildNumber` in
`app/app.json` e in `app/android/app/build.gradle` (il codice cresce di uno a ogni
release ed è l'unico numero che l'app confronta), compila l'APK arm64 con Gradle
in locale, lo firma con la chiave di release (vedi [Firma e sicurezza](#firma-e-sicurezza)),
lo copia in `releases/` con nome versionato, dimensione, md5 e sha256, e scrive
`releases/latest.json`, più lo storico in `releases/storico.json`. Se la build
fallisce, i file di versione tornano com'erano. Con `--bump minor` o `--major`
cambia il salto, con `--version 1.2.0` lo imposti a mano, con `--skip-build`
ripubblichi ciò che Gradle ha già prodotto. Una sola build: i telefoni sono tutti
arm64. L'universale serve solo all'emulatore x86 del PC e si aggiunge con
`--varianti arm64,universale`.

In `releases/` resta solo il pacchetto dell'ultima versione: l'app chiede sempre e
solo quella, e ogni pacchetto pesa decine di megabyte. Con `--conserva 2` restano
anche i due precedenti. Lo storico conserva ogni voce con le proprie impronte, così
una build vecchia si riconosce anche dopo che il file è sparito.

Ogni release finisce in un commit con il tag `v1.2.0`, e il commit viene spinto su
GitHub insieme a una release che porta l'APK arm64 e le note: il pacchetto che gira
su un telefono risale ai sorgenti esatti che l'hanno prodotto, e da lì si
ricostruisce. Il commit prende tutto ciò che c'è nell'albero di lavoro, quindi si
pubblica quando il lavoro è finito. `--no-publish` si ferma al commit e al tag;
`--no-commit` lascia git in pace. Per la release su GitHub serve la
[CLI `gh`](https://cli.github.com) con il login fatto. Alla pubblicazione parte il
workflow iOS, che entro mezz'ora allega l'IPA alla stessa release.

Anche `app/android/` è versionato: non è più solo generato da Expo, perché
contiene la schermata di avvio, le icone e il permesso di installazione fatti a
mano. `app/ios/` invece no: lo genera il runner macOS da `app.json` a ogni build.

Niente passa da Expo o da EAS: la build Android è Gradle sul PC, quella iOS è Xcode
su GitHub Actions, senza limiti di piano.

Il bridge risponde su `/api/app/latest` con la descrizione dell'ultima release e su
`/app/<file>` con il pacchetto. `/download/apk` continua a esistere e dà l'ultima
arm64.

Sul telefono Android, ogni volta che la connessione sale, e quando l'app torna in
primo piano se l'ultimo controllo ha più di cinque minuti, l'app chiede al bridge
se c'è una versione con codice più alto del proprio. Se c'è, sotto l'intestazione
compare una riga con la versione, le note e la dimensione. Niente viene scaricato
finché non tocchi **Aggiorna**: il pacchetto è di decine di megabyte e il telefono
può essere in rete mobile. Il pacchetto scelto è quello arm64 se è l'architettura
principale del dispositivo, altrimenti l'universale (un emulatore x86 dichiara
arm64 come secondaria, ma non lo esegue davvero); viene scaricato nella cache con
la barra di avanzamento, confrontato con l'md5 pubblicato e poi aperto
nell'installatore di sistema, che chiede conferma. La prima volta Android chiede
anche di permettere a Herdr Mobile di installare app: è la sua regola per tutto ciò
che non viene dallo store. **Più tardi** nasconde la riga fino al prossimo avvio.

Nel pannello **Connessione**, sotto host e porta, c'è la versione installata e
l'esito dell'ultimo controllo: sei aggiornato e a che ora, oppure quale versione è
disponibile, oppure che il bridge non risponde. **Cerca aggiornamenti** chiede
subito, senza aspettare l'ora, e riporta in vista un avviso rimandato con Più
tardi; quando c'è una versione nuova lo stesso controllo diventa **Aggiorna**. Al
primo avvio dopo un aggiornamento l'app dice a quale versione è passata.

Su iPhone l'app non può installare nulla: il pannello mostra la versione e ricorda
che le nuove arrivano da GitHub, e la riga di aggiornamento non compare mai.

---

## CI/CD

Due workflow in [.github/workflows](.github/workflows):

- **Controlli** (`ci.yml`), a ogni push e pull request: i tipi dell'app con
  `tsc` e la sintassi del bridge. Niente build native qui.
- **iOS** (`ios.yml`), alla pubblicazione di una release: su un runner macOS
  installa le dipendenze con il lockfile bloccato, genera `app/ios/` da
  `app.json`, installa i Pod, compila con Xcode e allega alla release l'IPA con la
  sua impronta sha256. Lo stesso IPA resta anche come artefatto del workflow per
  trenta giorni. Ci vogliono venti o trenta minuti. Si rilancia a mano da
  Actions → iOS → Run workflow, indicando il tag della release a cui allegare il
  risultato, o senza tag per avere solo l'artefatto.

Il repository è pubblico e i runner standard sono gratuiti. Se diventasse privato,
ogni minuto macOS vale dieci minuti del piano: duemila minuti al mese bastano per
otto o dieci build iOS.

Senza segreti l'IPA esce non firmato. Con un Apple Developer Program si impostano
questi segreti nel repository e la build viene firmata da Xcode, che crea da sé i
profili:

| Segreto | Contenuto |
| --- | --- |
| `IOS_CERT_P12` | certificato Apple Distribution esportato in `.p12`, in base64 |
| `IOS_CERT_PASSWORD` | la password di quel `.p12` |
| `IOS_TEAM_ID` | il Team ID del Developer Program |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` | una chiave API di App Store Connect (ruolo App Manager), il `.p8` in base64 |
| `IOS_EXPORT_METHOD` | `app-store-connect` (predefinito: carica su TestFlight) oppure `ad-hoc` (allega l'IPA firmato per i dispositivi registrati) |

Questa parte del workflow è predisposta ma non ancora esercitata: la prima build
firmata è quella che la collauda.

---

## Firma e sicurezza

**La chiave Android** sta in `~/.herdr-mobile/` (oppure nella cartella indicata
da `HERDR_MOBILE_KEYS`): `release.keystore`, `keystore.properties` con percorsi,
alias e password, e `firma.lineage`. Nulla di questo è nel repository, e
`release.mjs` si rifiuta di partire se non la trova. Va salvata altrove, con
cura: senza quella chiave nessuna build futura verrebbe accettata dai telefoni
come aggiornamento, e l'app andrebbe reinstallata da zero.

**La rotazione.** Fino alla 1.1.10 i pacchetti erano firmati con la chiave di
debug del template React Native, che è pubblica. Dalla 1.2.0 la firma è la chiave
propria, e il pacchetto porta la catena di rotazione: Android 9 e successivi
verificano la chiave nuova e accettano l'aggiornamento sopra una build vecchia,
mentre un pacchetto firmato solo con la chiave di debug non viene più accettato
come aggiornamento, perché alla vecchia chiave non è concessa la capacità di
rollback. `apksigner verify --print-certs -v` mostra entrambe le firme.

**Nel repository pubblico non ci sono** chiavi, password, indirizzi, né i
pacchetti compilati: `releases/` e ogni `.apk` e `.ipa` sono ignorati.
`app/android/app/debug.keystore` è quello del template, identico in ogni progetto
React Native. GitHub tiene attivo il secret scanning sui repository pubblici.

**I workflow** girano con i permessi minimi (`contents: read`; `write` solo nel
job che allega l'IPA alla release), scaricano il codice senza lasciare credenziali
nel checkout, e usano action bloccate a un commit preciso, non a un tag mobile;
Dependabot propone gli avanzamenti in pull request. Le dipendenze dell'app si
installano con il lockfile bloccato.

**Le impronte.** Le note di ogni release riportano lo sha256 dell'APK, e accanto
all'IPA c'è il suo file `.sha256`. L'app verifica l'md5 del pacchetto che scarica
dal bridge prima di passarlo all'installatore.

**Il bridge** non ha un'autenticazione propria: si fida della rete in cui sta, la
LAN di casa o una VPN come Tailscale. Non va esposto su Internet. Serve file solo
sotto il profilo utente e nelle cartelle di lavoro delle finestre aperte, e su
iPhone la connessione in chiaro verso il PC è concessa esplicitamente
nell'`Info.plist`, perché quel traffico non esce mai dalla rete privata.

---

## Funzionalità

- **Spazi e schede**: elenco dei workspace aperti sul PC con il ramo git, creazione
  di nuovi spazi e schede, spostamento del focus della finestra Herdr.
- **Agenti**: elenco degli agenti attivi con il relativo stato, con salto diretto
  alla finestra che li ospita.
- **Terminale**: output in tempo reale via WebSocket, link toccabili, ritorno a capo
  disattivabile per non spezzare l'output formattato, scorrimento che segue le novità
  solo quando sei già in fondo.
- **Composer**: invio di comandi e prompt, cronologia, allegati caricati sul PC,
  tasti `Esc`, `^C`, `Invio`, `Tab` e `Clear`.
- **Finestre**: divisione a destra o in basso, vista affiancata o singola, chiusura,
  tutto dal menu della scheda.

---

## Struttura

- [bridge/bridge.py](bridge/bridge.py): daemon FastAPI, WebSocket e web app.
- [release.mjs](release.mjs): pubblica una release (vedi sopra).
- [logo.mjs](logo.mjs): disegna il logo (il chevron di Herdr in dithering ordinato, matrice di Bayer 8×8 su una griglia di 32 celle) e scrive tutte le misure per Android e per gli asset Expo.
- [.github/workflows](.github/workflows): controlli e build iOS.
- `app/App.tsx`: composizione della schermata e stato della selezione.
- `app/src/updates.ts`: versione installata, scelta del pacchetto, scaricamento verificato, installatore.
- `app/src/theme.ts`: token di colore, spaziatura e tipografia.
- `app/src/errors.ts`: i modi in cui il bridge può fallire, come dati anziché eccezioni.
- `app/src/api.ts`: client REST del bridge, con timeout su ogni chiamata.
- `app/src/storage.ts`: impostazioni di connessione salvate su file.
- `app/src/ansi.ts`: pulizia dell'output, composizione dei paragrafi, link.
- `app/src/history.ts`: la trascrizione di un agente, in turni.
- `app/src/hooks/`: sessione WebSocket, geometria di sistema (inset, tastiera), aggiornamenti, cronologia.
- `app/src/components/`: header, avviso di aggiornamento, schede, pannello laterale, terminale, cronologia, file, composer, overlay.
- `app/src/icons.tsx`: icone disegnate con `View`, senza font né glifi.

---

## Come viene mostrato l'output

Lo schermo è una superficie di lettura, non una console. L'output del terminale
arriva grezzo e viene giudicato riga per riga: le frasi sono composte in un
carattere proporzionale con grazie, alla dimensione a cui si legge un testo, e i
paragrafi che il terminale aveva spezzato alla propria larghezza vengono
ricomposti. Tabelle, alberi e comandi restano a spaziatura fissa, perché lì il
significato sta nell'allineamento. Le righe in cui l'agente riferisce di sé
stesso sono presenti ma smorzate.

I messaggi che hai inviato, che l'interfaccia desktop rimanda indietro con il
proprio marcatore davanti, sono mostrati come il tuo turno della conversazione:
a destra, in una forma propria, senza il marcatore.

Il prompt e la barra di stato dell'interfaccia desktop non vengono mostrati:
l'app ha già un proprio campo di scrittura e una propria intestazione, e
tenerne due copie riempiva lo schermo di un telefono senza aggiungere nulla.

---

## Quanto indietro si scorre

Per una shell, tutto ciò che Herdr conserva: mille righe di scrollback, che il
bridge chiede per intero a ogni lettura.

Per la finestra di un agente il terminale non basta: l'interfaccia di Claude
Code ridisegna lo schermo sul posto e non lascia scrollback, quindi Herdr ha
solo l'ultima schermata. La conversazione sta nella trascrizione che Claude
Code scrive mentre lavora, in `~/.claude/projects`, e il bridge la legge da lì:
risale al file dall'id di sessione che l'agente riporta a Herdr, oppure dal
processo in primo piano nella finestra (Claude Code lascia una nota per
processo in `~/.claude/sessions`), oppure, non trovando né l'uno né l'altro,
prende la trascrizione più recente della cartella e lo dice. Il file viene
letto in modo incrementale, solo la coda nuova a ogni richiesta, e i risultati
dei tool, che sono il grosso del peso, non vengono nemmeno analizzati.

Nell'app, in cima allo schermo di un agente, una riga offre di caricare la
cronologia. Caricata, si scorre verso l'alto: i tuoi messaggi a destra, le
risposte in prosa con i blocchi di codice a spaziatura fissa, i tool come una
riga smorzata, i file nominati come miniature e schede. Dove Claude Code ha
compattato il contesto, il riassunto che si scrive da solo (pagine di markdown
archiviate come se le avessi mandate tu) non compare: al suo posto una riga
dice che da lì l'agente ricorda solo un riepilogo. La cronologia si ferma
dove comincia lo schermo, riconoscendo sullo schermo l'ultimo messaggio che hai
mandato, e cresce con la sessione. Lo schermo resta al suo posto quando la
cronologia compare sopra di lui.

---

## Immagini e file nella sessione

Il terminale nomina i file per percorso, e basta: uno screenshot fatto
dall'agente, un pacchetto compilato, un allegato che gli hai mandato. L'app
riconosce quei percorsi nel testo e chiede al bridge se esistono nella cartella
di lavoro della finestra. Se un percorso non porta a nulla non occupa spazio.

Se il file è un'immagine, sotto la riga compare una miniatura, ridotta dal
bridge per non scaricare screenshot interi: toccala per vederla a schermo
intero e da lì condividerla. Se è un file da consegnare (APK, PDF, ZIP, CSV,
documenti, audio, video) compare una scheda con il tipo, il nome e la
dimensione: toccala per scaricarlo e aprirlo con l'app che il telefono ha per
quel tipo; su Android un'APK finisce nell'installatore, e se nulla lo apre
compare il foglio di condivisione, che su iPhone è la via per ogni file. I
sorgenti non diventano schede, altrimenti ogni modifica che l'agente riferisce
arriverebbe con una scheda accanto.

Gli allegati che scegli tu compaiono nel composer come miniature, con la X per
toglierli prima dell'invio, e se ne possono allegare più d'uno alla volta. Una
volta inviati stanno accanto al tuo messaggio, a destra, al posto del
riferimento `@uploads/…` che il testo conteneva.

Il bridge serve solo file sotto il tuo profilo utente o nelle cartelle di lavoro
delle finestre aperte. Non è una barriera verso il telefono, che può già
scrivere qualunque comando in qualunque terminale: evita che un percorso capitato
in un output trasformi il bridge in un file server per tutto il disco.

---

## Effect

L'app è scritta con [Effect](https://effect.website). Il bridge resta Python.

Ogni chiamata al bridge dichiara nel proprio tipo come può fallire, e l'unico punto
che mostra un errore all'utente è obbligato dal compilatore a coprirli tutti. Nessun
`catch` silenzioso.

La sessione WebSocket è un ambito: socket, coda in ingresso, coda in uscita, ping e
watchdog vengono acquisiti insieme e chiusi insieme, anche quando un tentativo muore
a metà. La riconnessione è una politica dichiarata, non una catena di timer, e la
lista delle finestre sottoscritte viene rimandata da sola a ogni riapertura.
