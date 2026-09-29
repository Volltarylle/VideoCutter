"use strict";
const $ = id => document.getElementById(id);
const api = window.videoCutter;
const YT_ORIGIN = "https://www.youtube-nocookie.com";
// Traduction (version anglaise) : textes de la page traduits au chargement, textes dynamiques via T()
const EN = api.lang === "en";
const T = s => (EN ? window.VC_I18N.tr(s) : s);
if (EN) window.VC_I18N.translatePage(document);

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
    f.title = T("Aperçu de la vidéo");
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
  playing() { return this.kind === "youtube" ? yt.playing : this.kind === "media" ? !media.paused : false; },
  toggle() { this.playing() ? this.pause() : this.play(); },
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
  p.className = "placeholder"; p.textContent = T(message);
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

// ---------------------------------------------------------------------------
// Zoom de la barre de découpe : la barre affiche la « vue » [view.start, view.end]
// ---------------------------------------------------------------------------
const ZOOMS = [1, 4, 16, 64];
let zoomIdx = 0, view = { start: 0, end: 1 };
const pct = t => Math.min(100, Math.max(0, ((t - view.start) / Math.max(0.001, view.end - view.start)) * 100));
function setView(center) {
  const d = info.duration, span = Math.max(2, d / ZOOMS[zoomIdx]);
  if (span >= d) { view = { start: 0, end: d }; }
  else {
    const s = Math.min(Math.max(0, center - span / 2), d - span);
    view = { start: s, end: s + span };
  }
  for (const r of [$("startR"), $("endR")]) { r.min = view.start; r.max = view.end; }
  $("viewStartLabel").textContent = fmt(view.start).replace(/\.\d$/, "");
  $("durLabel").textContent = fmt(view.end).replace(/\.\d$/, "");
  $("zoomLabel").textContent = "×" + ZOOMS[zoomIdx];
  $("zoomOut").disabled = zoomIdx === 0;
  $("zoomIn").disabled = zoomIdx === ZOOMS.length - 1 || d / ZOOMS[zoomIdx + 1] < 2;
  drawRange();
}
// Garde le point t visible quand on règle un temps hors de la vue (touches I/O, champs texte…)
function ensureVisible(t) { if (zoomIdx > 0 && (t < view.start || t > view.end)) setView(t); }
$("zoomIn").onclick = () => {
  if (zoomIdx >= ZOOMS.length - 1) return;
  zoomIdx++;
  const len = info.end - info.start, span = info.duration / ZOOMS[zoomIdx];
  setView(len <= span * 0.9 ? (info.start + info.end) / 2 : info.start + span / 2 - span * 0.05);
};
$("zoomOut").onclick = () => { if (zoomIdx > 0) { zoomIdx--; setView((info.start + info.end) / 2); } };

// Tête de lecture + arrêt automatique à la fin de l'extrait
function tick() {
  if (info && info.duration && player.kind !== "none") {
    const t = player.now();
    const inView = t >= view.start && t <= view.end;
    $("head").style.display = inView ? "" : "none";
    if (inView) $("head").style.left = `calc(${pct(t)}% - 1px)`;
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
  $("loadErr").textContent = T(msg); $("loadErr").hidden = false;
  if (!currentJob) { $("editor").hidden = true; player.pause(); info = null; } // ne pas laisser croire que l'ancienne vidéo correspond au lien
  loginTarget = loginUrl || null;
  $("loginHere").hidden = !loginTarget;
}

// Menu de qualité : uniquement les hauteurs réellement disponibles pour cette vidéo
const qLabel = h => (h >= 2160 ? "4K" : h >= 1440 ? "1440p (2K)" : h + "p");
function fillQualities(heights) {
  const sel = $("quality");
  const opts = [new Option(heights.length ? T("Auto (meilleure : ") + qLabel(heights[0]) + ")" : T("Auto (meilleure disponible)"), "auto")];
  for (const h of heights) opts.push(new Option(qLabel(h), String(h)));
  sel.replaceChildren(...opts);
  sel.value = "auto";
}

$("urlForm").addEventListener("submit", async e => {
  e.preventDefault();
  const url = $("url").value.trim();
  if (!url) return;
  $("loadErr").hidden = true; $("loginHere").hidden = true;
  $("loadBtn").disabled = true; $("loadBtn").textContent = T("Chargement…");
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
    $("channel").textContent = [j.site, j.channel, j.loggedIn ? T("🔑 via ta connexion") : ""].filter(Boolean).join(" · ");
    fillQualities(j.heights || []);

    // Durée inconnue : pas de découpe possible, téléchargement complet
    $("cutCard").hidden = !j.duration;
    $("noCut").hidden = !!j.duration;
    if (j.duration) {
      zoomIdx = 0; info.start = 0; info.end = j.duration;
      setView(j.duration / 2);
      setRange(j.startAt || 0, j.duration); // lien avec ?t=… : le passage commence à cet instant
    } else {
      info.start = info.end = 0;
      $("dlBtn").textContent = T("Télécharger la vidéo entière");
    }
    fillChapters(j.chapters || []);
    fillSubs(j.subs || []);
    $("thumbLink").hidden = !j.thumb;
    $("playlistLink").hidden = !j.isPlaylist;
    $("snapBtn").disabled = !j.still || !j.duration;
    $("snapMsg").hidden = true;

    // Son seul (ex. SoundCloud) : Musique imposée ; vidéo muette : Vidéo imposée
    const videoBtn = $("modeSeg").querySelector("[data-mode=video]");
    const audioBtn = $("modeSeg").querySelector("[data-mode=audio]");
    videoBtn.disabled = !j.hasVideo;
    audioBtn.disabled = !j.hasAudio;
    audioBtn.title = j.hasAudio ? "" : T("Cette vidéo n'a pas de son");
    if (!j.hasVideo && mode === "video") audioBtn.click();
    if (!j.hasAudio && mode === "audio") videoBtn.click();

    segments = []; renderSegments();
    cropPos = 0.5;
    $("editor").hidden = false;
    if (!currentJob) $("progress").hidden = true;
    loadPlayer(j);
    if (j.startAt) setTimeout(() => player.seek(j.startAt), player.kind === "youtube" ? 1500 : 0);
    updateFormatUI(); // options propres à cette vidéo (sous-titres…) + cadre de recadrage
    lastClip = j.url; $("clipSuggest").hidden = true;
    nameEdited = false; fillName();
    for (const img of [$("frameStart"), $("frameEnd")]) img.removeAttribute("src");
    $("frames").hidden = !(j.frames && j.duration);
    scheduleFrames();
    updateEstimate();
  } catch {
    showLoadError("Erreur inattendue. Réessaie.");
  } finally {
    $("loadBtn").disabled = false; $("loadBtn").textContent = T("Charger");
  }
});

