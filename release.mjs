#!/usr/bin/env node
/**
 * Publishes a release of Herdr Mobile.
 *
 *   node release.mjs --bump patch --notes "Cosa è cambiato"
 *   node release.mjs --version 1.2.0 --notes "..."
 *   node release.mjs --bump patch --varianti arm64,universale   # also the emulator build
 *   node release.mjs --bump patch --skip-build                  # re-publish what is already built
 *   node release.mjs --bump patch --conserva 2                  # keep the two previous packages too
 *   node release.mjs --bump patch --no-commit                   # leave git alone (implies --no-publish)
 *   node release.mjs --bump patch --no-publish                  # commit and tag, but do not push or open a GitHub release
 *
 * What it does, in order:
 *   1. bumps `expo.version`, `expo.android.versionCode` and `expo.ios.buildNumber`
 *      in app/app.json and in the native build.gradle (the version code is
 *      what the app compares, so it always grows by one);
 *   2. builds the release APK with Gradle: arm64 only, which is every phone;
 *      the universal build exists for the x86 emulator and is opt-in;
 *   3. signs it with the release key kept outside the repository, carrying
 *      the rotation lineage so phones that got an earlier build accept it;
 *   4. copies it into releases/ under a versioned name, with size, md5 and sha256;
 *   5. writes releases/latest.json, which the bridge serves to the app, and
 *      appends the same entry to releases/storico.json;
 *   6. removes the packages of older releases, since the app only ever asks
 *      for the latest and each one weighs tens of megabytes;
 *   7. commits the repository and tags the commit `v<version>`, so the
 *      package on a phone can be traced to its sources and rebuilt from them;
 *   8. pushes and opens the GitHub release with the arm64 APK attached. The
 *      iOS workflow starts from that release and attaches the IPA next to it.
 *
 * If a build fails, app.json and build.gradle are put back the way they were.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(ROOT, 'app');
const ANDROID_DIR = join(APP_DIR, 'android');
const APP_JSON = join(APP_DIR, 'app.json');
/**
 * The native project is checked in, so Gradle reads the version from here and
 * not from app.json. Both are kept in step: app.json for Expo, this for the
 * package Android actually installs and compares.
 */
const BUILD_GRADLE = join(APP_DIR, 'android', 'app', 'build.gradle');
const BUILT_APK = join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const SIGNED_APK = join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-firmata.apk');
/** The key of the React Native template, which every build before 1.2.0 was signed with. */
const DEBUG_KEYSTORE = join(ANDROID_DIR, 'app', 'debug.keystore');
const RELEASES_DIR = join(ROOT, 'releases');
const LATEST = join(RELEASES_DIR, 'latest.json');
const HISTORY = join(RELEASES_DIR, 'storico.json');
/** Where the signing key lives: never inside the repository. */
const KEYS_DIR = process.env.HERDR_MOBILE_KEYS ?? join(homedir(), '.herdr-mobile');
const KEYS_FILE = join(KEYS_DIR, 'keystore.properties');

const VARIANTS = {
  arm64: { key: 'arm64-v8a', gradleArgs: ['-PreactNativeArchitectures=arm64-v8a'], published: true },
  universale: { key: 'universal', gradleArgs: [], published: false },
};
const DEFAULT_VARIANTS = ['arm64'];

// ------------------------------------------------------------------ arguments

