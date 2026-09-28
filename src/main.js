// VideoCutter — processus principal Electron.
// Toute la logique de téléchargement tourne ici ; la fenêtre ne communique
// qu'à travers quelques appels IPC strictement validés (voir preload.js).

const { app, BrowserWindow, ipcMain, shell, session, protocol, dialog, Menu, net, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");

// ---------------------------------------------------------------------------
// Constantes et chemins
// ---------------------------------------------------------------------------

const APP_ORIGIN = "app://videocutter";
const RENDERER_DIR = path.join(__dirname, "renderer");
const BUNDLED_BIN = app.isPackaged ? path.join(process.resourcesPath, "bin") : path.join(__dirname, "..", "vendor");
const USER_BIN = path.join(app.getPath("userData"), "bin");       // copie de yt-dlp modifiable (mises à jour)
const YTDLP_DIR = path.join(USER_BIN, "yt-dlp");
const YTDLP = path.join(YTDLP_DIR, "yt-dlp.exe");
const BUNDLED_YTDLP_DIR = path.join(BUNDLED_BIN, "yt-dlp");
const TEMP_ROOT = path.join(app.getPath("temp"), "videocutter");
const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");
const CACHE_DIR = path.join(app.getPath("userData"), "cache");     // cache yt-dlp (accélère les appels suivants)
const FFMPEG_DIR = BUNDLED_BIN;
const MAX_PARALLEL = 3;
const TERMS_VERSION = "1"; // à incrémenter si le texte des conditions change : elles seront redemandées
const DEV_LOG = !app.isPackaged && process.env.VIDEOCUTTER_DEBUG === "1";
const SYS32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
const TAR = path.join(SYS32, "tar.exe");           // chemins absolus : pas de détournement via le PATH
const TASKKILL = path.join(SYS32, "taskkill.exe");
const UPDATE_EVERY_MS = 24 * 3600 * 1000;
const YTDLP_REPO = "https://github.com/yt-dlp/yt-dlp/releases";

const AUDIO_FORMATS = {
  mp3:  { codec: "mp3",    thumb: true },
  m4a:  { codec: "m4a",    thumb: true },
  wav:  { codec: "wav",    thumb: false },
  flac: { codec: "flac",   thumb: true },
  ogg:  { codec: "vorbis", thumb: true },
  opus: { codec: "opus",   thumb: true },
};
const VIDEO_FORMATS = new Set(["mp4", "mkv", "webm", "mov", "avi"]);

// Options communes : on ignore toute configuration/plugin externe à l'appli,
// et yt-dlp utilise le moteur Node intégré à Electron pour les défis JS de YouTube.
const BASE_ARGS = [
  "--ignore-config", "--no-plugin-dirs", "--no-update",
  "--no-js-runtimes", "--js-runtimes", `node:${process.execPath}`,
  "--ffmpeg-location", FFMPEG_DIR,
  "--cache-dir", CACHE_DIR,
  "--no-playlist", "--no-colors", "--encoding", "utf-8",
];
const CHILD_ENV = {
  SystemRoot: process.env.SystemRoot, windir: process.env.windir,
  TEMP: TEMP_ROOT, TMP: TEMP_ROOT,
  PATH: [FFMPEG_DIR, SYS32].join(path.delimiter),
  ELECTRON_RUN_AS_NODE: "1",
  PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1",
};

// ---------------------------------------------------------------------------
// Réglages (dossier de destination)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Historique des téléchargements (fichier local uniquement, effaçable depuis l'appli)
// ---------------------------------------------------------------------------
const HISTORY_FILE = path.join(app.getPath("userData"), "history.json");
const MAX_HISTORY = 100;
let history = null;
function loadHistory() {
  if (history) return history;
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); if (!Array.isArray(history)) history = []; }
  catch { history = []; }
  return history;
}
function saveHistory() { try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); } catch {} }
function addHistory(e) {
  loadHistory().unshift({ id: require("crypto").randomUUID(), date: new Date().toISOString(), ...e });
  history = history.slice(0, MAX_HISTORY);
  saveHistory();
  mainWindow?.webContents.send("history-changed");
}
function historyView() {
  return loadHistory().map(h => ({
    id: h.id, date: h.date, title: String(h.title || ""), site: String(h.site || ""), url: String(h.url || ""),
    format: String(h.format || ""), crop: h.crop || null, segments: h.segments || 1, merged: !!h.merged,
    count: (h.files || []).length, exists: (h.files || []).some(f => typeof f === "string" && fs.existsSync(f)),
  }));
}

const isDir = p => { try { return typeof p === "string" && path.isAbsolute(p) && fs.statSync(p).isDirectory(); } catch { return false; } };

// Ancien nom de l'appli ("Découpeur YouTube") : on récupère ses réglages une fois, puis on supprime son dossier.
function migrateOldData() {
  const oldDir = path.join(app.getPath("appData"), "Découpeur YouTube");
  if (!fs.existsSync(oldDir) || path.resolve(oldDir) === path.resolve(app.getPath("userData"))) return;
  try {
    const oldSettings = path.join(oldDir, "settings.json");
    if (!fs.existsSync(SETTINGS_FILE) && fs.existsSync(oldSettings)) {
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      fs.copyFileSync(oldSettings, SETTINGS_FILE);
    }
    fs.rmSync(oldDir, { recursive: true, force: true });
    if (DEV_LOG) console.log("[migration] ancien dossier supprimé");
  } catch (e) { if (DEV_LOG) console.log("[migration] échec", e.code, e.path, e.message); }
  fs.rm(path.join(app.getPath("temp"), "decoupeur-youtube"), { recursive: true, force: true }, () => {});
}

function loadSettings() {
  const s = { downloadDir: app.getPath("downloads"), lastUpdateCheck: 0 };
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    if (isDir(saved.downloadDir)) s.downloadDir = saved.downloadDir;
    if (Number.isFinite(saved.lastUpdateCheck)) s.lastUpdateCheck = saved.lastUpdateCheck;
    if (saved.terms && typeof saved.terms.version === "string") s.terms = { version: saved.terms.version, acceptedAt: String(saved.terms.acceptedAt || "") };
  } catch {}
  return s;
}
let settings;
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch {}
}

// ---------------------------------------------------------------------------
// Validation des entrées venant de la fenêtre
// ---------------------------------------------------------------------------

// Adresses du réseau local / de la machine : refusées (l'appli ne sert qu'aux sites Internet).
function isPrivateHost(host) {
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".") && !host.includes(":")) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (host.includes(":")) return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("::ffff:");
  return false;
}

// Accepte tout lien http(s) public ; renvoie l'URL normalisée ou null.
function validateUrl(input) {
  if (typeof input !== "string" || input.length > 2048) return null;
  let s = input.trim();
  if (!s || /[\s\u0000-\u001f]/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || isPrivateHost(u.hostname)) return null;
  return u.toString();
}
const finite = (n, d = NaN) => (typeof n === "number" && Number.isFinite(n) ? n : d);