// ---------------------------------------------------------------------------
// Sélection début / fin
// ---------------------------------------------------------------------------
function setRange(s, e, source) {
  const d = info.duration;
  s = Math.min(Math.max(0, s), d); e = Math.min(Math.max(0, e), d);
  const minLen = zoomIdx > 1 ? 0.2 : 0.5;
  if (e - s < minLen) { if (source === "end") s = Math.max(0, e - minLen); else e = Math.min(d, s + minLen); }
  info.start = s; info.end = e;
  if (source === "start") ensureVisible(s); else if (source === "end") ensureVisible(e);
  if (document.activeElement !== $("startT")) $("startT").value = fmt(s);
  if (document.activeElement !== $("endT")) $("endT").value = fmt(e);
  $("clipLen").textContent = fmt(e - s);
  drawRange();
  updateDlLabel();
  updateEstimate();
  scheduleFrames();
}
function drawRange() {
  if (!info?.duration) return;
  $("startR").value = Math.min(Math.max(info.start, view.start), view.end);
  $("endR").value = Math.min(Math.max(info.end, view.start), view.end);
  $("range").style.left = pct(info.start) + "%";
  $("range").style.width = Math.max(0, pct(info.end) - pct(info.start)) + "%";
}
function updateDlLabel() {
  if (!info) return;
  if (segments.length) {
    const joined = document.querySelector("input[name=merge]:checked")?.value === "1";
    $("dlBtn").textContent = segments.length > 1 ? T(`Télécharger les ${segments.length} extraits${joined ? " recollés" : ""}`) : T("Télécharger l'extrait de la liste");
    return;
  }
  const d = info.duration;
  $("dlBtn").textContent = T(!d || (info.start < 0.05 && info.end > d - 0.05) ? "Télécharger la vidéo entière" : "Télécharger l'extrait");
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
const isGif = () => mode === "video" && $("vFormat").value === "gif";
// Affiche seulement les réglages qui ont du sens pour le mode et le format choisis
function updateFormatUI() {
  const video = mode === "video", gif = isGif();
  const lossless = ["wav", "flac"].includes($("aFormat").value);
  $("vFormat").hidden = !video;
  $("aFormat").hidden = video;
  $("quality").hidden = !video || gif;          // le GIF est toujours en 480 px
  $("aQuality").hidden = video || lossless;     // WAV / FLAC : sans perte, pas de débit à choisir
  $("cropRow").hidden = !video;
  $("fillRow").hidden = !video || !crop;
  $("muteRow").hidden = $("sizeRow").hidden = !video || gif; // un GIF n'a pas de son ; taille réglée par la largeur
  $("normRow").hidden = gif;
  $("soundRow").hidden = gif;
  $("boomRow").hidden = !video;
  $("textRow").hidden = $("logoRow").hidden = !video;
  $("subsRow").hidden = !video || !info?.subs?.length || !info.duration;
  $("gifNote").hidden = !gif;
  updateCropUI();
  updateOptSummary();
}
// Résumé des options actives, visible même quand le bloc « Options » est replié
function updateOptSummary() {
  const video = mode === "video", gif = isGif(), sp = Number($("speed").value);
  const parts = [
    video && crop && crop + (fill === "blur" ? T(" flou") : ""), sp !== 1 && "×" + String(sp).replace(".", ","),
    video && !gif && $("mute").checked && T("sans son"),
    !gif && !(video && $("mute").checked) && $("norm").checked && T("volume"),
    $("fade").checked && T("fondu"), video && $("boomerang").checked && T("boomerang"),
    video && $("overlayText").value.trim() && T("texte"), video && $("logoPos").value && T("logo"),
    video && !$("subsRow").hidden && $("subsLang").value && T("sous-titres"),
    video && !gif && Number($("sizeMB").value) && "≤ " + $("sizeMB").value + T(" Mo"),
  ].filter(Boolean);
  $("optSummary").textContent = parts.length ? "· " + parts.join(" · ") : "";
}
$("modeSeg").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b || b.disabled) return;
  mode = b.dataset.mode;
  for (const x of $("modeSeg").children) x.classList.toggle("on", x === b);
  updateFormatUI();
  updateEstimate();
  savePrefs();
});
for (const id of ["vFormat", "aFormat", "speed", "sizeMB", "mute", "norm", "fade", "boomerang", "textPos", "subsLang", "subsMode"]) $(id).addEventListener("change", updateFormatUI);
$("overlayText").addEventListener("input", updateOptSummary);

// Cadrage : rogner (cadre à déplacer) ou garder toute l'image sur un fond flou
let fill = "crop";
$("fillSeg").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  fill = b.dataset.fill;
  for (const x of $("fillSeg").children) x.classList.toggle("on", x === b);
  updateCropUI(); updateOptSummary(); updateEstimate(); savePrefs();
});

// Logo : image choisie une fois (copiée par l'appli), puis placée dans un coin
function showLogoName(name) { $("logoName").textContent = name || ""; $("logoPick").textContent = T(name ? "Changer…" : "Choisir l'image…"); }
async function pickLogo() {
  const name = await api.chooseLogo().catch(() => null);
  if (name) { showLogoName(name); if (!$("logoPos").value) $("logoPos").value = "tr"; }
  return name;
}
$("logoPick").onclick = () => pickLogo().then(() => { updateOptSummary(); savePrefs(); });
$("logoPos").addEventListener("change", async () => {
  if ($("logoPos").value && !$("logoName").textContent && !(await pickLogo())) $("logoPos").value = "";
  updateOptSummary(); savePrefs();
});

// Sous-titres proposés par le site pour cette vidéo
function fillSubs(list) {
  const keep = $("subsLang").value;
  $("subsLang").replaceChildren(new Option(T("Aucun"), ""), ...list.map(s => new Option(s.label + (s.auto ? T(" (auto)") : ""), s.code)));
  $("subsLang").value = list.some(s => s.code === keep) ? keep : "";
}

// Menu « ⋯ » du pied de page
$("moreLink").onclick = e => { e.preventDefault(); e.stopPropagation(); $("moreMenu").hidden = !$("moreMenu").hidden; };
document.addEventListener("click", e => { if (!$("moreMenu").hidden && !e.target.closest(".more")) $("moreMenu").hidden = true; });
document.addEventListener("keydown", e => { if (e.key === "Escape") $("moreMenu").hidden = true; });
for (const id of ["termsLink", "aboutLink"]) $(id).addEventListener("click", () => { $("moreMenu").hidden = true; });
// Langue : bascule français / anglais, la page est rechargée (les choix mémorisés sont gardés)
$("langLink").textContent = EN ? "Français" : "English";
$("langLink").lang = EN ? "fr" : "en";
$("langLink").onclick = async e => {
  e.preventDefault();
  if (currentJob && !confirm(T("Un téléchargement est en cours : il sera annulé. Continuer ?"))) return;
  if (currentJob) await api.cancel(currentJob);
  await api.setLang(EN ? "fr" : "en");
  location.reload();
};