function parseArgs(argv) {
  const args = {
    bump: null,
    version: null,
    notes: '',
    skipBuild: false,
    variants: DEFAULT_VARIANTS,
    keep: 0,
    commit: true,
    publish: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--bump') args.bump = next();
    else if (arg === '--version') args.version = next();
    else if (arg === '--notes') args.notes = next() ?? '';
    else if (arg === '--skip-build') args.skipBuild = true;
    else if (arg === '--varianti') args.variants = (next() ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    else if (arg === '--conserva') args.keep = Number(next());
    else if (arg === '--no-commit') args.commit = false;
    else if (arg === '--no-publish') args.publish = false;
    else fail(`argomento sconosciuto: ${arg}`);
  }
  if (!args.bump && !args.version) args.bump = 'patch';
  if (args.bump && !['patch', 'minor', 'major'].includes(args.bump)) fail(`--bump vuole patch, minor o major, non "${args.bump}"`);
  if (args.version && !/^\d+\.\d+\.\d+$/.test(args.version)) fail(`--version vuole x.y.z, non "${args.version}"`);
  if (args.variants.length === 0) fail('--varianti vuole almeno una variante');
  if (!Number.isInteger(args.keep) || args.keep < 0) fail('--conserva vuole quante release precedenti tenere, un intero da 0 in su');
  for (const name of args.variants) {
    if (!VARIANTS[name]) fail(`--varianti accetta ${Object.keys(VARIANTS).join(' e ')}, non "${name}"`);
  }
  if (!args.commit) args.publish = false;
  return args;
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

// ------------------------------------------------------------------- version

function bumpVersion(current, bump) {
  const [major, minor, patch] = current.split('.').map((n) => Number(n) || 0);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function readAppConfig() {
  const raw = readFileSync(APP_JSON, 'utf8');
  return { raw, config: JSON.parse(raw) };
}

function writeAppConfig(config) {
  writeFileSync(APP_JSON, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function writeGradleVersion(original, version, versionCode) {
  const withCode = original.replace(/(\bversionCode\s+)\d+/, `$1${versionCode}`);
  const withName = withCode.replace(/(\bversionName\s+)"[^"]*"/, `$1"${version}"`);
  if (withName === original) throw new Error(`versionCode/versionName non trovati in ${BUILD_GRADLE}`);
  writeFileSync(BUILD_GRADLE, withName, 'utf8');
}

// ------------------------------------------------------------------ commands

const quote = (arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

/**
 * Runs a program and waits. A .bat needs a shell, and the shell does not look
 * in the working directory for it, so on Windows the command is one quoted
 * line; anywhere else the arguments go straight through.
 */
function run(file, args, options = {}) {
  const viaShell = process.platform === 'win32' && /\.(bat|cmd)$/i.test(file);
  const result = viaShell
    ? spawnSync([file, ...args].map(quote).join(' '), { shell: true, encoding: 'utf8', ...options })
    : spawnSync(file, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

// --------------------------------------------------------------------- build

function build(variant) {
  const gradle = join(ANDROID_DIR, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const args = ['assembleRelease', '--console=plain', '-q', ...variant.gradleArgs];
  console.log(`\n> gradlew ${args.join(' ')}`);
  const result = run(gradle, args, { cwd: ANDROID_DIR, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Gradle ha fallito (${result.status})`);
  if (!existsSync(BUILT_APK)) throw new Error(`Gradle non ha prodotto ${BUILT_APK}`);
}

// ------------------------------------------------------------------- signing

/** The release key: path, passwords, alias and the rotation lineage, from a file outside the repository. */
function signingKeys() {
  if (!existsSync(KEYS_FILE)) {
    throw new Error(`chiave di firma non trovata: manca ${KEYS_FILE} (README, "Firma e sicurezza")`);
  }
  const keys = Object.fromEntries(
    readFileSync(KEYS_FILE, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith('#'))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
  for (const field of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword', 'lineage']) {
    if (!keys[field]) throw new Error(`${KEYS_FILE}: manca ${field}`);
  }
  for (const path of [keys.storeFile, keys.lineage]) {
    if (!existsSync(path)) throw new Error(`file di firma non trovato: ${path}`);
  }
  return keys;
}

/** apksigner from the newest build-tools of the SDK Gradle uses. */
function apksignerPath() {
  const fromLocal = () => {
    const local = join(ANDROID_DIR, 'local.properties');
    if (!existsSync(local)) return null;
    const match = /^sdk\.dir=(.+)$/m.exec(readFileSync(local, 'utf8'));
    return match ? match[1].trim().replace(/\\\\/g, '\\').replace(/\\:/g, ':') : null;
  };
  const sdk =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    fromLocal() ??
    (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null);
  if (!sdk || !existsSync(join(sdk, 'build-tools'))) throw new Error('SDK Android non trovato: imposta ANDROID_HOME');
  const versions = readdirSync(join(sdk, 'build-tools'))
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => {
      const [x, y] = [a, b].map((v) => v.split('.').map(Number));
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
  if (versions.length === 0) throw new Error(`nessuna build-tools in ${sdk}`);
  return join(sdk, 'build-tools', versions[versions.length - 1], process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
}

/**
 * Signs the package with the release key.
 *
 * Signers go oldest first: the template's debug key, which every build up to
 * 1.1.10 carried, then the release key, with the lineage that proves the
 * rotation. Android 9 and later verify the new key and accept the update over
 * an old build; older devices keep verifying the old one. The passwords travel
 * in the environment, not on the command line.
 */
function sign(input, output, keys) {
  const apksigner = apksignerPath();
  if (existsSync(output)) unlinkSync(output);
  const args = [
    'sign',
    '--lineage', keys.lineage,
    '--rotation-min-sdk-version', '28',
    '--v1-signing-enabled', 'false',
    '--out', output,
    '--ks', DEBUG_KEYSTORE, '--ks-pass', 'pass:android', '--ks-key-alias', 'androiddebugkey', '--key-pass', 'pass:android',
    '--next-signer',
    '--ks', keys.storeFile, '--ks-pass', 'env:HERDR_STORE_PASS', '--ks-key-alias', keys.keyAlias, '--key-pass', 'env:HERDR_KEY_PASS',
    input,
  ];
  const env = { ...process.env, HERDR_STORE_PASS: keys.storePassword, HERDR_KEY_PASS: keys.keyPassword };
  const signed = run(apksigner, args, { env, stdio: 'inherit' });
  if (signed.status !== 0) throw new Error(`apksigner ha fallito (${signed.status})`);
  const verified = run(apksigner, ['verify', '--print-certs', output]);
  if (verified.status !== 0) throw new Error(`firma non valida: ${verified.stderr || verified.stdout}`);
  if (!existsSync(output)) throw new Error(`apksigner non ha prodotto ${output}`);
}

function digest(algorithm, path) {
  return createHash(algorithm).update(readFileSync(path)).digest('hex');
}

function publishApk(version, name, sourcePath) {
  const file = `HerdrMobile-${version}-${name}.apk`;
  const target = join(RELEASES_DIR, file);
  copyFileSync(sourcePath, target);
  return { file, size: statSync(target).size, md5: digest('md5', target), sha256: digest('sha256', target) };
}

// ------------------------------------------------------------------- pruning

/**
 * Removes the packages of every release older than the ones being kept: the
 * newest and `keep` before it. The app only ever asks for the latest, and
 * each package is tens of megabytes. The history keeps every entry, md5
 * included, so an old build in someone's hands can still be recognised
 * after its file is gone; the build itself comes back from its tag.
 */
function pruneReleases(history, keep) {
  const kept = new Set(history.slice(0, keep + 1).flatMap((entry) => Object.values(entry.apks).map((apk) => apk.file)));
  for (const file of readdirSync(RELEASES_DIR)) {
    if (!/^HerdrMobile-.+\.apk$/.test(file) || kept.has(file)) continue;
    unlinkSync(join(RELEASES_DIR, file));
    console.log(`rimossa ${file}`);
  }
}

// ----------------------------------------------------------------------- git

function git(args) {
  return run('git', args, { cwd: APP_DIR });
}

/**
 * Records the release as a commit tagged with its version. Everything in
 * the working tree goes in: the version files the script just changed and
 * whatever the release was made of.
 */
function commitRelease(version, notes) {
  if (git(['rev-parse', '--is-inside-work-tree']).status !== 0) {
    console.log('nessun repository git: release non committata');
    return false;
  }
  const add = git(['add', '-A']);
  if (add.status !== 0) throw new Error(`git add: ${add.stderr.trim()}`);
  const message = notes ? `Release ${version}\n\n${notes}` : `Release ${version}`;
  const commit = git(['commit', '-q', '-m', message]);
  if (commit.status !== 0) throw new Error(`git commit: ${(commit.stderr || commit.stdout).trim()}`);
  const tag = git(['tag', '-a', `v${version}`, '-m', `Herdr Mobile ${version}`]);
  if (tag.status !== 0) throw new Error(`git tag: ${tag.stderr.trim()}`);
  console.log(`commit con tag v${version}`);
  return true;
}

// -------------------------------------------------------------------- GitHub

const formatSize = (bytes) => `${(bytes / 1048576).toFixed(1).replace('.', ',')} MB`;

/**
 * Pushes the commit and the tag and opens the release on GitHub with the
 * phone package attached. The iOS workflow listens for exactly this event
 * and adds the IPA once its build is done.
 */
function publishOnGitHub(version, release) {
  if (git(['remote', 'get-url', 'origin']).status !== 0) {
    console.log('nessun remote origin: release non pubblicata su GitHub');
    return;
  }
  for (const ref of ['HEAD', `refs/tags/v${version}`]) {
    const push = git(['push', 'origin', ref]);
    if (push.status !== 0) throw new Error(`git push ${ref}: ${push.stderr.trim()}`);
  }
  const assets = Object.entries(release.apks)
    .filter(([key]) => Object.values(VARIANTS).some((variant) => variant.key === key && variant.published))
    .map(([, apk]) => apk);
  const lines = [
    release.notes || `Herdr Mobile ${version}.`,
    '',
    '### Pacchetti',
    '',
    ...assets.map((apk) => `- \`${apk.file}\`, ${formatSize(apk.size)}, sha256 \`${apk.sha256}\``),
    "- l'IPA per iPhone arriva da solo entro mezz'ora, compilato dal workflow iOS, con la propria impronta accanto",
    '',
    'Android: scarica l\'APK e aprilo; sopra una versione precedente si installa come aggiornamento.',
    'iPhone: vedi il README, sezione "iPhone".',
  ];
  const notesFile = join(tmpdir(), `herdr-mobile-${version}.md`);
  writeFileSync(notesFile, `${lines.join('\n')}\n`, 'utf8');
  const gh = run(
    'gh',
    ['release', 'create', `v${version}`, '--verify-tag', '--title', `Herdr Mobile ${version}`, '--notes-file', notesFile, ...assets.map((apk) => join(RELEASES_DIR, apk.file))],
    { cwd: APP_DIR },
  );
  unlinkSync(notesFile);
  if (gh.status !== 0) throw new Error(`gh release create: ${(gh.stderr || gh.stdout).trim()}`);
  console.log(`release GitHub aperta: ${gh.stdout.trim()}`);
}

// ---------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const { raw: originalAppJson, config } = readAppConfig();

const previousVersion = config.expo.version ?? '0.0.0';
const previousCode = Number(config.expo.android?.versionCode ?? 1);
const version = args.version ?? bumpVersion(previousVersion, args.bump);
const versionCode = previousCode + 1;

// The key is checked before anything is built or changed: a missing key is
// the one failure that should cost nothing.
let keys;
try {
  keys = signingKeys();
} catch (error) {
  fail(error.message);
}

const originalGradle = readFileSync(BUILD_GRADLE, 'utf8');
config.expo.version = version;
config.expo.android = { ...(config.expo.android ?? {}), versionCode };
config.expo.ios = { ...(config.expo.ios ?? {}), buildNumber: String(versionCode) };
writeAppConfig(config);
writeGradleVersion(originalGradle, version, versionCode);
console.log(`versione ${previousVersion} (${previousCode}) -> ${version} (${versionCode})`);

mkdirSync(RELEASES_DIR, { recursive: true });

const apks = {};

try {
  for (const name of args.variants) {
    const variant = VARIANTS[name];
    if (!args.skipBuild) build(variant);
    else if (!existsSync(BUILT_APK)) throw new Error(`--skip-build ma ${BUILT_APK} non esiste`);
    sign(BUILT_APK, SIGNED_APK, keys);
    apks[variant.key] = publishApk(version, name, SIGNED_APK);
    console.log(`pubblicata ${apks[variant.key].file} (${formatSize(apks[variant.key].size)})`);
  }
} catch (error) {
  writeFileSync(APP_JSON, originalAppJson, 'utf8');
  writeFileSync(BUILD_GRADLE, originalGradle, 'utf8');
  console.error(`\nrelease interrotta: ${error.message}\napp.json e build.gradle ripristinati a ${previousVersion} (${previousCode})`);
  process.exit(1);
}

const release = {
  version,
  versionCode,
  date: new Date().toISOString(),
  notes: args.notes,
  apks,
};

writeFileSync(LATEST, `${JSON.stringify(release, null, 2)}\n`, 'utf8');
const history = existsSync(HISTORY) ? JSON.parse(readFileSync(HISTORY, 'utf8')) : [];
history.unshift(release);
writeFileSync(HISTORY, `${JSON.stringify(history, null, 2)}\n`, 'utf8');

pruneReleases(history, args.keep);

let committed = false;
if (args.commit) {
  try {
    committed = commitRelease(version, args.notes);
  } catch (error) {
    console.error(`\nrelease pubblicata ma non committata: ${error.message}`);
    process.exit(1);
  }
}

if (args.publish && committed) {
  try {
    publishOnGitHub(version, release);
  } catch (error) {
    console.error(`\nrelease committata ma non pubblicata su GitHub: ${error.message}`);
    process.exit(1);
  }
}

console.log(`\nrelease ${version} (${versionCode}) pronta in releases/latest.json`);
console.log('il bridge la offre in /api/app/latest; il telefono la vede alla prossima connessione');