// Seuls les messages de notre propre page sont acceptés.
function trusted(event) {
  const frame = event.senderFrame;
  return !!frame && frame === mainWindow?.webContents.mainFrame && frame.url.startsWith(APP_ORIGIN + "/");
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error("Refusé");
    return fn(...args);
  });
}

// ---------------------------------------------------------------------------
// yt-dlp : installation de la copie modifiable + mise à jour automatique
// ---------------------------------------------------------------------------

function run(args, { timeout = 60000 } = {}) {
  return new Promise(resolve => {
    execFile(YTDLP, args, { env: CHILD_ENV, windowsHide: true, cwd: TEMP_ROOT, timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || "", stderr: stderr || "" }));
  });
}

async function ytdlpVersion(file = YTDLP) {
  return new Promise(resolve => execFile(file, ["--version"], { env: CHILD_ENV, windowsHide: true, timeout: 20000 },
    (err, out) => resolve(err ? null : String(out).trim())));
}

function cleanTemp() {
  // Supprime les restes de téléchargements annulés ou interrompus (les dossiers encore utilisés sont ignorés).
  let entries = [];
  try { entries = fs.readdirSync(TEMP_ROOT); } catch {}
  const active = new Set([...jobs.values()].filter(j => j.status === "running").map(j => path.basename(j.tempDir)));
  for (const e of entries) if (!active.has(e)) fs.rm(path.join(TEMP_ROOT, e), { recursive: true, force: true }, () => {});
}

async function ensureYtdlp() {
  fs.mkdirSync(USER_BIN, { recursive: true });
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  for (const leftover of ["yt-dlp-new", "yt-dlp-old", "yt-dlp.exe"]) fs.rmSync(path.join(USER_BIN, leftover), { recursive: true, force: true });
  const current = fs.existsSync(YTDLP) ? await ytdlpVersion(YTDLP) : null;
  const shipped = await ytdlpVersion(path.join(BUNDLED_YTDLP_DIR, "yt-dlp.exe"));
  // Copie la version fournie si aucune n'est installée, si elle est cassée, ou si elle est plus récente.
  if (!current || (shipped && shipped > current)) {
    fs.rmSync(YTDLP_DIR, { recursive: true, force: true });
    fs.cpSync(BUNDLED_YTDLP_DIR, YTDLP_DIR, { recursive: true });
  }
}

// Mise à jour de yt-dlp : téléchargement depuis la page officielle GitHub (HTTPS),
// vérification de l'empreinte SHA-256 publiée, test du nouvel exécutable, puis échange.
async function fetchBuf(url, maxBytes) {
  const r = await net.fetch(url, { redirect: "follow", headers: { "User-Agent": "videocutter", Accept: "*/*" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const finalHost = new URL(r.url || url).hostname; // r.url est vide quand il n'y a pas eu de redirection
  if (!/(^|\.)github\.com$|(^|\.)githubusercontent\.com$/.test(finalHost)) throw new Error("Redirection inattendue");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error("Fichier trop gros");
  return buf;
}

async function installYtdlpUpdate() {
  let tag;
  try { tag = JSON.parse((await fetchBuf("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest", 1e6)).toString("utf8")).tag_name; }
  catch (e) { throw new Error("impossible de joindre GitHub (" + e.message + ")"); }
  if (typeof tag !== "string" || !/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(tag)) throw new Error("version introuvable");
  const current = await ytdlpVersion();
  const forceForTest = !app.isPackaged && process.env.VIDEOCUTTER_TEST_UPDATE === "1";
  if (current && current >= tag && !forceForTest) return { updated: false, version: current };

  const sums = (await fetchBuf(`${YTDLP_REPO}/download/${tag}/SHA2-256SUMS`, 1e6)).toString("utf8");
  const line = sums.split(/\r?\n/).find(l => /\s\*?yt-dlp_win\.zip$/.test(l.trim()));
  const expected = line && line.trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected || "")) throw new Error("Empreinte introuvable");
  const zip = await fetchBuf(`${YTDLP_REPO}/download/${tag}/yt-dlp_win.zip`, 200 * 1048576);
  if (require("crypto").createHash("sha256").update(zip).digest("hex") !== expected) throw new Error("Empreinte incorrecte");

  const zipFile = path.join(USER_BIN, "yt-dlp_win.zip");
  const newDir = path.join(USER_BIN, "yt-dlp-new"), oldDir = path.join(USER_BIN, "yt-dlp-old");
  fs.rmSync(newDir, { recursive: true, force: true });
  fs.mkdirSync(newDir);
  fs.writeFileSync(zipFile, zip);
  try {
    await new Promise((res, rej) => execFile(TAR, ["-xf", zipFile, "-C", newDir], { windowsHide: true, timeout: 120000 }, e => (e ? rej(e) : res())));
  } finally { fs.rmSync(zipFile, { force: true }); }
  const v = await ytdlpVersion(path.join(newDir, "yt-dlp.exe"));
  if (v !== tag) { fs.rmSync(newDir, { recursive: true, force: true }); throw new Error("Nouvelle version inutilisable"); }

  fs.rmSync(oldDir, { recursive: true, force: true });
  fs.renameSync(YTDLP_DIR, oldDir);
  try { fs.renameSync(newDir, YTDLP_DIR); } catch (e) { fs.renameSync(oldDir, YTDLP_DIR); throw e; }
  fs.rm(oldDir, { recursive: true, force: true }, () => {});
  return { updated: true, version: tag };
}

let ready = new Promise(() => {}); // remplacé au démarrage par la préparation de yt-dlp
let updating = null;
async function updateYtdlp(force = false) {
  if (updating) return updating;
  if (!force && Date.now() - (settings.lastUpdateCheck || 0) < UPDATE_EVERY_MS) return { skipped: true };
  if ([...jobs.values()].some(j => j.status === "running")) return { busy: true };
  updating = (async () => {
    try {
      const r = await installYtdlpUpdate();
      settings.lastUpdateCheck = Date.now(); saveSettings();
      return { updated: r.updated, after: r.version };
    } catch (e) {
      return { error: "La mise à jour a échoué : " + e.message };
    }
  })().finally(() => { updating = null; });
  return updating;
}

// ---------------------------------------------------------------------------
// Lecture des infos d'une vidéo
// ---------------------------------------------------------------------------

function cleanError(stderr) {
  const lines = stderr.split(/\r?\n/).filter(l => l.includes("ERROR"))
    .map(l => l.replace(/^.*ERROR:\s*(\[[^\]]+\]\s*[\w-]+:\s*)?/, "").trim());
  const msg = lines.join("\n");
  if (/ip address is blocked|blocked from accessing|your ip/i.test(msg)) return "Le site bloque les téléchargements depuis ta connexion (adresse IP). Réessaie plus tard ou depuis une autre connexion.";
  if (/unable to obtain file audio codec|does not contain any (audio )?stream|no audio/i.test(msg)) return "Cette vidéo n'a pas de son : impossible d'en faire un fichier audio.";
  if (/unsupported url|no video (could be |was )?found|no media found|there'?s no video|no video formats found|not a video/i.test(msg)) return "Aucune vidéo trouvée à ce lien (page sans vidéo ou site non pris en charge).";
  if (/sign in to confirm your age|age-restricted|age restricted/i.test(msg)) return "Cette vidéo est soumise à une limite d'âge : impossible de la télécharger sans être connecté.";
  if (/login|log in|sign in|logged-in|authenticat|cookies|members only|subscriber|empty media response|rate-limit reached|requires an account/i.test(msg)) return "Ce contenu demande d'être connecté au site (compte privé, réservé aux membres, ou le site bloque les visiteurs anonymes).";
  if (/private/i.test(msg)) return "Cette vidéo est privée.";
  if (/429|too many requests/i.test(msg)) return "Le site limite les téléchargements pour le moment. Réessaie dans quelques minutes.";
  if (/geo|not available in your country|region/i.test(msg)) return "Cette vidéo n'est pas disponible depuis ton pays.";
  if (/unavailable|removed|not available|does not exist|404/i.test(msg)) return "Cette vidéo est indisponible (supprimée, privée ou bloquée).";
  if (/getaddrinfo|resolve|network|timed? ?out|connection|unable to download webpage/i.test(msg)) return "Impossible de joindre le site. Vérifie le lien et ta connexion Internet.";
  return msg.slice(0, 400) || "Impossible de lire cette vidéo.";
}

// Infos des vidéos chargées, gardées côté moteur : la fenêtre ne manipule qu'un jeton.
const infos = new Map();
const MAX_INFOS = 30;
const httpUrl = s => { try { const u = new URL(s); return (u.protocol === "https:" || u.protocol === "http:") && !isPrivateHost(u.hostname) ? u.toString() : null; } catch { return null; } };

// En-têtes HTTP à rejouer pour l'aperçu (ceux que le site exige), limités au latin-1.
function safeHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (typeof v === "string" && /^[\w-]+$/.test(k) && /^[\x20-\xff]*$/.test(v) && !/^(host|content-length|connection)$/i.test(k)) out[k] = v;
  }
  return out;
}