// ---------------------------------------------------------------------------
// Recadrage 9:16 / 1:1 : cadre déplaçable sur l'aperçu
// ---------------------------------------------------------------------------
let crop = "", cropPos = 0.5;
const CROP_RATIOS = { "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5 };
$("cropSeg").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  crop = b.dataset.crop;
  for (const x of $("cropSeg").children) x.classList.toggle("on", x === b);
  $("fillRow").hidden = mode !== "video" || !crop;
  updateCropUI();
  updateOptSummary();
  updateEstimate();
  savePrefs();
});

// Rectangle occupé par l'image dans le lecteur (l'image est centrée, bandes noires autour)
function videoRect() {
  const box = $("player").getBoundingClientRect();
  const a = info?.width && info?.height ? info.width / info.height : 16 / 9;
  let w = box.width, h = box.width / a;
  if (h > box.height) { h = box.height; w = h * a; }
  return { left: (box.width - w) / 2, top: (box.height - h) / 2, w, h };
}
function updateCropUI() {
  const active = !!crop && mode === "video" && !!info && fill !== "blur"; // fond flou : toute l'image est gardée
  $("cropNote").hidden = !active;
  $("cropLayer").hidden = !active;
  if (!active) return;
  const r = CROP_RATIOS[crop], v = videoRect();
  const cw = Math.min(v.w, v.h * r), ch = Math.min(v.h, v.w / r);
  const x = v.left + (v.w - cw) * cropPos, y = v.top + (v.h - ch) * cropPos;
  const f = $("cropFrame").style;
  f.width = cw + "px"; f.height = ch + "px"; f.left = x + "px"; f.top = y + "px";
  // Deux bandes sombres sur les parties coupées (à gauche/droite, ou en haut/en bas)
  const a = $("shadeA").style, b = $("shadeB").style;
  if (v.w - cw >= v.h - ch) {
    Object.assign(a, { left: v.left + "px", top: v.top + "px", width: x - v.left + "px", height: v.h + "px" });
    Object.assign(b, { left: x + cw + "px", top: v.top + "px", width: v.left + v.w - x - cw + "px", height: v.h + "px" });
  } else {
    Object.assign(a, { left: v.left + "px", top: v.top + "px", width: v.w + "px", height: y - v.top + "px" });
    Object.assign(b, { left: v.left + "px", top: y + ch + "px", width: v.w + "px", height: v.top + v.h - y - ch + "px" });
  }
  $("cropLabel").textContent = crop;
}
new ResizeObserver(() => updateCropUI()).observe($("player"));
{
  let drag = null;
  $("cropGrip").addEventListener("pointerdown", e => {
    const v = videoRect(), r = CROP_RATIOS[crop];
    const cw = Math.min(v.w, v.h * r), ch = Math.min(v.h, v.w / r);
    // Axe de déplacement : horizontal si la vidéo est plus large que le cadre, sinon vertical
    const horizontal = v.w - cw >= v.h - ch;
    drag = { x: e.clientX, y: e.clientY, pos: cropPos, span: horizontal ? v.w - cw : v.h - ch, horizontal };
    $("cropGrip").setPointerCapture(e.pointerId);
  });
  $("cropGrip").addEventListener("pointermove", e => {
    if (!drag || drag.span <= 0) return;
    const delta = drag.horizontal ? e.clientX - drag.x : e.clientY - drag.y;
    cropPos = Math.min(1, Math.max(0, drag.pos + delta / drag.span));
    updateCropUI();
  });
  const end = () => { drag = null; };
  $("cropGrip").addEventListener("pointerup", end);
  $("cropGrip").addEventListener("pointercancel", end);
}

// ---------------------------------------------------------------------------
// Plusieurs extraits
// ---------------------------------------------------------------------------
let segments = [];
function renderSegments() {
  $("segBox").hidden = !segments.length;
  $("segCount").textContent = segments.length;
  $("segList").replaceChildren(...segments.map((s, i) => {
    const li = document.createElement("li");
    const row = document.createElement("div");
    const t = document.createElement("span");
    t.className = "t"; t.title = T("Revoir / modifier ce passage");
    t.textContent = `${fmt(s.start)} → ${fmt(s.end)}  (${fmt(s.end - s.start)})` + (s.name ? "  " + s.name : "");
    t.onclick = () => { setRange(s.start, s.end); player.seek(s.start); };
    const actions = document.createElement("span"); actions.className = "row";
    const play = document.createElement("button"); play.type = "button"; play.className = "small"; play.textContent = "▶";
    play.title = T("Écouter"); play.onclick = () => { player.seek(s.start); player.play(); previewStop = s.end; };
    const del = document.createElement("button"); del.type = "button"; del.className = "small"; del.textContent = "✕";
    del.title = T("Retirer"); del.onclick = () => { segments.splice(i, 1); renderSegments(); };
    actions.append(play, del);
    row.append(t, actions); li.append(row);
    return li;
  }));
  updateDlLabel();
  updateEstimate();
}
function addSegment() {
  if (!info?.duration) return;
  if (segments.length >= 20) return;
  if (segments.some(s => Math.abs(s.start - info.start) < 0.05 && Math.abs(s.end - info.end) < 0.05)) return;
  segments.push({ start: info.start, end: info.end });
  segments.sort((a, b) => a.start - b.start);
  renderSegments();
}
$("addSeg").onclick = addSegment;
$("segClear").onclick = () => { segments = []; renderSegments(); };
const setMerge = on => { document.querySelector(`input[name=merge][value="${on ? 1 : 0}"]`).checked = true; };

