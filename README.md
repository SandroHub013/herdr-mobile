# Herdr Mobile

A remote control for [Herdr](https://github.com/herdrdev/herdr), the workspace
and AI agent manager for Windows. From a phone you see the workspaces open on
your PC, read the terminals as they run, send prompts and keystrokes to the
agents, attach photos, and pull back the files they produce.

Two clients talk to the same PC: a native app for Android and iPhone, and a web
app served by the bridge for any browser.

---

## How it works

```
phone ── Tailscale / LAN ──> bridge (Python, port 43737) ── named pipe ──> Herdr
```

- **The bridge** runs on the PC next to Herdr. It talks to Herdr through the
  named pipe `%APPDATA%\herdr\herdr.sock` and exposes a REST API, a WebSocket
  stream and the web app.
- **The app** connects to the bridge with a host, a port and a token, and
  remembers them.

Nothing goes through a cloud service. The bridge listens on your Tailscale
address by default and asks for a token on every request.

---

## Setup

### Requirements

- Windows with [Herdr](https://github.com/herdrdev/herdr) installed.
- [Python](https://www.python.org) 3.11 or newer.
- [Tailscale](https://tailscale.com) on the PC and on the phone. This is what
  lets the phone reach the PC from anywhere, and what keeps everyone else out.
  On a home network you can do without it, see `--lan` below.

To build the app yourself or publish releases you also need Node 20 or newer,
[Bun](https://bun.sh), a JDK 17 and the Android SDK, and the
[GitHub CLI](https://cli.github.com). Nothing goes through Expo's cloud or EAS.

### 1. The bridge

```bash
git clone https://github.com/SandroHub013/herdr-mobile.git
cd herdr-mobile
pip install -r bridge/requirements.txt
start_bridge.bat
```

The bridge prints where it listens and the token:

```
  Listening on  http://100.x.y.z:43737  (Tailscale only; --lan also serves the local network)
  Token         k3J9...
  Token file    C:\Users\you\.herdr-mobile\bridge.token
```

The token is created on the first start and kept in `~/.herdr-mobile/bridge.token`
(or in the folder named by `HERDR_MOBILE_KEYS`). Delete the file to get a new
one, or set `HERDR_BRIDGE_TOKEN` to choose your own.

| Option | Effect |
| --- | --- |
| none | listens on the Tailscale address only; without Tailscale, on this PC only |
| `--lan` | listens on every interface, the home network included |
| `--host <ip>` | listens on that address |

The `.bat` passes its arguments through: `start_bridge.bat --lan`.

### 2. The phone

Install the app (see [Installing the app](#installing-the-app)), then tap the
status badge in the top right corner to open the **Connessione** panel and
enter:

- **Host**: the PC's Tailscale address, the one the bridge printed.
- **Porta**: `43737`.
- **Token**: the token the bridge printed.

The three are saved on the phone. If the bridge rejects the token, the app
says so and offers the panel again.

The web app works the same way: open `http://<host>:43737` in the phone's
browser, enter the token once, and the browser keeps it.

The app's interface is in Italian.

### 3. Tailscale ACL, optional

Tailscale already limits the bridge to the devices of your tailnet. If other
people or machines share it, an ACL keeps port 43737 for your phone alone.
In the [admin console](https://login.tailscale.com/admin/acls), assuming the
PC is tagged `tag:pc` and the phone `tag:phone`:

```json
{
  "acls": [
    { "action": "accept", "src": ["tag:phone"], "dst": ["tag:pc:43737"] }
  ]
}
```

---

## Security

**What the token protects.** Every API call and the WebSocket stream: reading
terminals, sending text and keys, opening workspaces, uploading and downloading
files. The app sends it in the `X-Herdr-Token` header and as the first message
on the socket; a wrong or missing token gets `401` on HTTP and close code
`4401` on the socket. Comparison is constant-time.

**What is reachable without it.** The web app shell and its static files, and
the release packages: `/api/app/latest`, `/app/<file>`, `/download/apk`. Those
packages are public on GitHub anyway, and keeping them open lets a phone with
an older build see the update that brings it up to date.

**Where the bridge listens.** On the Tailscale address by default, so nothing
on the home network sees the port, and never on the Internet. `--lan` is a
choice you make. Whoever can reach the port and knows the token can drive
Herdr as you: type in any terminal, run any command. Treat the token like a
password to the PC.

**Files.** The bridge serves files only under your user profile or in the
working folders of the open windows. A path that happens to appear in some
output cannot turn the bridge into a file server for the whole disk.

**Nothing private in the repository.** Signing keys, passwords, tokens,
addresses and built packages are all outside it: `~/.herdr-mobile/` holds the
keys, `releases/` and every `.apk` and `.ipa` are ignored, and GitHub's secret
scanning is on. `app/android/app/debug.keystore` is the React Native template
key, identical in every project.

**Workflows.** Minimal permissions (`contents: read`, `write` only in the job
that attaches the IPA to a release), no credentials left in the checkout,
actions pinned to a commit rather than a moving tag, Dependabot proposing the
bumps as pull requests, dependencies installed from the locked lockfile.

**Checksums.** Every release lists the sha256 of its APK, and the IPA comes with
a `.sha256` file next to it. The app checks the md5 of a package it downloads
from the bridge before handing it to the installer.

**iPhone.** Plain HTTP to the PC is allowed explicitly in `Info.plist`, because
that traffic never leaves the private network.

---

## Installing the app

Every version is a [GitHub release](../../releases/latest) with two packages
and their sha256 checksums.

### Android

Download `HerdrMobile-x.y.z-arm64.apk` and open it. The first time, Android
asks to allow installs from this source; over a previous version it installs
as an update and keeps the settings. From then on the app updates itself
through the bridge, see [Releases and updates](#releases-and-updates).

### iPhone

Download `HerdrMobile-x.y.z-ios.ipa`. Apple does not let you open an IPA on the
phone and install it: it has to be signed with an Apple ID, from a computer.

With an ordinary Apple ID, free of charge:

1. On the computer install [Sideloadly](https://sideloadly.io) (Windows or
   Mac). On Windows it needs iTunes and iCloud in the versions downloaded from
   Apple's site, not the Microsoft Store ones.
2. Plug the iPhone in, drag the IPA onto Sideloadly and enter your Apple ID.
   It is used only to sign, and the signature stays on your computer.
3. On the iPhone, in Settings → General → VPN & Device Management, trust the
   developer that appears, which is your Apple ID. If the phone asks, also turn
   on Developer Mode under Privacy & Security.

An app signed this way runs for seven days, with at most three such apps at a
time; plugging the phone in again renews it, and Sideloadly can do that on its
own over Wi-Fi. A new version installs like the first one.
[AltStore](https://altstore.io) does the same.

With an [Apple Developer Program](https://developer.apple.com/programs/)
membership (99 dollars a year) the iOS workflow can sign by itself: the IPA
lasts a year, or goes to TestFlight and friends install it from a link, with
automatic updates. The secrets to set are listed under [CI/CD](#cicd).

---

## Releases and updates

There is no store between the PC and the phone: a script publishes releases,
the bridge offers them, the app downloads them and hands them to Android's
installer.

### Signing key, once

```bash
node release.mjs --setup-keys
```

This creates `~/.herdr-mobile/release.keystore` (RSA 4096, random password)
and `keystore.properties` next to it, which the script reads. Back that folder
up somewhere safe: without the key no future build will install over the ones
already on phones, and the app would have to be reinstalled from scratch.

If your earlier builds were signed with another key, add a rotation lineage so
phones accept the new key as an update. With the template debug key as the old
signer:

```bash
apksigner rotate --out ~/.herdr-mobile/signing.lineage \
  --old-signer --ks app/android/app/debug.keystore --ks-key-alias androiddebugkey \
  --new-signer --ks ~/.herdr-mobile/release.keystore --ks-key-alias herdr
```

then add `lineage=<path to signing.lineage>` to `keystore.properties`. The
script signs with the debug key first and the release key next, and the old
key is granted no rollback capability: from then on a package signed only with
the debug key is no longer accepted as an update. Android 9 and later verify
the new key; `apksigner verify --print-certs -v` shows both signatures.

### Publishing a version

```bash
node release.mjs --bump patch --notes "What changed"
```

The script raises `version`, `android.versionCode` and `ios.buildNumber` in
`app/app.json` and in `app/android/app/build.gradle` (the code grows by one on
every release and is the only number the app compares), builds the arm64 APK
with Gradle on the PC, signs it with the release key, copies it into
`releases/` under a versioned name with size, md5 and sha256, and writes
`releases/latest.json` plus the log in `releases/history.json`. If the build
fails, the version files go back to what they were. `--bump minor` or `major`
change the step, `--version 1.2.0` sets it by hand, `--skip-build` republishes
what Gradle already built. One build: phones are all arm64. The universal
build only serves the PC's x86 emulator and is added with
`--variants arm64,universal`.

Only the latest package stays in `releases/`: the app only ever asks for that
one, and each weighs tens of megabytes. `--keep 2` keeps the two previous
ones too. The history keeps every entry with its checksums, so an old build
can be recognised after its file is gone.

Every release becomes a commit tagged `v1.2.0`, pushed to GitHub together with
a release carrying the arm64 APK and the notes: the package running on a phone
traces back to the exact sources that produced it. The commit takes everything
in the working tree, so publish when the work is done. `--no-publish` stops at
the commit and the tag; `--no-commit` leaves git alone. The GitHub release
needs the `gh` CLI logged in. Publishing starts the iOS workflow, which
attaches the IPA to the same release within half an hour.

`app/android/` is versioned too: it is no longer just generated by Expo,
because it holds the hand-made splash screen, icons and install permission.
`app/ios/` is not: the macOS runner generates it from `app.json` on every
build.

### Updates on the phone

The bridge answers `/api/app/latest` with the latest release and `/app/<file>`
with the package. `/download/apk` still exists and serves the latest arm64.

On Android, every time the connection comes up, and when the app returns to
the foreground if the last check is older than five minutes, the app asks the
bridge whether there is a version with a higher code than its own. If so, a
line under the header shows version, notes and size. Nothing is downloaded
until you tap **Aggiorna**: the package is tens of megabytes and the phone may
be on mobile data. The package chosen is the arm64 one when that is the
device's main architecture, the universal one otherwise (an x86 emulator
declares arm64 as secondary but does not really run it); it goes to the cache
with a progress bar, is checked against the published md5 and then opened in
the system installer, which asks for confirmation. The first time Android also
asks to let Herdr Mobile install apps, its rule for anything outside the store.
**Più tardi** hides the line until the next launch.

In the **Connessione** panel, under host, port and token, the installed
version and the outcome of the last check: up to date and since when, or which
version is available, or that the bridge does not answer. **Cerca
aggiornamenti** asks right away and brings back a notice dismissed with Più
tardi; when a new version exists the same control becomes **Aggiorna**. On the
first launch after an update the app says which version it moved to.

On iPhone the app cannot install anything: the panel shows the version and
reminds that new ones come from GitHub, and the update line never appears.

---

## CI/CD

Two workflows in [.github/workflows](.github/workflows):

- **Checks** (`ci.yml`), on every push and pull request: the app's types with
  `tsc` and the bridge's syntax. No native builds here.
- **iOS** (`ios.yml`), when a release is published: on a macOS runner it
  installs the dependencies from the locked lockfile, generates `app/ios/` from
  `app.json`, installs the Pods, builds with Xcode and attaches the IPA with its
  sha256 to the release. The same IPA stays as a workflow artifact for thirty
  days. It takes twenty to thirty minutes. Run it by hand from Actions → iOS →
  Run workflow, giving the tag of the release to attach the result to, or no
  tag to get only the artifact.

The repository is public and the standard runners are free. In a private one
each macOS minute counts ten minutes of the plan: two thousand a month cover
eight to ten iOS builds.

Without secrets the IPA comes out unsigned. With an Apple Developer Program,
set these repository secrets and Xcode signs the build, creating the profiles
itself:

| Secret | Content |
| --- | --- |
| `IOS_CERT_P12` | Apple Distribution certificate exported as `.p12`, base64 |
| `IOS_CERT_PASSWORD` | the password of that `.p12` |
| `IOS_TEAM_ID` | the Developer Program's Team ID |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` | an App Store Connect API key (App Manager role), the `.p8` in base64 |
| `IOS_EXPORT_METHOD` | `app-store-connect` (default: uploads to TestFlight) or `ad-hoc` (attaches the signed IPA for registered devices) |

This part of the workflow is in place but has not been exercised yet: the
first signed build is the one that tests it.

---

## Features

- **Workspaces and tabs**: the workspaces open on the PC with their git branch,
  new workspaces and tabs, moving the focus of the Herdr window.
- **Agents**: the running agents with their state, and a jump to the window
  hosting each.
- **Terminal**: live output over WebSocket, tappable links, word wrap you can
  turn off so formatted output is not broken, scrolling that follows the new
  lines only when you are already at the bottom.
- **Composer**: commands and prompts, history, attachments uploaded to the PC,
  the `Esc`, `^C`, `Invio`, `Tab` and `Clear` keys.
- **Windows**: split right or down, side by side or single view, close, all
  from the tab menu.

---

## Development

```bash
cd app
bun install
bun x expo start
```

Expo Go on the phone scans the QR code. A local Android build:

```bash
cd app/android
gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

`start_mobile_app.bat` starts the dev server from the root.

---

## Layout

- [bridge/bridge.py](bridge/bridge.py): FastAPI daemon, WebSocket and web app.
- [release.mjs](release.mjs): publishes a release (see above).
- [logo.mjs](logo.mjs): draws the logo (Herdr's chevron in ordered dithering, an 8×8 Bayer matrix on a 32-cell grid) and writes every size for Android and for Expo's assets.
- [.github/workflows](.github/workflows): checks and the iOS build.
- `app/App.tsx`: screen composition and selection state.
- `app/src/updates.ts`: installed version, package choice, verified download, installer.
- `app/src/theme.ts`: colour, spacing and typography tokens.
- `app/src/errors.ts`: the ways the bridge can fail, as data rather than exceptions.
- `app/src/api.ts`: the bridge's REST client, with a timeout on every call and the token on every request.
- `app/src/storage.ts`: connection settings saved to a file.
- `app/src/ansi.ts`: output cleanup, paragraph composition, links.
- `app/src/history.ts`: an agent's transcript, in turns.
- `app/src/hooks/`: WebSocket session, system geometry (insets, keyboard), updates, history.
- `app/src/components/`: header, update notice, tabs, side panel, terminal, history, files, composer, overlays.
- `app/src/icons.tsx`: icons drawn with `View`, no font and no glyphs.

---

## How output is shown

The screen is a reading surface, not a console. Terminal output arrives raw and
is judged line by line: sentences are set in a proportional serif face at a
size you read text at, and paragraphs the terminal had broken at its own width
are put back together. Tables, trees and commands stay monospaced, because
there the meaning is in the alignment. Lines where the agent reports on itself
are present but dimmed.

The messages you sent, which the desktop interface echoes back with its own
marker in front, are shown as your turn in the conversation: on the right, in
their own shape, without the marker.

The desktop interface's prompt and status bar are not shown: the app already
has its own input field and its own header, and two copies filled a phone
screen without adding anything.

---

## How far back you can scroll

For a shell, everything Herdr keeps: a thousand lines of scrollback, which the
bridge asks for in full on every read.

For an agent's window the terminal is not enough: Claude Code's interface
redraws the screen in place and leaves no scrollback, so Herdr only has the
last screen. The conversation lives in the transcript Claude Code writes as it
works, under `~/.claude/projects`, and the bridge reads it from there: it finds
the file from the session id the agent reports to Herdr, or from the foreground
process in the window (Claude Code leaves a note per process in
`~/.claude/sessions`), or, finding neither, takes the folder's most recent
transcript and says so. The file is read incrementally, only the new tail on
each request, and tool results, which are most of the weight, are not even
parsed.

In the app, at the top of an agent's screen, a line offers to load the history.
Loaded, it scrolls upwards: your messages on the right, the replies as prose
with monospaced code blocks, tools as a dimmed line, named files as thumbnails
and cards. Where Claude Code compacted its context, the summary it writes to
itself (pages of markdown filed as if you had sent them) does not appear: in
its place a line says that from there on the agent only remembers a summary.
The history stops where the screen begins, by recognising on the screen the
last message you sent, and grows with the session. The screen stays put when
the history appears above it.

---

## Images and files in the session

The terminal names files by path, and that is all: a screenshot the agent took,
a built package, an attachment you sent it. The app recognises those paths in
the text and asks the bridge whether they exist in the window's working folder.
A path that leads nowhere takes no space.

If the file is an image, a thumbnail appears under the line, reduced by the
bridge so full screenshots are not downloaded: tap it to see it full screen and
share it from there. If it is a file to hand over (APK, PDF, ZIP, CSV,
documents, audio, video) a card appears with type, name and size: tap it to
download it and open it with whatever the phone has for that type; on Android
an APK goes to the installer, and if nothing opens it the share sheet appears,
which on iPhone is the way for every file. Source files do not become cards,
otherwise every edit the agent reports would come with a card next to it.

The attachments you pick appear in the composer as thumbnails, with an X to
remove them before sending, and more than one can be attached at a time. Once
sent they sit next to your message, on the right, in place of the
`@uploads/…` reference the text contained.

---

## Effect

The app is written with [Effect](https://effect.website). The bridge stays
Python.

Every call to the bridge declares in its type how it can fail, and the one
place that shows an error to the user is forced by the compiler to cover them
all. No silent `catch`.

The WebSocket session is a scope: socket, inbound queue, outbound queue, ping
and watchdog are acquired together and released together, even when an attempt
dies halfway. Reconnection is a declared policy, not a chain of timers, and the
list of subscribed windows is sent again by itself on every reopen.

---

## License

[MIT](LICENSE).
