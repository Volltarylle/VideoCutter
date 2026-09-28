// Pont minimal entre la page et le processus principal.
// La page n'a accès à rien d'autre que ces quelques fonctions.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("videoCutter", {
  info: url => ipcRenderer.invoke("info", String(url)),
  download: opts => ipcRenderer.invoke("download", {
    token: String(opts.token), start: Number(opts.start), end: Number(opts.end),
    mode: String(opts.mode), format: String(opts.format), quality: String(opts.quality),
    segments: Array.isArray(opts.segments) ? opts.segments.slice(0, 20).map(s => ({ start: Number(s.start), end: Number(s.end) })) : [],
    merge: !!opts.merge, crop: String(opts.crop || ""), cropPos: Number(opts.cropPos),
  }),
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