// « Enlever » : le passage choisi (ou ceux de la liste) est retiré, tout le reste est gardé et recollé
function removeSelection() {
  if (!info?.duration) return;
  const d = info.duration, cuts = (segments.length ? segments : [{ start: info.start, end: info.end }]).slice().sort((a, b) => a.start - b.start);
  const keep = [];
  let t = 0;
  for (const c of cuts) { if (c.start - t >= 0.3) keep.push({ start: t, end: c.start }); t = Math.max(t, c.end); }
  if (d - t >= 0.3) keep.push({ start: t, end: d });
  if (!keep.length || keep.length > 20) return;
  segments = keep;
  setMerge(keep.length > 1);
  renderSegments();
  $("segBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
$("removeSeg").onclick = removeSelection;

// Chapitres de la vidéo : choisir un chapitre règle le passage ; « tous » les met dans la liste, un fichier chacun
function fillChapters(list) {
  const sel = $("chapterSel");
  sel.hidden = !list.length;
  if (!list.length) { sel.replaceChildren(); return; }
  sel.replaceChildren(new Option(T(`Chapitres (${list.length})…`), ""),
    ...list.map((c, i) => new Option(`${fmt(c.start).replace(/\.\d$/, "")}  ${c.title || T("Chapitre ") + (i + 1)}`, String(i))),
    new Option(T("↳ Tous les chapitres, un fichier chacun"), "all"));
  sel.value = "";
}
$("chapterSel").addEventListener("change", () => {
  const list = info?.chapters || [], v = $("chapterSel").value;
  $("chapterSel").value = "";
  if (v === "all") {
    const base = $("fileName").value.trim() || info.title;
    segments = list.slice(0, 20).map((c, i) => ({ start: c.start, end: Math.min(c.end, info.duration), name: `${base} - ${String(i + 1).padStart(2, "0")} ${c.title}`.slice(0, 150) }));
    setMerge(false);
    renderSegments();
    return;
  }
  const c = list[Number(v)];
  if (c) { setRange(c.start, Math.min(c.end, info.duration)); ensureVisible(c.start); player.seek(c.start); }
});

// ---------------------------------------------------------------------------
// Miniatures du début et de la fin de l'extrait (images extraites par le moteur)
// ---------------------------------------------------------------------------
let frameTimer = null, frameReq = 0;
function scheduleFrames() {
  if (!info?.frames || !info.duration || $("frames").hidden) return;
  clearTimeout(frameTimer);
  frameTimer = setTimeout(async () => {
    const req = ++frameReq, s = info.start, e = Math.max(s, info.end - 0.1), token = info.token;
    $("frameStartT").textContent = fmt(s); $("frameEndT").textContent = fmt(info.end);
    for (const img of [$("frameStart"), $("frameEnd")]) img.classList.add("loading");
    const [a, b] = await Promise.all([api.frameAt(token, s), api.frameAt(token, e)]).catch(() => [null, null]);
    if (req !== frameReq || token !== info?.token) return; // une demande plus récente a pris le relais
    for (const [img, src] of [[$("frameStart"), a], [$("frameEnd"), b]]) {
      img.classList.remove("loading");
      if (src && /^data:image\/jpeg;base64,/.test(src)) img.src = src; else img.removeAttribute("src");
    }
  }, 350);
}

// ---------------------------------------------------------------------------
// Nom du fichier : proposé à partir du titre, nettoyé si demandé, modifiable
// ---------------------------------------------------------------------------
let nameEdited = false;
function cleanTitle(t) {
  const s = String(t || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#@][\p{L}\p{N}_]+/gu, " ")
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}‍️⃣]/gu, " ")
    .replace(/…|\.{3,}/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—|·:,.]+|[\s\-–—|·:,]+$/g, "")
    .trim();
  return s || String(t || "").trim();
}
function fillName() {
  if (!info || nameEdited) return;
  $("fileName").value = ($("cleanNames").checked ? cleanTitle(info.title) : info.title).slice(0, 150);
}
$("fileName").addEventListener("input", () => { nameEdited = true; });
$("cleanNames").addEventListener("change", () => { nameEdited = false; fillName(); savePrefs(); });

// ---------------------------------------------------------------------------
// Taille estimée du fichier (à partir des débits annoncés par le site)
// ---------------------------------------------------------------------------
const AUDIO_KBPS = { mp3: 245, wav: 1411, flac: 900, m4a: 256, ogg: 192, opus: 160 };
function humanSize(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1).replace(".", EN ? "." : ",") + T(" Go");
  if (bytes >= 1024 ** 2) return Math.round(bytes / 1024 ** 2) + T(" Mo");
  return Math.max(1, Math.round(bytes / 1024)) + T(" Ko");
}
function updateEstimate() {
  const out = $("sizeEst");
  if (!info) { out.textContent = "—"; return; }
  const speed = Number($("speed").value) || 1;
  const lens = segments.length ? segments.map(s => s.end - s.start) : [info.duration ? info.end - info.start : 0];
  const total = lens.reduce((a, b) => a + b, 0) / speed * (mode === "video" && $("boomerang").checked ? 2 : 1);
  if (!total) { out.textContent = T("inconnue (durée non fournie par le site)"); return; }
  // Part de l'image gardée (rogné) ou taille de l'image finale (fond flou), par rapport à l'originale
  const aspect = info.width && info.height ? info.width / info.height : 16 / 9, r = CROP_RATIOS[crop];
  const area = !r ? 1 : fill === "blur" ? (aspect >= r ? 1 / (aspect * r) : aspect / r) : Math.min(r / aspect, aspect / r);
  let kbps;
  if (mode === "audio") kbps = $("aQuality").hidden || $("aQuality").value === "0" ? AUDIO_KBPS[$("aFormat").value] || 192 : Number($("aQuality").value);
  // Mesuré : GIF 480 px / 12 i/s ≈ 680 Ko par seconde en paysage ; vertical / carré : 480 px de haut, donc plus lourd selon la largeur
  else if (isGif()) kbps = 5500 * (r ? 1.6 * r * (fill === "blur" ? 1.1 : 1) : 1);
  else {
    const hs = info.heights || [], q = $("quality").value;
    const h = q === "auto" ? hs[0] : Number(q);
    const vk = info.rates?.video?.[h] || Object.values(info.rates?.video || {})[0];
    if (!vk) { out.textContent = T("inconnue pour ce site"); return; }
    kbps = vk * area + ($("mute").checked ? 0 : info.rates.audio || 128);
  }
  let bytes = (kbps * 1000 / 8) * total;
  const target = mode === "video" && !isGif() ? Number($("sizeMB").value) * 1024 * 1024 : 0;
  const files = segments.length > 1 && document.querySelector("input[name=merge]:checked")?.value !== "1" ? segments.length : 1;
  if (target) bytes = Math.min(bytes, target * files);
  out.textContent = "≈ " + humanSize(bytes) + (files > 1 ? T(` au total (${files} fichiers)`) : "") + (target ? T(` · maxi ${$("sizeMB").value} Mo par fichier`) : "");
}
for (const id of ["quality", "aQuality", "vFormat", "aFormat", "speed", "sizeMB", "mute", "norm", "fade", "boomerang", "textPos", "logoPos", "subsMode"]) $(id).addEventListener("change", () => { updateEstimate(); savePrefs(); });
for (const r of document.querySelectorAll("input[name=merge]")) r.addEventListener("change", () => { updateEstimate(); updateDlLabel(); savePrefs(); });