// Choisit un format lisible directement par la fenêtre pour l'aperçu (fichier unique, ≤ 720p).
// Préférence : image + son ; à défaut image seule (suffit pour choisir où couper).
const has = (codec) => codec !== "none";          // undefined = inconnu, considéré comme présent
function pickPreview(formats, hasVideo) {
  const direct = (formats || []).filter(f => /^https?$/.test(f.protocol || "") && httpUrl(f.url));
  let ok;
  if (hasVideo) {
    const vids = direct.filter(f => has(f.vcodec) && /^(mp4|webm)$/.test(f.ext) && !(f.vcodec === undefined && f.acodec !== "none" && !f.height && f.format_note === "audio only"));
    ok = vids.filter(f => has(f.acodec));
    if (!ok.length) ok = vids;
  } else {
    ok = direct.filter(f => has(f.acodec) && /^(m4a|mp3|mp4|webm|ogg|opus)$/.test(f.ext));
  }
  if (!ok.length) return null;
  const h = f => f.height || 360;
  const score = f => (hasVideo ? (h(f) <= 720 ? h(f) : -h(f)) + (has(f.acodec) && f.acodec ? 0.5 : 0) : (f.abr || f.tbr || 0));
  const f = ok.sort((a, b) => score(b) - score(a))[0];
  const headers = safeHeaders(f.http_headers);
  if (typeof f.cookies === "string" && /^[\x20-\xff]*$/.test(f.cookies)) {
    headers.Cookie = f.cookies.split(";").map(c => c.trim()).filter(c => /^[^=]+=/.test(c)).map(c => c.replace(/;?\s*(Domain|Path|Expires|Max-Age|Secure|HttpOnly)=?[^;]*/gi, "")).join("; ");
  }
  return { url: httpUrl(f.url), headers };
}

// Mesure la durée avec ffprobe quand le site ne la fournit pas.
function probeDuration(src) {
  if (!src) return Promise.resolve(null);
  const hdr = Object.entries(src.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  const args = ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "-rw_timeout", "10000000",
    "-protocol_whitelist", "https,http,tls,tcp,crypto"];
  if (hdr) args.push("-headers", hdr);
  args.push(src.url);
  return new Promise(resolve => execFile(path.join(FFMPEG_DIR, "ffprobe.exe"), args, { env: CHILD_ENV, windowsHide: true, timeout: 15000 },
    (err, out) => { const d = parseFloat(String(out).trim()); resolve(!err && d > 0 && Number.isFinite(d) ? d : null); }));
}

// ---------------------------------------------------------------------------
// Connexions aux sites : session séparée du navigateur, cookies chiffrés par Electron.
// Seuls les cookies du site concerné sont transmis à yt-dlp, dans un fichier temporaire.
// ---------------------------------------------------------------------------

const LOGIN_PARTITION = "persist:connexions";
let loginSession = null;
const LOGIN_PRESETS = {
  instagram: "https://www.instagram.com/accounts/login/",
  x: "https://x.com/i/flow/login",
  vimeo: "https://vimeo.com/log_in",
  tiktok: "https://www.tiktok.com/login",
  facebook: "https://www.facebook.com/login",
  reddit: "https://www.reddit.com/login/",
  youtube: "https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/",
};
const DOMAIN_ALIASES = { "x.com": ["twitter.com"], "twitter.com": ["x.com"], "youtube.com": ["google.com"], "youtu.be": ["youtube.com", "google.com"] };

