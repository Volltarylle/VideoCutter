// Pont minimal entre la page et le processus principal.
// La page n'a accès à rien d'autre que ces quelques fonctions.
const { contextBridge, ipcRenderer } = require("electron");

const str = (v, max = 300) => String(v ?? "").slice(0, max);
const prefsObj = p => ({
  mode: str(p.mode, 5), vFormat: str(p.vFormat, 5), aFormat: str(p.aFormat, 5), crop: str(p.crop, 5), fill: str(p.fill, 5),
  speed: Number(p.speed), sizeMB: Number(p.sizeMB), merge: !!p.merge, mute: !!p.mute, cleanNames: !!p.cleanNames,
  aQuality: str(p.aQuality, 5), fade: !!p.fade, norm: !!p.norm, logoPos: str(p.logoPos, 5), textPos: str(p.textPos, 10), subsMode: str(p.subsMode, 5),
  cutSilence: !!p.cutSilence, sponsor: !!p.sponsor,
});

contextBridge.exposeInMainWorld("videoCutter", {
  lang: ipcRenderer.sendSync("get-lang") === "en" ? "en" : "fr",
  setLang: lang => ipcRenderer.invoke("set-lang", str(lang, 5)),
  info: url => ipcRenderer.invoke("info", String(url)),
  download: opts => ipcRenderer.invoke("download", {
    token: String(opts.token), start: Number(opts.start), end: Number(opts.end),
    mode: String(opts.mode), format: String(opts.format), quality: String(opts.quality), aQuality: str(opts.aQuality, 5),
    segments: Array.isArray(opts.segments) ? opts.segments.slice(0, 20).map(s => ({ start: Number(s.start), end: Number(s.end), name: str(s.name, 150) })) : [],
    merge: !!opts.merge, crop: String(opts.crop || ""), cropPos: Number(opts.cropPos), fill: str(opts.fill, 5),
    name: str(opts.name), speed: Number(opts.speed), mute: !!opts.mute, sizeMB: Number(opts.sizeMB),
    fade: !!opts.fade, norm: !!opts.norm, boomerang: !!opts.boomerang,
    text: str(opts.text, 200), textPos: str(opts.textPos, 10), logoPos: str(opts.logoPos, 5),
    subsLang: str(opts.subsLang, 20), subsMode: str(opts.subsMode, 5), cutSilence: !!opts.cutSilence, sponsor: !!opts.sponsor,
  }),
  savePrefs: p => ipcRenderer.invoke("save-prefs", prefsObj(p)),
  // Favoris : liste complète renvoyée (20 maximum), vérifiée par le moteur
  savePresets: list => ipcRenderer.invoke("save-presets", (Array.isArray(list) ? list : []).slice(0, 20).map(p => ({
    name: str(p?.name, 30), opts: { ...prefsObj(p?.opts || {}), boomerang: !!p?.opts?.boomerang, text: str(p?.opts?.text, 80) },
  }))),
  frameAt: (token, t) => ipcRenderer.invoke("frame-at", String(token), Number(t)),
  snapshot: o => ipcRenderer.invoke("snapshot", { token: String(o.token), t: Number(o.t), crop: str(o.crop, 5), cropPos: Number(o.cropPos), fill: str(o.fill, 5), name: str(o.name) }),
  saveThumb: o => ipcRenderer.invoke("save-thumb", { token: String(o.token), name: str(o.name) }),
  playlistEntries: url => ipcRenderer.invoke("playlist-entries", str(url, 2048)),
  chooseLogo: () => ipcRenderer.invoke("choose-logo"),
  openFile: id => ipcRenderer.invoke("open-file", String(id)),
  startDrag: (id, index) => ipcRenderer.send("start-drag", String(id), Number(index)),
  clipboardLink: () => ipcRenderer.invoke("clipboard-link"),
  historyList: () => ipcRenderer.invoke("history-list"),
  historyReveal: id => ipcRenderer.invoke("history-reveal", String(id)),
  historyRemove: id => ipcRenderer.invoke("history-remove", String(id)),
  historyClear: () => ipcRenderer.invoke("history-clear"),
  onHistoryChanged: cb => ipcRenderer.on("history-changed", () => cb()),
  appUpdateDownload: () => ipcRenderer.invoke("app-update-download"),
  appUpdateInstall: () => ipcRenderer.invoke("app-update-install"),
  onAppUpdate: cb => ipcRenderer.on("app-update", (_e, s) => cb(s)),
  cancel: id => ipcRenderer.invoke("cancel", String(id)),
  reveal: id => ipcRenderer.invoke("reveal", String(id)),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  openFolder: () => ipcRenderer.invoke("open-folder"),
  openLicenses: () => ipcRenderer.invoke("open-licenses"),
  termsState: () => ipcRenderer.invoke("terms-state"),
  acceptTerms: () => ipcRenderer.invoke("accept-terms"),
  refuseTerms: () => ipcRenderer.invoke("refuse-terms"),
  updateYtdlp: () => ipcRenderer.invoke("update-ytdlp"),
  loginOpen: target => ipcRenderer.invoke("login-open", String(target)),
  loginList: () => ipcRenderer.invoke("login-list"),
  loginForget: domain => ipcRenderer.invoke("login-forget", String(domain)),
  loginForgetAll: () => ipcRenderer.invoke("login-forget-all"),
  onLoginChanged: cb => ipcRenderer.on("login-changed", () => cb()),
  onProgress: cb => ipcRenderer.on("progress", (_e, p) => cb(p)),
  onYtdlpUpdated: cb => ipcRenderer.on("ytdlp-updated", (_e, v) => cb(v)),
});