// ---------------------------------------------------------------------------
// Derniers choix mémorisés d'une ouverture à l'autre
// ---------------------------------------------------------------------------
let prefsReady = false, prefsTimer = null;
function savePrefs() {
  if (!prefsReady) return;
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => api.savePrefs({
    mode, vFormat: $("vFormat").value, aFormat: $("aFormat").value, crop, fill, speed: Number($("speed").value),
    sizeMB: Number($("sizeMB").value), merge: document.querySelector("input[name=merge]:checked")?.value === "1",
    mute: $("mute").checked, cleanNames: $("cleanNames").checked, aQuality: $("aQuality").value,
    fade: $("fade").checked, norm: $("norm").checked, logoPos: $("logoPos").value, textPos: $("textPos").value, subsMode: $("subsMode").value,
  }), 300);
}
function applyPrefs(p) {
  if (p.vFormat) $("vFormat").value = p.vFormat;
  if (p.aFormat) $("aFormat").value = p.aFormat;
  if (p.aQuality) $("aQuality").value = p.aQuality;
  if (p.speed) $("speed").value = String(p.speed);
  if (p.sizeMB !== undefined) $("sizeMB").value = String(p.sizeMB);
  for (const k of ["mute", "cleanNames", "fade", "norm"]) if (typeof p[k] === "boolean") $(k).checked = p[k];
  for (const k of ["textPos", "subsMode"]) if (p[k]) $(k).value = p[k];
  if (p.logoPos && $("logoName").textContent) $("logoPos").value = p.logoPos; // seulement si un logo a déjà été choisi
  if (typeof p.merge === "boolean") setMerge(p.merge);
  if (p.fill) $("fillSeg").querySelector(`[data-fill="${p.fill}"]`)?.click();
  if (p.crop !== undefined) $("cropSeg").querySelector(`[data-crop="${p.crop}"]`)?.click();
  if (p.mode) $("modeSeg").querySelector(`[data-mode="${p.mode}"]`)?.click();
  updateFormatUI();
  prefsReady = true;
}

// Réglages du téléchargement tels qu'affichés à l'écran (communs au bouton Télécharger et à la file d'attente)
function currentOpts() {
  return {
    mode, format: mode === "audio" ? $("aFormat").value : $("vFormat").value, quality: $("quality").value,
    merge: document.querySelector("input[name=merge]:checked")?.value === "1",
    crop: mode === "video" ? crop : "", cropPos, fill,
    speed: Number($("speed").value) || 1, mute: mode === "video" && !isGif() && $("mute").checked,
    sizeMB: mode === "video" && !isGif() ? Number($("sizeMB").value) : 0,
    aQuality: $("aQuality").value, fade: $("fade").checked, norm: $("norm").checked,
    boomerang: mode === "video" && $("boomerang").checked,
    text: mode === "video" ? $("overlayText").value.trim() : "", textPos: $("textPos").value,
    logoPos: mode === "video" ? $("logoPos").value : "",
    subsLang: mode === "video" && !$("subsRow").hidden ? $("subsLang").value : "", subsMode: $("subsMode").value,
  };
}

// ---------------------------------------------------------------------------
// Téléchargement
// ---------------------------------------------------------------------------
function resetProgressUI() {
  $("progress").hidden = false;
  $("result").hidden = true; $("dlErr").hidden = true;
  $("bar").classList.add("indet"); $("bar").firstElementChild.style.width = "";
  $("status").textContent = T("Démarrage…");
  $("cancelBtn").hidden = false;
}
function finish() { currentJob = null; $("dlBtn").disabled = false; $("cancelBtn").hidden = true; }

$("dlBtn").onclick = async () => {
  $("dlBtn").disabled = true;
  resetProgressUI();
  const r = await api.download({
    ...currentOpts(), token: info.token, start: info.start, end: info.end, segments, name: $("fileName").value.trim(),
  }).catch(() => ({ error: "Erreur inattendue." }));
  if (r.error) { finish(); $("bar").classList.remove("indet"); $("dlErr").textContent = T(r.error); $("dlErr").hidden = false; return; }
  currentJob = r.id;
};
$("cancelBtn").onclick = () => currentJob && api.cancel(currentJob);

api.onProgress(p => {
  if (queueProgress(p)) return; // téléchargement lancé par la file d'attente
  if (p.id !== currentJob) return;
  if (p.percent != null) { $("bar").classList.remove("indet"); $("bar").firstElementChild.style.width = p.percent + "%"; }
  $("status").textContent = T(p.line) + (p.percent != null && p.status === "running" ? ` ${Math.round(p.percent)} %` : "");
  if (p.status === "running") return;
  finish();
  if (p.status === "done") {
    doneJob = p.id;
    const files = p.files || [];
    $("doneText").textContent = files.length > 1 ? T(`✓ ${files.length} fichiers enregistrés`) : T("✓ Fichier enregistré");
    renderFileList(p.id, files);
    $("result").hidden = false;
  } else if (p.status === "cancelled") {
    $("bar").classList.remove("indet"); $("bar").firstElementChild.style.width = "0";
  } else {
    $("bar").classList.remove("indet");
    $("dlErr").textContent = T("Échec : ") + T(p.error); $("dlErr").hidden = false;
  }
});
$("reveal").onclick = () => doneJob && api.reveal(doneJob);
$("openFile").onclick = () => doneJob && api.openFile(doneJob);

// Fichiers terminés : on peut les attraper et les lâcher dans un autre logiciel
function renderFileList(jobId, files) {
  $("fileList").replaceChildren(...files.map((name, i) => {
    const li = document.createElement("li");
    li.draggable = true;
    li.title = T("Glisse ce fichier vers ton logiciel de montage, Discord, un dossier…");
    const grip = document.createElement("span"); grip.className = "grip"; grip.textContent = "⠿";
    const label = document.createElement("span"); label.textContent = name;
    li.append(grip, label);
    li.addEventListener("dragstart", e => { e.preventDefault(); api.startDrag(jobId, i); });
    return li;
  }));
}