function baseDomain(host) {
  const p = String(host).toLowerCase().replace(/^\.+/, "").split(".");
  if (p.length >= 3 && /^(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/.test(p.slice(-2).join("."))) return p.slice(-3).join(".");
  return p.slice(-2).join(".");
}
const isLoginError = msg => /login|log in|sign in|logged-in|authenticat|cookies|members only|subscriber|empty media response|rate-limit reached|requires an account|age/i.test(msg);

async function cookieFileFor(url) {
  if (!loginSession) return null;
  let host; try { host = new URL(url).hostname; } catch { return null; }
  const base = baseDomain(host);
  const bases = [base, ...(DOMAIN_ALIASES[base] || [])];
  const all = await loginSession.cookies.get({});
  const mine = all.filter(c => { const d = c.domain.replace(/^\./, "").toLowerCase(); return bases.some(b => d === b || d.endsWith("." + b)); })
    .filter(c => !/[\t\r\n]/.test(c.name + c.value + c.path + c.domain));
  if (!mine.length) return null;
  const lines = mine.map(c => {
    const dom = c.hostOnly ? c.domain.replace(/^\./, "") : "." + c.domain.replace(/^\./, "");
    return [dom, c.hostOnly ? "FALSE" : "TRUE", c.path || "/", c.secure ? "TRUE" : "FALSE", Math.floor(c.expirationDate || 0), c.name, c.value].join("\t");
  });
  const file = path.join(TEMP_ROOT, `c-${require("crypto").randomUUID()}.txt`);
  fs.writeFileSync(file, "# Netscape HTTP Cookie File\n" + lines.join("\n") + "\n", { mode: 0o600 });
  return file;
}
const dropFile = f => f && fs.rm(f, { force: true }, () => {});

async function loginList() {
  if (!loginSession) return [];
  const groups = new Map();
  for (const c of await loginSession.cookies.get({})) {
    const b = baseDomain(c.domain);
    groups.set(b, (groups.get(b) || 0) + 1);
  }
  return [...groups.entries()].map(([domain, count]) => ({ domain, count })).sort((a, b) => a.domain.localeCompare(b.domain));
}

async function loginForget(domain) {
  if (!loginSession || typeof domain !== "string") return;
  for (const c of await loginSession.cookies.get({})) {
    if (baseDomain(c.domain) !== domain) continue;
    const host = c.domain.replace(/^\./, "");
    await loginSession.cookies.remove(`http${c.secure ? "s" : ""}://${host}${c.path || "/"}`, c.name).catch(() => {});
  }
  await loginSession.cookies.flushStore().catch(() => {});
}

function openLoginWindow(target) {
  const url = LOGIN_PRESETS[target] || validateUrl(target);
  if (!url || !mainWindow) return false;
  const win = new BrowserWindow({
    parent: mainWindow, width: 1000, height: 820, autoHideMenuBar: true,
    title: "Connexion — " + new URL(url).hostname, backgroundColor: "#ffffff",
    webPreferences: { partition: LOGIN_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged },
  });
  win.on("page-title-updated", e => e.preventDefault());
  win.on("closed", async () => { await loginSession?.cookies.flushStore().catch(() => {}); mainWindow?.webContents.send("login-changed"); });
  win.loadURL(url);
  return true;
}

const SITE_NAMES = { Youtube: "YouTube", Twitter: "X (Twitter)", Instagram: "Instagram", TikTok: "TikTok", Dailymotion: "Dailymotion", Vimeo: "Vimeo", Facebook: "Facebook", Reddit: "Reddit", TwitchClips: "Twitch", TwitchVod: "Twitch", Soundcloud: "SoundCloud", Generic: "Page web" };

const termsAccepted = () => settings?.terms?.version === TERMS_VERSION;
const TERMS_ERROR = { error: "Accepte les conditions d'utilisation pour utiliser VideoCutter." };

async function getInfo(url) {
  if (!termsAccepted()) return TERMS_ERROR;
  const link = validateUrl(url);
  if (!link) return { error: "Ce n'est pas un lien valide.\nColle l'adresse complète d'une vidéo (elle commence par https://…)." };
  await ready;
  if (updating) await updating;
  const infoArgs = extra => [...BASE_ARGS, "--no-warnings", "--socket-timeout", "15", "--playlist-items", "1", "-J", ...extra, "--", link];
  let r = await run(infoArgs([]), { timeout: 60000 });
  let useCookies = false;
  // Le site exige une connexion : nouvel essai avec les cookies de CE site uniquement (s'il y en a)
  if (r.err && !r.err.killed && isLoginError(r.stderr)) {
    const cf = await cookieFileFor(link);
    if (!cf) return { error: cleanError(r.stderr) + "\nConnecte-toi à ce site dans l'appli, puis réessaie.", loginUrl: link };
    try { r = await run(infoArgs(["--cookies", cf]), { timeout: 60000 }); } finally { dropFile(cf); }
    useCookies = true;
    if (r.err && !r.err.killed && isLoginError(r.stderr)) return { error: cleanError(r.stderr) + "\nTa connexion à ce site ne suffit pas (ou a expiré) : reconnecte-toi.", loginUrl: link };
  }
  if (r.err?.killed) return { error: "Le site met trop de temps à répondre. Réessaie." };
  if (r.err) return { error: cleanError(r.stderr) };
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { error: "Réponse illisible de yt-dlp." }; }
  if (j._type === "playlist") j = (j.entries || []).find(Boolean);
  if (!j || j._type === "url" || (!j.formats?.length && !j.url)) return { error: "Aucune vidéo trouvée à ce lien (page sans vidéo ou site non pris en charge)." };

  const formats = j.formats || [j];
  const hasVideo = formats.some(f => f.vcodec && f.vcodec !== "none") || (!!j.vcodec && j.vcodec !== "none") || (j.width > 0)
    || formats.some(f => f.vcodec === undefined && /^(mp4|webm|mov|flv)$/.test(f.ext));
  const hasAudio = formats.some(f => f.acodec !== "none");
  const isYouTube = j.extractor_key === "Youtube" && /^[A-Za-z0-9_-]{11}$/.test(j.id || "");
  const preview = isYouTube ? null : pickPreview(formats, hasVideo);
  let duration = finite(j.duration) > 0 ? j.duration : Math.max(0, ...formats.map(f => finite(f.duration, 0))) || null;
  if (!duration && !j.is_live) duration = await probeDuration(preview);
  const heights = [...new Set(formats.filter(f => f.vcodec !== "none" && f.height > 0).map(f => Math.round(f.height)))].sort((a, b) => b - a);
  const token = require("crypto").randomUUID();
  const title = String(j.title || j.id || "Vidéo").slice(0, 300);
  const site = SITE_NAMES[j.extractor_key] || String(j.extractor_key || j.extractor || "").replace(/[^\w .-]/g, "");
  const entry = {
    title, site,
    url: httpUrl(j.webpage_url) || link, duration, hasVideo, hasAudio, preview, heights, useCookies,
    thumb: httpUrl(j.thumbnail) ? { url: httpUrl(j.thumbnail), headers: {} } : null,
  };
  infos.set(token, entry);
  while (infos.size > MAX_INFOS) infos.delete(infos.keys().next().value);

  return {
    token, title, channel: String(j.channel || j.uploader || ""), site, url: entry.url,
    width: finite(j.width, 0) || null, height: finite(j.height, 0) || null,
    duration, isLive: !!j.is_live, hasVideo, hasAudio, heights, loggedIn: useCookies,
    youtubeId: isYouTube ? j.id : null, preview: !!entry.preview, thumb: !!entry.thumb,
  };
}

// ---------------------------------------------------------------------------
// Téléchargements
// ---------------------------------------------------------------------------

const jobs = new Map();
let jobCounter = 0;

