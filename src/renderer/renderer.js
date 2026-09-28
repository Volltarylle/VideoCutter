"use strict";
const $ = id => document.getElementById(id);
const api = window.videoCutter;
const YT_ORIGIN = "https://www.youtube-nocookie.com";

let info = null, mode = "video", currentJob = null, doneJob = null, previewStop = null;

// ---------------------------------------------------------------------------
// Temps
// ---------------------------------------------------------------------------
function fmt(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  const ss = sec.toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
function parseTime(t) {
  t = String(t).trim().replace(",", ".");
  if (!t || !/^[\d:.]+$/.test(t)) return NaN;
  const parts = t.split(":").map(Number);
  if (parts.length > 3 || parts.some(isNaN)) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// ---------------------------------------------------------------------------
// Lecteur YouTube isolé dans un iframe, piloté par messages
// (aucun script YouTube n'est chargé dans cette page)
// ---------------------------------------------------------------------------
const yt = {
  frame: null, time: 0, stamp: 0, playing: false,
  load(id) {
    const f = document.createElement("iframe");
    f.src = `${YT_ORIGIN}/embed/${encodeURIComponent(id)}?enablejsapi=1&rel=0&playsinline=1&modestbranding=1&cc_load_policy=0&iv_load_policy=3&hl=fr`;
    f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    f.referrerPolicy = "strict-origin";
    f.title = "Aperçu de la vidéo";
    f.addEventListener("load", () => this.post({ event: "listening", id: 1, channel: "widget" }));
    $("player").replaceChildren(f);
    this.frame = f; this.time = 0; this.stamp = performance.now(); this.playing = false;
  },
  post(msg) { this.frame?.contentWindow?.postMessage(JSON.stringify(msg), YT_ORIGIN); },
  cmd(func, args = []) { this.post({ event: "command", func, args, id: 1, channel: "widget" }); },
  seek(t) { this.cmd("seekTo", [t, true]); this.time = t; this.stamp = performance.now(); },
  play() { this.cmd("playVideo"); },
  pause() { this.cmd("pauseVideo"); },
  now() { return this.playing ? this.time + (performance.now() - this.stamp) / 1000 : this.time; },
};
window.addEventListener("message", e => {
  if (e.origin !== YT_ORIGIN || e.source !== yt.frame?.contentWindow || typeof e.data !== "string") return;
  let d; try { d = JSON.parse(e.data); } catch { return; }
  const i = d.event === "infoDelivery" ? d.info : d.event === "initialDelivery" ? d.info : null;
  if (!i || typeof i !== "object") return;
  if (typeof i.currentTime === "number") { yt.time = i.currentTime; yt.stamp = performance.now(); }
  if (typeof i.playerState === "number") yt.playing = i.playerState === 1;
});

// ---------------------------------------------------------------------------
// Lecteur commun : YouTube (iframe), autres sites (aperçu relayé par l'appli), ou miniature seule
// ---------------------------------------------------------------------------
let media = null; // élément <video> pour les sites autres que YouTube
const player = {
  kind: "none",
  now() { return this.kind === "youtube" ? yt.now() : this.kind === "media" ? media.currentTime : 0; },
  seek(t) { if (this.kind === "youtube") yt.seek(t); else if (this.kind === "media") media.currentTime = t; },
  play() { if (this.kind === "youtube") yt.play(); else if (this.kind === "media") media.play().catch(() => {}); },
  pause() { if (this.kind === "youtube") yt.pause(); else if (this.kind === "media") media.pause(); },
};

function showStill(j, message) {
  const nodes = [];
  if (j.thumb) {
    const img = document.createElement("img");
    img.src = `media://thumb/${j.token}`; img.alt = "";
    img.onerror = () => img.remove();
    nodes.push(img);
  }
  const p = document.createElement("div");
  p.className = "placeholder"; p.textContent = message;
  nodes.push(p);
  $("player").replaceChildren(...nodes);
  player.kind = "none"; media = null; yt.frame = null;
}

function loadPlayer(j) {
  if (j.youtubeId) { player.kind = "youtube"; media = null; yt.load(j.youtubeId); return; }
  yt.frame = null;
  if (!j.preview) return showStill(j, "Aperçu indisponible pour ce site — règle les temps à la main.");
  const v = document.createElement("video");
  v.controls = true; v.preload = "metadata"; v.playsInline = true;
  v.src = `media://preview/${j.token}`;
  const fallback = () => { if (media === v) showStill(j, "Aperçu indisponible pour cette vidéo — règle les temps à la main."); };
  v.onerror = fallback;
  setTimeout(() => { if (v.readyState === 0) fallback(); }, 15000); // le site ne répond pas : on n'attend pas indéfiniment
  $("player").replaceChildren(v);
  media = v; player.kind = "media";
}

// Tête de lecture + arrêt automatique à la fin de l'extrait
function tick() {
  if (info && info.duration && player.kind !== "none") {
    const t = player.now();
    $("head").style.left = `calc(${Math.min(100, (t / info.duration) * 100)}% - 1px)`;
    if (previewStop !== null && t >= previewStop) { player.pause(); previewStop = null; }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------------------
// Chargement d'un lien
// ---------------------------------------------------------------------------
let loginTarget = null;
function showLoadError(msg, loginUrl) {
  $("loadErr").textContent = msg; $("loadErr").hidden = false;
  if (!currentJob) { $("editor").hidden = true; player.pause(); info = null; } // ne pas laisser croire que l'ancienne vidéo correspond au lien
  loginTarget = loginUrl || null;
  $("loginHere").hidden = !loginTarget;
}

// Menu de qualité : uniquement les hauteurs réellement disponibles pour cette vidéo
const qLabel = h => (h >= 2160 ? "4K" : h >= 1440 ? "1440p (2K)" : h + "p");
function fillQualities(heights) {
  const sel = $("quality");
  const opts = [new Option(heights.length ? `Auto (meilleure : ${qLabel(heights[0])})` : "Auto (meilleure disponible)", "auto")];
  for (const h of heights) opts.push(new Option(qLabel(h), String(h)));
  sel.replaceChildren(...opts);
  sel.value = "auto";
}

$("urlForm").addEventListener("submit", async e => {
  e.preventDefault();
  const url = $("url").value.trim();
  if (!url) return;
  $("loadErr").hidden = true; $("loginHere").hidden = true;
  $("loadBtn").disabled = true; $("loadBtn").textContent = "Chargement…";
  try {
    const j = await Promise.race([
      api.info(url),
      new Promise(r => setTimeout(() => r({ error: "Le chargement a pris trop de temps. Réessaie." }), 60000)),
    ]);
    if (j.error) return showLoadError(j.error, j.loginUrl);
    if (j.isLive) return showLoadError("Les directs en cours ne peuvent pas être téléchargés.");
    info = j;
    previewStop = null;
    $("title").textContent = j.title;
    $("channel").textContent = [j.site, j.channel, j.loggedIn ? "🔑 via ta connexion" : ""].filter(Boolean).join(" · ");
    fillQualities(j.heights || []);

    // Durée inconnue : pas de découpe possible, téléchargement complet
    $("cutCard").hidden = !j.duration;
    $("noCut").hidden = !!j.duration;
    if (j.duration) {
      for (const r of [$("startR"), $("endR")]) r.max = j.duration;
      $("durLabel").textContent = fmt(j.duration).replace(/\.\d$/, "");
      setRange(0, j.duration);
    } else {
      info.start = info.end = 0;
      $("dlBtn").textContent = "Télécharger la vidéo entière";
    }

    // Son seul (ex. SoundCloud) : Musique imposée ; vidéo muette : Vidéo imposée
    const videoBtn = $("modeSeg").querySelector("[data-mode=video]");
    const audioBtn = $("modeSeg").querySelector("[data-mode=audio]");
    videoBtn.disabled = !j.hasVideo;
    audioBtn.disabled = !j.hasAudio;
    audioBtn.title = j.hasAudio ? "" : "Cette vidéo n'a pas de son";
    if (!j.hasVideo && mode === "video") audioBtn.click();
    if (!j.hasAudio && mode === "audio") videoBtn.click();

    $("editor").hidden = false;
    if (!currentJob) $("progress").hidden = true;
    loadPlayer(j);
  } catch {
    showLoadError("Erreur inattendue. Réessaie.");
  } finally {
    $("loadBtn").disabled = false; $("loadBtn").textContent = "Charger";
  }
});

// ---------------------------------------------------------------------------
// Sélection début / fin
// ---------------------------------------------------------------------------
function setRange(s, e, source) {
  const d = info.duration;
  s = Math.min(Math.max(0, s), d); e = Math.min(Math.max(0, e), d);
  if (e - s < 0.5) { if (source === "end") s = Math.max(0, e - 0.5); else e = Math.min(d, s + 0.5); }
  info.start = s; info.end = e;
  $("startR").value = s; $("endR").value = e;
  if (document.activeElement !== $("startT")) $("startT").value = fmt(s);
  if (document.activeElement !== $("endT")) $("endT").value = fmt(e);
  $("range").style.left = (s / d * 100) + "%";
  $("range").style.width = ((e - s) / d * 100) + "%";
  $("clipLen").textContent = fmt(e - s);
  $("dlBtn").textContent = (s < 0.05 && e > d - 0.05) ? "Télécharger la vidéo entière" : "Télécharger l'extrait";
}
$("startR").addEventListener("input", () => { setRange(+$("startR").value, info.end, "start"); player.seek(info.start); });
$("endR").addEventListener("input", () => { setRange(info.start, +$("endR").value, "end"); player.seek(info.end); });
for (const [id, key] of [["startT", "start"], ["endT", "end"]]) {
  $(id).addEventListener("change", () => {
    const v = parseTime($(id).value);
    if (!isNaN(v)) key === "start" ? setRange(v, info.end, "start") : setRange(info.start, v, "end");
    $(id).value = fmt(info[key]);
  });
  $(id).addEventListener("keydown", e => { if (e.key === "Enter") $(id).blur(); });
}
$("setStart").onclick = () => setRange(player.now(), info.end, "start");
$("setEnd").onclick = () => setRange(info.start, player.now(), "end");
$("reset").onclick = () => setRange(0, info.duration);
$("preview").onclick = () => { player.seek(info.start); player.play(); previewStop = info.end; };

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------
$("modeSeg").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || b.disabled) return;
  mode = b.dataset.mode;
  for (const x of $("modeSeg").children) x.classList.toggle("on", x === b);
  $("quality").hidden = $("vFormat").hidden = mode !== "video";
  $("aFormat").hidden = mode !== "audio";
});

// ---------------------------------------------------------------------------
// Téléchargement
// ---------------------------------------------------------------------------
function resetProgressUI() {
  $("progress").hidden = false;
  $("result").hidden = true; $("dlErr").hidden = true;
  $("bar").classList.add("indet"); $("bar").firstElementChild.style.width = "";
  $("status").textContent = "Démarrage…";
  $("cancelBtn").hidden = false;
}
function finish() { currentJob = null; $("dlBtn").disabled = false; $("cancelBtn").hidden = true; }

$("dlBtn").onclick = async () => {
  $("dlBtn").disabled = true;
  resetProgressUI();
  const r = await api.download({
    token: info.token, start: info.start, end: info.end, mode,
    format: mode === "audio" ? $("aFormat").value : $("vFormat").value, quality: $("quality").value,
  }).catch(() => ({ error: "Erreur inattendue." }));
  if (r.error) { finish(); $("bar").classList.remove("indet"); $("dlErr").textContent = r.error; $("dlErr").hidden = false; return; }
  currentJob = r.id;
};
$("cancelBtn").onclick = () => currentJob && api.cancel(currentJob);

api.onProgress(p => {
  if (p.id !== currentJob) return;
  if (p.percent != null) { $("bar").classList.remove("indet"); $("bar").firstElementChild.style.width = p.percent + "%"; }
  $("status").textContent = p.line + (p.percent != null && p.status === "running" ? ` ${Math.round(p.percent)} %` : "");
  if (p.status === "running") return;
  finish();
  if (p.status === "done") {
    doneJob = p.id;
    $("filename").textContent = p.file || "";
    $("result").hidden = false;
  } else if (p.status === "cancelled") {
    $("bar").classList.remove("indet"); $("bar").firstElementChild.style.width = "0";
  } else {
    $("bar").classList.remove("indet");
    $("dlErr").textContent = "Échec : " + p.error; $("dlErr").hidden = false;
  }
});
$("reveal").onclick = () => doneJob && api.reveal(doneJob);

// ---------------------------------------------------------------------------
// Pied de page : dossier + version de yt-dlp
// ---------------------------------------------------------------------------
async function refreshSettings() {
  const s = await api.getSettings();
  $("folderLink").textContent = s.downloadDir;
  $("ytVer").textContent = s.ytdlp || "?";
  $("appVer").textContent = s.version ? "v" + s.version : "";
}
$("folderLink").onclick = e => { e.preventDefault(); api.openFolder(); };
$("changeFolder").onclick = async e => { e.preventDefault(); $("folderLink").textContent = await api.chooseFolder(); };
$("updateLink").onclick = async e => {
  e.preventDefault();
  const link = $("updateLink");
  link.textContent = "recherche…";
  const r = await api.updateYtdlp();
  link.textContent = r.busy ? "attends la fin du téléchargement"
    : r.error ? "échec de la mise à jour"
    : r.updated ? "mis à jour ✓" : "déjà à jour ✓";
  refreshSettings();
  setTimeout(() => { link.textContent = "mettre à jour"; }, 4000);
};
api.onYtdlpUpdated(() => refreshSettings());
refreshSettings();

// ---------------------------------------------------------------------------
// Connexions aux sites
// ---------------------------------------------------------------------------
async function refreshLogins() {
  const list = await api.loginList();
  const items = list.map(({ domain }) => {
    const li = document.createElement("li");
    const name = document.createElement("span"); name.textContent = domain;
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "small"; btn.textContent = "Déconnecter";
    btn.onclick = async () => { btn.disabled = true; await api.loginForget(domain); refreshLogins(); };
    li.append(name, btn);
    return li;
  });
  if (!items.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "Aucune connexion enregistrée."; items.push(li); }
  $("loginList").replaceChildren(...items);
  $("loginForgetAll").hidden = !list.length;
}
function openLoginPanel() { $("loginPanel").hidden = false; refreshLogins(); $("loginPanel").scrollIntoView({ behavior: "smooth" }); }

$("loginLink").onclick = e => { e.preventDefault(); $("loginPanel").hidden ? openLoginPanel() : ($("loginPanel").hidden = true); };
$("loginClose").onclick = () => { $("loginPanel").hidden = true; };
$("loginPresets").addEventListener("click", e => { const b = e.target.closest("button"); if (b) api.loginOpen(b.dataset.site); });
$("loginOther").addEventListener("submit", async e => {
  e.preventDefault();
  const ok = await api.loginOpen($("loginUrl").value.trim());
  if (!ok) $("loginUrl").select();
});
$("loginForgetAll").onclick = async () => {
  if (!confirm("Se déconnecter de tous les sites dans l'appli ?")) return;
  await api.loginForgetAll(); refreshLogins();
};
$("loginHere").onclick = () => loginTarget && api.loginOpen(loginTarget);

// Licences (mention obligatoire de la GPL)
$("aboutLink").onclick = e => {
  e.preventDefault();
  $("aboutPanel").hidden = !$("aboutPanel").hidden;
  if (!$("aboutPanel").hidden) $("aboutPanel").scrollIntoView({ behavior: "smooth" });
};
$("aboutClose").onclick = () => { $("aboutPanel").hidden = true; };
$("openLicenses").onclick = () => api.openLicenses();

// ---------------------------------------------------------------------------
// Conditions d'utilisation : obligatoires au premier lancement, relisibles ensuite
// ---------------------------------------------------------------------------
function showTerms(mustAccept) {
  $("terms").hidden = false;
  document.body.classList.toggle("locked", mustAccept);
  $("termsCheck").parentElement.hidden = !mustAccept;
  $("termsAccept").hidden = $("termsRefuse").hidden = !mustAccept;
  $("termsClose").hidden = mustAccept;
  $("termsCheck").checked = false; $("termsAccept").disabled = true;
  $("terms").querySelector(".terms-text").scrollTop = 0;
  (mustAccept ? $("termsCheck") : $("termsClose")).focus();
}
$("termsCheck").onchange = () => { $("termsAccept").disabled = !$("termsCheck").checked; };
$("termsAccept").onclick = async () => {
  await api.acceptTerms();
  $("terms").hidden = true; document.body.classList.remove("locked");
  $("url").focus();
};
$("termsRefuse").onclick = () => api.refuseTerms();
$("termsClose").onclick = () => { $("terms").hidden = true; };
$("termsLink").onclick = e => { e.preventDefault(); showTerms(false); };
// Échap ne ferme la fenêtre que si les conditions sont déjà acceptées
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("terms").hidden && !$("termsClose").hidden) $("terms").hidden = true; });
api.termsState().then(ok => { if (!ok) showTerms(true); });
// Après la fermeture d'une fenêtre de connexion : mise à jour de la liste, et nouvel essai du lien en échec
api.onLoginChanged(() => {
  if (!$("loginPanel").hidden) refreshLogins();
  if (loginTarget && !$("loadErr").hidden) $("urlForm").requestSubmit();
});