// ---------------------------------------------------------------------------
// Images : capture de l'image affichée (PNG) et miniature de la vidéo
// ---------------------------------------------------------------------------
function showSnap(r) {
  const box = $("snapMsg");
  box.hidden = false;
  if (r.error) { box.className = "snap-msg err"; box.textContent = T(r.error); return; }
  box.className = "snap-msg";
  const item = document.createElement("span");
  item.className = "snap-file"; item.draggable = true; item.textContent = "✓ " + r.file;
  item.title = T("Glisse ce fichier vers ton logiciel de montage, Discord, un dossier…");
  item.addEventListener("dragstart", e => { e.preventDefault(); api.startDrag(r.id, 0); });
  const open = document.createElement("a"); open.href = "#"; open.textContent = T("Ouvrir");
  open.onclick = e => { e.preventDefault(); api.openFile(r.id); };
  const show = document.createElement("a"); show.href = "#"; show.textContent = T("Dossier");
  show.onclick = e => { e.preventDefault(); api.reveal(r.id); };
  box.replaceChildren(item, open, show);
}
async function takeSnapshot() {
  if (!info?.still || !info.duration || $("snapBtn").disabled) return;
  const b = $("snapBtn");
  b.disabled = true;
  const r = await api.snapshot({ token: info.token, t: player.kind === "none" ? info.start : player.now(), crop: mode === "video" ? crop : "", cropPos, fill, name: $("fileName").value.trim() })
    .catch(() => ({ error: "Erreur inattendue." }));
  b.disabled = false;
  showSnap(r);
}
$("snapBtn").onclick = takeSnapshot;
$("thumbLink").onclick = async e => {
  e.preventDefault();
  if (!info) return;
  showSnap(await api.saveThumb({ token: info.token, name: $("fileName").value.trim() }).catch(() => ({ error: "Erreur inattendue." })));
};
$("playlistLink").onclick = async e => {
  e.preventDefault();
  if (!info) return;
  const link = $("playlistLink"), label = link.textContent;
  link.textContent = T("📃 Lecture de la playlist…");
  const n = await addPlaylistToQueue($("url").value.trim() || info.url);
  link.textContent = label;
  showSnap(typeof n === "string" ? { error: n } : { id: null, file: "" });
  if (typeof n === "number") {
    $("snapMsg").textContent = T(`✓ ${n} vidéos ajoutées à la file d'attente`);
    openQueuePanel();
  }
};

// ---------------------------------------------------------------------------
// Pied de page : dossier + version de yt-dlp
// ---------------------------------------------------------------------------
async function refreshSettings() {
  const s = await api.getSettings();
  $("folderLink").textContent = s.downloadDir;
  $("ytVer").textContent = s.ytdlp || "?";
  $("appVer").textContent = s.version ? "v" + s.version : "";
  showLogoName(s.logo);
  if (!prefsReady) applyPrefs(s.prefs || {});
}
$("folderLink").onclick = e => { e.preventDefault(); api.openFolder(); };
$("changeFolder").onclick = async e => { e.preventDefault(); $("folderLink").textContent = await api.chooseFolder(); };
$("updateLink").onclick = async e => {
  e.preventDefault();
  const link = $("updateLink");
  link.textContent = T("recherche…");
  const r = await api.updateYtdlp();
  link.textContent = T(r.busy ? "attends la fin du téléchargement"
    : r.error ? "échec de la mise à jour"
    : r.updated ? "mis à jour ✓" : "déjà à jour ✓");
  refreshSettings();
  setTimeout(() => { link.textContent = T("Mettre à jour yt-dlp"); }, 4000);
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
    btn.type = "button"; btn.className = "small"; btn.textContent = T("Déconnecter");
    btn.onclick = async () => { btn.disabled = true; await api.loginForget(domain); refreshLogins(); };
    li.append(name, btn);
    return li;
  });
  if (!items.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = T("Aucune connexion enregistrée."); items.push(li); }
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
  if (!confirm(T("Se déconnecter de tous les sites dans l'appli ?"))) return;
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

// ---------------------------------------------------------------------------
// Raccourcis clavier (comme dans un logiciel de montage)
// ---------------------------------------------------------------------------
// Fenêtre d'aide des raccourcis : bouton, touche « ? », fermeture par Échap / bouton / clic à côté
const showKeys = () => { $("keysModal").hidden = false; $("keysClose").focus(); };
const hideKeys = () => { $("keysModal").hidden = true; };
$("keysBtn").onclick = showKeys;
$("keysClose").onclick = hideKeys;
$("keysModal").addEventListener("click", e => { if (e.target === $("keysModal")) hideKeys(); });
document.addEventListener("keydown", e => {
  if (!$("keysModal").hidden && e.key === "Escape") { hideKeys(); e.preventDefault(); return; }
  if (e.key === "?" && $("terms").hidden && !e.target.closest?.("input, select, textarea")) { showKeys(); e.preventDefault(); }
});

document.addEventListener("keydown", e => {
  if (!info || $("editor").hidden || !$("terms").hidden || !$("keysModal").hidden) return;
  const t = e.target;
  if (t.closest?.("input, select, textarea, [contenteditable]") || e.ctrlKey || e.altKey || e.metaKey) return;
  const hasCut = !!info.duration;
  const step = e.shiftKey ? 0.1 : 1;
  switch (e.key.toLowerCase()) {
    case " ": player.toggle(); break;
    case "i": if (hasCut) setRange(player.now(), info.end, "start"); break;
    case "o": if (hasCut) setRange(info.start, player.now(), "end"); break;
    case "p": if (hasCut) $("preview").click(); break;
    case "a": if (hasCut) addSegment(); break;
    case "x": if (hasCut) removeSelection(); break;
    case "s": takeSnapshot(); break;
    case "arrowleft": player.seek(Math.max(0, player.now() - step)); break;
    case "arrowright": player.seek(Math.min(info.duration || Infinity, player.now() + step)); break;
    default: return;
  }
  e.preventDefault();
});

// ---------------------------------------------------------------------------
// Lien dans le presse-papiers : proposé quand l'appli reprend la main
// ---------------------------------------------------------------------------
let lastClip = null;
async function checkClipboard() {
  if (!$("terms").hidden) return;
  const link = await api.clipboardLink().catch(() => null);
  if (!link || link === lastClip || link === info?.url || link === $("url").value.trim()) return;
  lastClip = link;
  $("clipText").textContent = link.length > 90 ? link.slice(0, 87) + "…" : link;
  $("clipSuggest").dataset.link = link;
  $("clipSuggest").hidden = false;
}
$("clipUse").onclick = () => {
  $("url").value = $("clipSuggest").dataset.link || "";
  $("clipSuggest").hidden = true;
  $("urlForm").requestSubmit();
};
$("clipDismiss").onclick = () => { $("clipSuggest").hidden = true; };
window.addEventListener("focus", checkClipboard);
setTimeout(checkClipboard, 600);

// ---------------------------------------------------------------------------
// Glisser-déposer d'un lien (depuis la barre d'adresse ou une page web)
// ---------------------------------------------------------------------------
{
  let depth = 0;
  const isLink = e => [...(e.dataTransfer?.types || [])].some(t => t === "text/uri-list" || t === "text/plain");
  window.addEventListener("dragenter", e => { if (!isLink(e)) return; depth++; $("dropHint").hidden = false; e.preventDefault(); });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; $("dropHint").hidden = true; } });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => {
    e.preventDefault();
    depth = 0; $("dropHint").hidden = true;
    if (!$("terms").hidden) return;
    const raw = (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || "")
      .split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith("#"));
    if (!raw) return;
    $("url").value = raw;
    $("urlForm").requestSubmit();
  });
}