const stamp = sec => {
  const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + "h" : "") + String(m).padStart(2, "0") + "m" + String(r).padStart(2, "0") + "s";
};

const CROPS = { "9:16": 9 / 16, "1:1": 1 };
const CROP_TAGS = { "9:16": "9x16", "1:1": "1x1" };
const MAX_SEGMENTS = 20;

function buildArgs({ url, start, end, duration, mode, format, quality, cookieFile }, tempDir) {
  const cut = start > 0.05 || end < duration - 0.05;
  const suffix = cut ? ` [${stamp(start)}-${stamp(end)}]` : "";
  const args = [
    ...BASE_ARGS,
    "--newline", "--progress", "--no-mtime", "--windows-filenames", "--trim-filenames", "180",
    "--concurrent-fragments", "4", "--playlist-items", "1",
    "--print", "after_move:filepath", "--no-simulate",
    // Tout se passe dans un dossier privé ; le fichier fini est déplacé ensuite (voir finalizeFile)
    "-P", tempDir, "-P", `temp:${path.join(tempDir, "parts")}`,
    "-o", `%(title)s${suffix}.%(ext)s`,
  ];
  if (cut) args.push("--download-sections", `*${start.toFixed(2)}-${end.toFixed(2)}`, "--force-keyframes-at-cuts");

  if (mode === "audio") {
    const a = AUDIO_FORMATS[format];
    args.push("-f", "ba/b", "-x", "--audio-format", a.codec, "--audio-quality", "0", "--embed-metadata");
    if (a.thumb) args.push("--embed-thumbnail");
  } else {
    const res = quality === "auto" ? "res" : `res:${quality}`; // "auto" = meilleure qualité disponible
    if (format === "webm") args.push("-S", `${res},vcodec:vp9,acodec:opus`, "--merge-output-format", "webm/mkv", "--recode-video", "webm");
    else if (format === "avi") args.push("-S", `${res},vcodec:h264,acodec:aac`, "--merge-output-format", "mp4", "--recode-video", "avi");
    else if (format === "mkv") args.push("-S", res, "--merge-output-format", "mkv");
    else args.push("-S", `${res},vcodec:h264,acodec:aac`, "--merge-output-format", format);
  }
  if (cookieFile) args.push("--cookies", cookieFile);
  args.push("--", url); // "--" : rien après ne peut être interprété comme une option
  return { args, cut };
}

// Déplace le fichier terminé vers le dossier choisi, sans jamais écraser un fichier existant.
async function finalizeFile(src, destDir) {
  const ext = path.extname(src), base = path.basename(src, ext);
  let dest = path.join(destDir, base + ext);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(destDir, `${base} (${i})${ext}`);
  try { await fs.promises.rename(src, dest); }
  catch (e) {
    if (e.code !== "EXDEV") throw e; // autre disque : copie puis suppression
    await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
    await fs.promises.unlink(src);
  }
  return dest;
}

function sendProgress(job, force) {
  const now = Date.now();
  if (!force && now - job.lastSent < 100) return; // max ~10 mises à jour/s
  job.lastSent = now;
  const { id, status, percent, line, error } = job;
  mainWindow?.webContents.send("progress", { id, status, percent, line, error, files: (job.files || []).map(f => path.basename(f)) });
}

// Lance un programme (yt-dlp ou ffmpeg) pour une tâche, ligne par ligne, annulable.
function runTool(job, exe, args, cwd, onLine) {
  return new Promise(resolve => {
    const proc = spawn(exe, args, { env: CHILD_ENV, windowsHide: true, cwd });
    job.proc = proc;
    const splitter = () => { let buf = ""; return d => { buf += d.toString("utf8"); const ls = buf.split(/\r?\n|\r/); buf = ls.pop(); ls.forEach(l => l.trim() && onLine(l.trim())); }; };
    proc.stdout.on("data", splitter());
    proc.stderr.on("data", splitter());
    proc.on("error", e => onLine("ERROR: " + e.message));
    proc.on("close", code => { job.proc = null; resolve(code); });
  });
}
const ffTime = line => { const m = line.match(/time=(\d+):(\d+):([\d.]+)/); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };

// Réglages d'encodage quand FFmpeg doit réencoder (recadrage, ou assemblage impossible sans réencodage)
function videoCodecArgs(ext) {
  if (ext === ".webm") return ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1"];
  if (ext === ".avi") return ["-c:v", "mpeg4", "-q:v", "3"];
  return ["-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p"];
}
function audioCodecArgs(ext) {
  return {
    ".mp3": ["-c:a", "libmp3lame", "-q:a", "2"], ".wav": ["-c:a", "pcm_s16le"], ".flac": ["-c:a", "flac"],
    ".m4a": ["-c:a", "aac", "-b:a", "256k"], ".ogg": ["-c:a", "libvorbis", "-q:a", "6"], ".opus": ["-c:a", "libopus", "-b:a", "160k"],
    ".webm": ["-c:a", "libopus", "-b:a", "160k"], ".avi": ["-c:a", "libmp3lame", "-q:a", "2"],
  }[ext] || ["-c:a", "aac", "-b:a", "192k"];
}
const FFMPEG = () => path.join(FFMPEG_DIR, "ffmpeg.exe");

// Recadre une vidéo au format demandé (9:16 ou 1:1), à la position choisie (0 = gauche/haut, 1 = droite/bas).
async function cropFile(job, src, cropKey, pos, report) {
  const r = CROPS[cropKey], ext = path.extname(src);
  const out = src.slice(0, -ext.length) + ` ${CROP_TAGS[cropKey]}` + ext;
  const vf = `crop=w=trunc(min(iw\\,ih*${r})/2)*2:h=trunc(min(ih\\,iw/${r})/2)*2:x=(iw-ow)*${pos.toFixed(4)}:y=(ih-oh)*${pos.toFixed(4)}`;
  const args = ["-hide_banner", "-nostdin", "-y", "-i", src, "-vf", vf, ...videoCodecArgs(ext), "-c:a", "copy", "-map_metadata", "0"];
  if (ext === ".mp4" || ext === ".mov") args.push("-movflags", "+faststart");
  args.push(out);
  const code = await runTool(job, FFMPEG(), args, path.dirname(src), line => { const t = ffTime(line); if (t !== null) report(t); });
  if (code !== 0 || !fs.existsSync(out)) throw new Error("recadrage impossible");
  fs.rmSync(src, { force: true });
  return out;
}