// ---------------------------------------------------------------------------
// Historique
// ---------------------------------------------------------------------------
async function refreshHistory() {
  const list = await api.historyList();
  const items = list.map(h => {
    const li = document.createElement("li");
    const info2 = document.createElement("div");
    const title = document.createElement("div"); title.className = "h-title"; title.textContent = h.title;
    const meta = document.createElement("div"); meta.className = "h-meta";
    const date = new Date(h.date).toLocaleString(EN ? "en-GB" : "fr-FR", { dateStyle: "short", timeStyle: "short" });
    const what = [h.format.toUpperCase(), h.crop, h.segments > 1 ? T(`${h.segments} extraits${h.merged ? " recollés" : ""}`) : ""].filter(Boolean).join(" · ");
    meta.textContent = [h.site, date, what, h.exists ? "" : T("fichier introuvable")].filter(Boolean).join(" · ");
    info2.append(title, meta);
    const actions = document.createElement("div"); actions.className = "h-actions";
    const open = document.createElement("button"); open.type = "button"; open.className = "small"; open.textContent = "📂";
    open.title = T("Afficher dans le dossier"); open.disabled = !h.exists; open.onclick = () => api.historyReveal(h.id);
    const again = document.createElement("button"); again.type = "button"; again.className = "small"; again.textContent = "↻";
    again.title = T("Recharger cette vidéo"); again.disabled = !h.url;
    again.onclick = () => { $("url").value = h.url; $("historyPanel").hidden = true; $("urlForm").requestSubmit(); window.scrollTo({ top: 0, behavior: "smooth" }); };
    const del = document.createElement("button"); del.type = "button"; del.className = "small"; del.textContent = "✕";
    del.title = T("Retirer de l'historique"); del.onclick = async () => { await api.historyRemove(h.id); refreshHistory(); };
    actions.append(open, again, del);
    li.append(info2, actions);
    return li;
  });
  if (!items.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = T("Aucun téléchargement pour l'instant."); items.push(li); }
  $("historyList").replaceChildren(...items);
  $("historyClear").hidden = !list.length;
}
$("historyLink").onclick = e => {
  e.preventDefault();
  $("historyPanel").hidden = !$("historyPanel").hidden;
  if (!$("historyPanel").hidden) { refreshHistory(); $("historyPanel").scrollIntoView({ behavior: "smooth" }); }
};
$("historyClose").onclick = () => { $("historyPanel").hidden = true; };
$("historyClear").onclick = async () => {
  if (!confirm(T("Effacer tout l'historique ? (les fichiers téléchargés ne sont pas supprimés)"))) return;
  await api.historyClear(); refreshHistory();
};
api.onHistoryChanged(() => { if (!$("historyPanel").hidden) refreshHistory(); });

// ---------------------------------------------------------------------------
// Mise à jour de l'appli
// ---------------------------------------------------------------------------
// « Quoi de neuf ? » : notes de la release, affichées comme du texte simple
const hideNotes = () => { $("notesModal").hidden = true; };
$("notesClose").onclick = hideNotes;
$("notesModal").addEventListener("click", e => { if (e.target === $("notesModal")) hideNotes(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("notesModal").hidden) { hideNotes(); e.preventDefault(); } });
$("notesUpdate").onclick = () => { hideNotes(); $("updBtn").click(); };

api.onAppUpdate(s => {
  const banner = $("updBanner"), btn = $("updBtn"), notesBtn = $("updNotesBtn");
  if (s.state === "available") {
    $("updText").textContent = T(`🎉 VideoCutter ${s.version} est disponible.`);
    btn.textContent = T("Mettre à jour"); btn.disabled = false; btn.hidden = false;
    btn.onclick = () => { btn.disabled = true; notesBtn.hidden = true; $("updText").textContent = T("Téléchargement de la mise à jour…"); api.appUpdateDownload(); };
    const notes = typeof s.notes === "string" ? s.notes.trim() : "";
    notesBtn.hidden = !notes;
    notesBtn.onclick = () => {
      $("notesTitle").textContent = T(`Quoi de neuf dans la ${s.version} ?`);
      $("notesText").textContent = notes;
      $("notesUpdate").hidden = btn.disabled;
      $("notesModal").hidden = false; $("notesClose").focus();
    };
    banner.hidden = false;
  } else if (s.state === "downloading") {
    $("updText").textContent = T("Téléchargement de la mise à jour…") + ` ${s.percent} %`;
    btn.hidden = true; notesBtn.hidden = true; banner.hidden = false;
  } else if (s.state === "ready") {
    $("updText").textContent = T(`✓ VideoCutter ${s.version} est prêt à être installé.`);
    btn.textContent = T("Redémarrer et installer"); btn.disabled = false; btn.hidden = false;
    btn.onclick = () => {
      if (currentJob && !confirm(T("Un téléchargement est en cours : il sera annulé. Continuer ?"))) return;
      api.appUpdateInstall();
    };
    banner.hidden = false;
  } else if (s.state === "error" && !banner.hidden) {
    $("updText").textContent = T("La mise à jour n'a pas pu être téléchargée. Elle sera proposée à nouveau au prochain lancement.");
    btn.hidden = true;
  }
});
// ---------------------------------------------------------------------------
// File d'attente : téléchargements l'un après l'autre
// ---------------------------------------------------------------------------
let queue = [], queueRunning = false, queueStopAsked = false, queueSeq = 0;
const queueWaiters = new Map(); // id de tâche -> fonction appelée à la fin du téléchargement
const Q_STATUS = { waiting: "En attente", running: "En cours…", done: "✓ Terminé", error: "Échec", cancelled: "Annulé" };

function renderQueue() {
  const waiting = queue.filter(q => q.status === "waiting").length;
  $("queueBadge").textContent = waiting ? `(${waiting})` : "";
  $("queueList").replaceChildren(...queue.map(q => {
    const li = document.createElement("li");
    li.className = "q-" + q.status;
    const text = document.createElement("div");
    const title = document.createElement("div"); title.className = "h-title"; title.textContent = q.title;
    const meta = document.createElement("div"); meta.className = "h-meta";
    meta.textContent = [T(Q_STATUS[q.status]) + (q.status === "running" && q.percent != null ? ` ${Math.round(q.percent)} %` : ""), q.detail, T(q.msg || "")].filter(Boolean).join(" · ");
    text.append(title, meta);
    const actions = document.createElement("div"); actions.className = "h-actions";
    if (q.status === "waiting" || q.status === "running") {
      const x = document.createElement("button"); x.type = "button"; x.className = "small"; x.textContent = "✕";
      x.title = T(q.status === "running" ? "Annuler ce téléchargement" : "Retirer de la file");
      x.onclick = () => { if (q.status === "running") api.cancel(q.jobId); else { queue = queue.filter(o => o !== q); renderQueue(); } };
      actions.append(x);
    }
    li.append(text, actions);
    return li;
  }));
  $("queueStart").hidden = queueRunning;
  $("queueStart").disabled = !waiting;
  $("queueStop").hidden = !queueRunning;
}
const describe = o => [T(o.mode === "audio" ? "Musique " : "Vidéo ") + o.format.toUpperCase(),
  o.crop && o.crop + (o.fill === "blur" ? T(" flou") : ""), o.speed !== 1 ? "×" + String(o.speed).replace(".", ",") : "", o.mute ? T("sans son") : "",
  o.boomerang && T("boomerang"), o.fade && T("fondu"), o.norm && T("volume"), o.text && T("texte"), o.logoPos && T("logo"), o.subsLang && T("sous-titres"),
  o.sizeMB ? `< ${o.sizeMB}${T(" Mo")}` : ""].filter(Boolean).join(" · ");

// Ajoute l'extrait actuellement réglé (mêmes réglages que le bouton Télécharger)
$("queueAdd").onclick = () => {
  if (!info) return;
  const opts = { ...currentOpts(), start: info.start, end: info.end, segments: segments.map(s => ({ ...s })), name: $("fileName").value.trim() };
  const parts = segments.length ? T(`${segments.length} extrait${segments.length > 1 ? "s" : ""}`) : info.duration && (info.start > 0.05 || info.end < info.duration - 0.05) ? `${fmt(info.start)} → ${fmt(info.end)}` : T("vidéo entière");
  queue.push({ id: ++queueSeq, status: "waiting", token: info.token, title: $("fileName").value.trim() || info.title, opts, detail: parts + " · " + describe(opts) });
  renderQueue();
  const b = $("queueAdd"); b.textContent = "✓"; setTimeout(() => { b.textContent = "＋"; }, 1500);
};

// Réglages appliqués aux vidéos entières ajoutées par lien : le cadre, les sous-titres et le boomerang dépendent de chaque vidéo
const wholeVideoOpts = () => ({ ...currentOpts(), crop: "", segments: [], merge: false, subsLang: "", boomerang: false });
const queueLinks = entries => {
  const base = wholeVideoOpts();
  for (const e of entries) queue.push({ id: ++queueSeq, status: "waiting", url: e.url, title: e.title || e.url, opts: { ...base }, detail: T("vidéo entière") + " · " + describe(base) });
  renderQueue();
};
const isPlaylistLink = s => /[?&]list=|\/(playlist|sets|album)\b/i.test(s);
// Playlist : toutes ses vidéos vont dans la file d'attente. Renvoie le nombre ajouté, ou un message d'erreur.
async function addPlaylistToQueue(url) {
  const r = await api.playlistEntries(url).catch(() => ({ error: "Erreur inattendue." }));
  if (r.error) return r.error.split("\n")[0];
  if (!r.entries?.length) return "Aucune vidéo trouvée dans cette playlist.";
  queueLinks(r.entries);
  return r.entries.length;
}
function openQueuePanel() { $("queuePanel").hidden = false; renderQueue(); $("queuePanel").scrollIntoView({ behavior: "smooth" }); }

// Plusieurs liens collés : chaque vidéo en entier, avec les réglages de format actuels (une playlist ajoute toutes ses vidéos)
$("bulkAdd").onclick = async () => {
  const links = [...new Set($("bulkLinks").value.split(/\s+/).map(s => s.trim()).filter(s => /^https?:\/\/\S+$/i.test(s)))].slice(0, 50);
  if (!links.length) { $("bulkMsg").textContent = T("Aucun lien valide (ils doivent commencer par https://)."); return; }
  $("bulkAdd").disabled = true;
  let added = 0;
  const errors = [];
  for (const url of links) {
    if (isPlaylistLink(url)) {
      $("bulkMsg").textContent = T("📃 Lecture de la playlist…");
      const n = await addPlaylistToQueue(url);
      if (typeof n === "number") added += n; else errors.push(T(n));
    } else { queueLinks([{ url }]); added++; }
  }
  $("bulkAdd").disabled = false;
  $("bulkLinks").value = "";
  $("bulkMsg").textContent = T(`${added} lien${added > 1 ? "s" : ""} ajouté${added > 1 ? "s" : ""}.`) + (errors.length ? " " + errors[0] : "");
};

function queueProgress(p) {
  const q = queue.find(o => o.jobId === p.id);
  if (!q) return false;
  q.percent = p.percent;
  if (p.status !== "running") {
    q.status = p.status;
    q.msg = p.status === "error" ? p.error : p.status === "done" ? (p.files || []).join(", ") : "";
    queueWaiters.get(p.id)?.();
  }
  renderQueue();
  return true;
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true; queueStopAsked = false; renderQueue();
  let q;
  while (!queueStopAsked && (q = queue.find(o => o.status === "waiting"))) {
    q.status = "running"; q.percent = null; q.msg = ""; renderQueue();
    try {
      if (!q.token) { // lien collé : on lit d'abord les infos de la vidéo
        q.msg = "lecture du lien…"; renderQueue();
        const j = await api.info(q.url);
        if (j.error) { q.status = "error"; q.msg = j.error.split("\n")[0]; continue; }
        if (j.isLive) { q.status = "error"; q.msg = "direct en cours"; continue; }
        q.token = j.token; q.title = j.title; q.msg = "";
        if (q.opts.mode === "video" && !j.hasVideo) q.opts.mode = "audio", q.opts.format = "mp3";
        q.opts.name = $("cleanNames").checked ? cleanTitle(j.title) : j.title;
      }
      const r = await api.download({ ...q.opts, token: q.token });
      if (r.error) { q.status = "error"; q.msg = r.error; continue; }
      q.jobId = r.id; renderQueue();
      await new Promise(res => queueWaiters.set(r.id, res));
      queueWaiters.delete(r.id);
    } catch { q.status = "error"; q.msg = "erreur inattendue"; }
    finally { renderQueue(); }
  }
  queueRunning = false;
  $("queueStop").textContent = T("⏸ Arrêter après le téléchargement en cours");
  renderQueue();
}
$("queueStart").onclick = runQueue;
$("queueStop").onclick = () => { queueStopAsked = true; $("queueStop").textContent = T("⏸ Arrêt après ce téléchargement…"); };
$("queueClear").onclick = () => { queue = queue.filter(q => q.status === "running"); renderQueue(); };
$("queueLink").onclick = e => {
  e.preventDefault();
  if ($("queuePanel").hidden) openQueuePanel(); else $("queuePanel").hidden = true;
};
$("queueClose").onclick = () => { $("queuePanel").hidden = true; };
renderQueue();

// Après la fermeture d'une fenêtre de connexion : mise à jour de la liste, et nouvel essai du lien en échec
api.onLoginChanged(() => {
  if (!$("loginPanel").hidden) refreshLogins();
  if (loginTarget && !$("loadErr").hidden) $("urlForm").requestSubmit();
});