// Recolle plusieurs extraits en un seul fichier (sans réencodage si possible).
async function concatFiles(job, files, out, report) {
  const list = path.join(path.dirname(out), "liste.txt");
  fs.writeFileSync(list, files.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const ext = path.extname(out);
  const base = ["-hide_banner", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", list];
  const onLine = line => { const t = ffTime(line); if (t !== null) report(t); };
  let code = await runTool(job, FFMPEG(), [...base, "-c", "copy", out], path.dirname(out), onLine);
  if ((code !== 0 || !fs.existsSync(out)) && job.status === "running") {
    fs.rmSync(out, { force: true });
    const audioOnly = [".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus"].includes(ext);
    code = await runTool(job, FFMPEG(), [...base, ...(audioOnly ? [] : videoCodecArgs(ext)), ...audioCodecArgs(ext), out], path.dirname(out), onLine);
  }
  if (code !== 0 || !fs.existsSync(out)) throw new Error("assemblage impossible");
  for (const f of files) fs.rmSync(f, { force: true });
  return out;
}

async function startDownload(opts) {
  if (!termsAccepted()) return TERMS_ERROR;
  // --- validation stricte : le lien et la durée viennent du moteur, pas de la fenêtre ---
  const info = infos.get(String(opts?.token));
  if (!info) return { error: "Recharge le lien avant de télécharger." };
  const known = info.duration;
  const duration = known || 1;
  const raw = known && Array.isArray(opts.segments) && opts.segments.length ? opts.segments : [{ start: opts.start, end: opts.end }];
  if (raw.length > MAX_SEGMENTS) return { error: `${MAX_SEGMENTS} extraits maximum à la fois.` };
  const segments = raw.map(s => ({
    start: known ? Math.max(0, finite(s?.start, 0)) : 0,
    end: known ? Math.min(duration, finite(s?.end, duration)) : duration,
  }));
  if (segments.some(s => !(s.end > s.start))) return { error: "Pour chaque extrait, la fin doit être après le début." };
  const mode = opts.mode === "audio" ? "audio" : "video";
  const merge = !!opts.merge && segments.length > 1;
  const crop = mode === "video" && CROPS[opts.crop] ? opts.crop : null;
  const cropPos = Math.min(1, Math.max(0, finite(opts.cropPos, 0.5)));
  if (mode === "video" && !info.hasVideo) return { error: "Ce lien ne contient que du son : choisis « Musique »." };
  if (mode === "audio" && !info.hasAudio) return { error: "Cette vidéo n'a pas de son : impossible d'en faire un fichier audio." };
  const format = mode === "audio" ? (AUDIO_FORMATS[opts.format] ? opts.format : "mp3") : (VIDEO_FORMATS.has(opts.format) ? opts.format : "mp4");
  const quality = info.heights.includes(Number(opts.quality)) ? Number(opts.quality) : "auto";
  if (!isDir(settings.downloadDir)) return { error: "Le dossier de destination n'existe plus. Choisis-en un autre." };
  if ([...jobs.values()].filter(j => j.status === "running").length >= MAX_PARALLEL) return { error: "Trop de téléchargements en cours. Attends qu'un se termine." };

  await ready;
  if (updating) await updating;
  const jobId = String(++jobCounter);
  const tempDir = path.join(TEMP_ROOT, "job-" + jobId + "-" + Date.now());
  fs.mkdirSync(tempDir, { recursive: true });
  const job = { id: jobId, status: "running", percent: null, line: "Préparation…", files: [], error: null, lastSent: 0, tempDir, proc: null };
  jobs.set(jobId, job);
  runJob(job, { info, segments, duration, mode, format, quality, merge, crop, cropPos }).catch(() => {});
  return { id: jobId };
}

// Déroulé d'une tâche : chaque extrait (téléchargement + recadrage éventuel), assemblage éventuel, rangement.
async function runJob(job, { info, segments, duration, mode, format, quality, merge, crop, cropPos }) {
  const n = segments.length, tempDir = job.tempDir;
  // Répartition de la barre de progression : téléchargement 70 %, recadrage 25 %, assemblage 5 % (ajusté selon les étapes)
  const wCrop = crop ? 0.3 : 0, wMerge = merge ? 0.05 : 0, wDl = 1 - wCrop - wMerge;
  const setP = (frac, line) => { job.percent = Math.min(99.5, Math.max(0, frac * 100)); if (line) job.line = line; sendProgress(job); };
  const prefix = i => (n > 1 ? `Extrait ${i + 1}/${n} — ` : "");
  let cookieFile = null;
  const produced = [];
  try {
    cookieFile = info.useCookies ? await cookieFileFor(info.url) : null;
    for (let i = 0; i < n && job.status === "running"; i++) {
      const seg = segments[i], segLen = seg.end - seg.start;
      const segDir = path.join(tempDir, "seg-" + i);
      fs.mkdirSync(segDir, { recursive: true });
      const { args, cut } = buildArgs({ url: info.url, start: seg.start, end: seg.end, duration, mode, format, quality, cookieFile }, segDir);
      const errLines = [];
      let file = null;
      const base = i / n;
      setP(base, prefix(i) + "Préparation…");
      const code = await runTool(job, YTDLP, args, segDir, line => {
        let m;
        if ((m = line.match(/^\[download\]\s+([\d.]+)%/))) setP((base + parseFloat(m[1]) / 100 / n) * wDl, prefix(i) + "Téléchargement…");
        else if (/^[A-Za-z]:\\/.test(line)) file = line;
        else if (/^\[(ExtractAudio|Merger|VideoConvertor|VideoRemuxer|FixupM\w+|EmbedThumbnail|Metadata)\]/.test(line)) setP(((i + 1) / n) * wDl, prefix(i) + "Finalisation…");
        else if (ffTime(line) !== null && cut) setP((base + Math.min(1, ffTime(line) / segLen) / n) * wDl, prefix(i) + "Découpe et téléchargement…");
        else if (line.includes("ERROR")) errLines.push(line);
      });
      if (job.status !== "running") break;
      const ok = code === 0 && file && path.dirname(path.resolve(file)) === path.resolve(segDir) && fs.existsSync(file);
      if (!ok) throw Object.assign(new Error(cleanError(errLines.join("\n")) || `Échec (code ${code}).`), { user: true });
      if (crop) {
        const cBase = wDl + (i / n) * wCrop;
        setP(cBase, prefix(i) + "Recadrage " + crop + "…");
        file = await cropFile(job, file, crop, cropPos, t => setP(cBase + Math.min(1, t / segLen) / n * wCrop));
      }
      produced.push(file);
    }
    if (job.status !== "running") throw Object.assign(new Error("annulé"), { cancelled: true });

    let results = produced;
    if (merge) {
      setP(1 - wMerge, "Assemblage des extraits…");
      const ext = path.extname(produced[0]);
      const title = path.basename(produced[0], ext).replace(/ \[[^\]]*\]( \dx\d+)?$/, "");
      const tag = crop ? ` ${CROP_TAGS[crop]}` : "";
      const total = segments.reduce((a, s) => a + (s.end - s.start), 0);
      const out = path.join(tempDir, `${title} [${n} extraits]${tag}${ext}`);
      results = [await concatFiles(job, produced, out, t => setP(1 - wMerge + Math.min(1, t / total) * wMerge))];
    }
    if (job.status !== "running") throw Object.assign(new Error("annulé"), { cancelled: true });

    try {
      for (const f of results) job.files.push(await finalizeFile(f, settings.downloadDir));
    } catch (e) { throw Object.assign(new Error("Impossible d'enregistrer le fichier dans le dossier choisi (" + e.code + ")."), { user: true }); }
    job.status = "done"; job.percent = 100; job.line = "Terminé !";
    addHistory({ title: info.title, site: info.site, url: info.url, files: job.files, mode, format, crop, segments: segments.length, merged: merge });
  } catch (e) {
    if (job.status === "cancelled" || e.cancelled) { job.status = "cancelled"; job.line = "Annulé."; }
    else { job.status = "error"; job.error = e.user ? e.message : "Erreur inattendue : " + e.message; }
    job.files = job.files.filter(f => fs.existsSync(f));
  } finally {
    dropFile(cookieFile);
    fs.rm(tempDir, { recursive: true, force: true }, () => {});
    sendProgress(job, true);
  }
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  // yt-dlp lance ffmpeg : on arrête tout l'arbre de processus.
  execFile(TASKKILL, ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true }, () => {});
}

function cancelDownload(jobId) {
  const job = jobs.get(String(jobId));
  if (!job || job.status !== "running") return false;
  job.status = "cancelled";
  killTree(job.proc);
  return true;
}

// ---------------------------------------------------------------------------
// Fenêtre
// ---------------------------------------------------------------------------

// Signature navigateur standard (sans le nom accentué de l'appli ni "Electron") :
// évite les erreurs d'en-têtes non ASCII et garde le lecteur YouTube compatible.
app.userAgentFallback = app.userAgentFallback
  .replace(/\(KHTML, like Gecko\).*?Chrome\//, "(KHTML, like Gecko) Chrome/")
  .replace(/ Electron\/\S+/, "")
  .replace(/[^\x20-\x7E]/g, "");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// media://preview/<jeton> et media://thumb/<jeton> : relais des aperçus des sites autres que YouTube.
// Seules les adresses obtenues par yt-dlp pour ce jeton peuvent être relayées.
async function serveMedia(request) {
  let kind, token;
  try { const u = new URL(request.url); kind = u.hostname; token = u.pathname.slice(1); } catch { return new Response("", { status: 400 }); }
  const entry = infos.get(token);
  const src = kind === "preview" ? entry?.preview : kind === "thumb" ? entry?.thumb : null;
  if (!src) return new Response("", { status: 404 });
  const headers = { ...src.headers };
  const range = request.headers.get("range");
  if (range && /^bytes=\d*-\d*$/.test(range)) headers.Range = range;
  let r;
  try { r = await net.fetch(src.url, { headers, bypassCustomProtocolHandlers: true }); }
  catch (e) { if (DEV_LOG) console.log("[media]", kind, "échec", e.message); return new Response("", { status: 502 }); }
  const type = r.headers.get("content-type") || "";
  if (DEV_LOG) console.log("[media]", kind, range || "-", r.status, type, r.headers.get("content-length"), new URL(src.url).hostname);
  if (!/^(video|audio|image)\/|^application\/octet-stream|^binary\//i.test(type)) return new Response("", { status: 415 });
  const out = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  for (const h of ["content-length", "content-range"]) { const v = r.headers.get(h); if (v) out[h] = v; }
  return new Response(r.body, { status: r.status, headers: out });
}

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: media:",
  "media-src media:",
  "frame-src https://www.youtube-nocookie.com",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png" };
const fileCache = new Map(); // les fichiers de l'interface ne changent pas : lus une seule fois

async function serveApp(request) {
  let rel;
  try { rel = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response("", { status: 400 }); }
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(RENDERER_DIR, rel));
  const type = MIME[path.extname(file)];
  if (!file.startsWith(RENDERER_DIR + path.sep) || !type) return new Response("", { status: 404 });
  let body = fileCache.get(file);
  if (!body) {
    try { body = await fs.promises.readFile(file); } catch { return new Response("", { status: 404 }); }
    fileCache.set(file, body);
  }
  return new Response(body, { status: 200, headers: {
    "Content-Type": type,
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin",
    "Cache-Control": "no-store",
  } });
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980, height: 940, minWidth: 440, minHeight: 600,
    title: "VideoCutter",
    backgroundColor: "#131118",
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Menu clic droit (Electron n'en fournit pas par défaut)
  mainWindow.webContents.on("context-menu", (_e, p) => {
    const f = p.editFlags, items = [];
    if (p.isEditable) {
      items.push(
        { role: "undo", label: "Annuler", enabled: f.canUndo },
        { role: "redo", label: "Rétablir", enabled: f.canRedo },
        { type: "separator" },
        { role: "cut", label: "Couper", enabled: f.canCut },
        { role: "copy", label: "Copier", enabled: f.canCopy },
        { role: "paste", label: "Coller", enabled: f.canPaste },
        { role: "delete", label: "Supprimer", enabled: f.canDelete },
        { type: "separator" },
        { role: "selectAll", label: "Tout sélectionner", enabled: f.canSelectAll },
      );
    } else if (p.selectionText.trim()) {
      items.push({ role: "copy", label: "Copier" }, { role: "selectAll", label: "Tout sélectionner" });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
  mainWindow.loadURL(APP_ORIGIN + "/index.html");
  mainWindow.on("closed", () => { mainWindow = null; });
}

// Verrouillage global de tout contenu web (fenêtre + lecteur YouTube intégré)
app.on("web-contents-created", (_e, contents) => {
  // Fenêtres de connexion : navigation web libre (http/https), mais rien d'autre (ni fichiers, ni appli, ni Node)
  if (loginSession && contents.session === loginSession) {
    const webOnly = (e, url) => { if (!/^https?:\/\//i.test(url)) e.preventDefault(); };
    contents.on("will-navigate", webOnly);
    contents.on("will-redirect", webOnly);
    contents.on("will-attach-webview", e => e.preventDefault());
    contents.setWindowOpenHandler(({ url }) => (/^https?:\/\//i.test(url)
      ? { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: LOGIN_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false } } }
      : { action: "deny" }));
    return;
  }
  contents.on("will-navigate", (e, url) => { if (!url.startsWith(APP_ORIGIN + "/")) e.preventDefault(); });
  contents.on("will-redirect", (e, url) => { if (e.isMainFrame && !url.startsWith(APP_ORIGIN + "/")) e.preventDefault(); });
  contents.on("will-attach-webview", e => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    // "Regarder sur YouTube" depuis le lecteur : ouverture dans le navigateur habituel
    try {
      const u = new URL(url);
      if (u.protocol === "https:" && /(^|\.)youtube\.com$|^youtu\.be$/.test(u.hostname)) shell.openExternal(u.toString());
    } catch {}
    return { action: "deny" };
  });
});

// ---------------------------------------------------------------------------
// Mise à jour de l'appli depuis les releases GitHub (Volltarylle/VideoCutter).
// Rien n'est téléchargé sans l'accord de l'utilisateur ; l'empreinte SHA-512 de latest.yml est vérifiée.
// ---------------------------------------------------------------------------
let appUpdater = null;
const sendUpdate = s => mainWindow?.webContents.send("app-update", s);
function setupAppUpdater() {
  if (!app.isPackaged) return;
  try { appUpdater = require("electron-updater").autoUpdater; } catch { return; }
  appUpdater.autoDownload = false;
  appUpdater.autoInstallOnAppQuit = true;
  appUpdater.allowPrerelease = false;
  appUpdater.allowDowngrade = false;
  appUpdater.logger = null;
  appUpdater.on("update-available", i => sendUpdate({ state: "available", version: String(i.version) }));
  appUpdater.on("download-progress", p => sendUpdate({ state: "downloading", percent: Math.round(p.percent || 0) }));
  appUpdater.on("update-downloaded", i => sendUpdate({ state: "ready", version: String(i.version) }));
  appUpdater.on("error", () => sendUpdate({ state: "error" }));
  setTimeout(() => appUpdater.checkForUpdates().catch(() => {}), 8000);
}

// Version installée : refuse les options de débogage passées en ligne de commande
const DEBUG_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "js-flags"];
if (app.isPackaged && DEBUG_SWITCHES.some(s => app.commandLine.hasSwitch(s))) {
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) { // une seule fenêtre à la fois
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  app.enableSandbox();

  app.whenReady().then(async () => {
    migrateOldData();
    settings = loadSettings();
    Menu.setApplicationMenu(null);

    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "fullscreen"));
    ses.setPermissionCheckHandler((_wc, permission) => permission === "fullscreen");
    ses.setDevicePermissionHandler(() => false);
    ses.on("will-download", e => e.preventDefault());
    // Le lecteur YouTube intégré exige un "Referer" https pour fonctionner.
    ses.webRequest.onBeforeSendHeaders({ urls: ["https://www.youtube-nocookie.com/*"] }, (details, cb) => {
      if (details.resourceType === "subFrame") details.requestHeaders.Referer = "https://videocutter.app/";
      cb({ requestHeaders: details.requestHeaders });
    });
    protocol.handle("app", serveApp);
    protocol.handle("media", serveMedia);

    // Session des connexions : aucune permission (caméra, micro, notifications…), aucun téléchargement
    loginSession = session.fromPartition(LOGIN_PARTITION);
    loginSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    loginSession.setPermissionCheckHandler(() => false);
    loginSession.setDevicePermissionHandler(() => false);
    loginSession.on("will-download", e => e.preventDefault());

    // Préparation de yt-dlp en parallèle de l'ouverture de la fenêtre
    ready = ensureYtdlp().catch(e => dialog.showErrorBox("VideoCutter", "yt-dlp est introuvable : " + e.message));
    createWindow();
    setupAppUpdater();
    await ready;
    cleanTemp();
    setTimeout(() => updateYtdlp(false).then(r => r.updated && mainWindow?.webContents.send("ytdlp-updated", r.after)), 3000);
  });

  // --- API exposée à la fenêtre ---
  handle("info", url => getInfo(url));
  handle("download", opts => startDownload(opts));
  handle("cancel", id => cancelDownload(id));
  handle("reveal", id => {
    const job = jobs.get(String(id));
    const f = job?.status === "done" && job.files.find(p => fs.existsSync(p));
    if (f) shell.showItemInFolder(f);
    return true;
  });
  // Presse-papiers : lu seulement quand la fenêtre le demande, et seulement s'il contient un lien web
  handle("clipboard-link", async () => {
    const t = String((await clipboard.readText()) ?? "").trim(); // readText peut être synchrone ou asynchrone selon la version d'Electron
    return t.length <= 2048 && /^https?:\/\//i.test(t) ? validateUrl(t) : null;
  });
  handle("history-list", () => historyView());
  handle("history-reveal", id => {
    const h = loadHistory().find(x => x.id === String(id));
    const f = h && (h.files || []).find(p => typeof p === "string" && fs.existsSync(p));
    if (f) shell.showItemInFolder(f);
    return !!f;
  });
  handle("history-remove", id => { history = loadHistory().filter(x => x.id !== String(id)); saveHistory(); return true; });
  handle("history-clear", () => { history = []; saveHistory(); return true; });
  handle("app-update-download", () => { appUpdater?.downloadUpdate().catch(() => sendUpdate({ state: "error" })); return !!appUpdater; });
  handle("app-update-install", () => {
    for (const j of jobs.values()) if (j.status === "running") { j.status = "cancelled"; killTree(j.proc); }
    setImmediate(() => appUpdater?.quitAndInstall(false, true));
    return true;
  });
  handle("get-settings", async () => { await ready; return { downloadDir: settings.downloadDir, ytdlp: await ytdlpVersion(), version: app.getVersion(), termsAccepted: termsAccepted() }; });
  handle("terms-state", () => termsAccepted());
  handle("accept-terms", () => { settings.terms = { version: TERMS_VERSION, acceptedAt: new Date().toISOString() }; saveSettings(); return true; });
  handle("refuse-terms", () => { app.quit(); return true; });
  // Dossier contenant LICENSE.txt et THIRD_PARTY_NOTICES.md (version installée uniquement)
  handle("open-licenses", () => {
    const file = app.isPackaged ? path.join(process.resourcesPath, "LICENSE.txt") : path.join(__dirname, "..", "LICENSE");
    if (fs.existsSync(file)) shell.showItemInFolder(file);
    return true;
  });
  handle("choose-folder", async () => {
    const r = await dialog.showOpenDialog(mainWindow, { title: "Où enregistrer les fichiers ?", defaultPath: settings.downloadDir, properties: ["openDirectory", "createDirectory"] });
    if (!r.canceled && r.filePaths[0]) { settings.downloadDir = r.filePaths[0]; saveSettings(); }
    return settings.downloadDir;
  });
  handle("open-folder", () => isDir(settings.downloadDir) && shell.openPath(settings.downloadDir));
  handle("update-ytdlp", () => updateYtdlp(true));
  handle("login-open", target => openLoginWindow(String(target)));
  handle("login-list", () => loginList());
  handle("login-forget", domain => loginForget(String(domain)));
  handle("login-forget-all", async () => { await loginSession?.clearStorageData(); await loginSession?.clearCache(); return true; });

  app.on("before-quit", () => { for (const j of jobs.values()) if (j.status === "running") { j.status = "cancelled"; killTree(j.proc); } });
  app.on("window-all-closed", () => app.quit());
}
