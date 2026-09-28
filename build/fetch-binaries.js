// Prépare le dossier vendor/ : yt-dlp.exe + FFmpeg (version "shared", plus légère).
// Chaque fichier téléchargé est vérifié avec l'empreinte SHA-256 publiée par le projet d'origine.
// Utilisation : node build/fetch-binaries.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const VENDOR = path.join(__dirname, "..", "vendor");
const TMP = path.join(__dirname, "..", ".cache");
fs.mkdirSync(VENDOR, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function get(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function expectedHash(sumsText, fileName) {
  const line = sumsText.split(/\r?\n/).find(l => l.trim().split(/\s+\*?/).pop() === fileName);
  if (!line) throw new Error(`Empreinte introuvable pour ${fileName}`);
  return line.trim().split(/\s+/)[0].toLowerCase();
}

function verify(file, expected) {
  const actual = sha256(file);
  if (!/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
    fs.rmSync(file, { force: true });
    throw new Error(`EMPREINTE INCORRECTE pour ${path.basename(file)}\n attendu ${expected}\n obtenu  ${actual}`);
  }
  console.log(`  ✓ ${path.basename(file)} vérifié (${actual.slice(0, 16)}…)`);
}

(async () => {
  // --- yt-dlp (dernière version stable, variante "dossier" : démarre ~3x plus vite que l'exe unique) ---
  console.log("yt-dlp :");
  const rel = await (await fetch("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")).json();
  const ytBase = `https://github.com/yt-dlp/yt-dlp/releases/download/${rel.tag_name}`;
  const ytSums = (await get(`${ytBase}/SHA2-256SUMS`)).toString("utf8");
  const ytZip = path.join(TMP, "yt-dlp_win.zip");
  if (!fs.existsSync(ytZip) || sha256(ytZip) !== expectedHash(ytSums, "yt-dlp_win.zip")) {
    fs.writeFileSync(ytZip, await get(`${ytBase}/yt-dlp_win.zip`));
  }
  verify(ytZip, expectedHash(ytSums, "yt-dlp_win.zip"));
  const ytDir = path.join(VENDOR, "yt-dlp");
  fs.rmSync(ytDir, { recursive: true, force: true });
  fs.mkdirSync(ytDir, { recursive: true });
  execFileSync("tar", ["-xf", ytZip, "-C", ytDir]);
  fs.rmSync(path.join(VENDOR, "yt-dlp.exe"), { force: true }); // ancienne variante
  console.log(`  version ${rel.tag_name}`);

  // --- FFmpeg (builds officiels de l'équipe yt-dlp, variante GPL partagée) ---
  console.log("FFmpeg :");
  const ffBase = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest";
  const ffZipName = "ffmpeg-master-latest-win64-gpl-shared.zip";
  const ffSums = (await get(`${ffBase}/checksums.sha256`)).toString("utf8");
  const zip = path.join(TMP, ffZipName);
  if (!fs.existsSync(zip) || sha256(zip) !== expectedHash(ffSums, ffZipName)) {
    fs.writeFileSync(zip, await get(`${ffBase}/${ffZipName}`));
  }
  verify(zip, expectedHash(ffSums, ffZipName));

  const out = path.join(TMP, "ffmpeg");
  fs.rmSync(out, { recursive: true, force: true });
  execFileSync("tar", ["-xf", zip, "-C", TMP]);
  const extracted = fs.readdirSync(TMP).find(d => d.startsWith("ffmpeg-") && !d.endsWith(".zip"));
  const bin = path.join(TMP, extracted, "bin");

  for (const f of fs.readdirSync(VENDOR)) if (f !== "yt-dlp") fs.rmSync(path.join(VENDOR, f), { recursive: true });
  for (const f of fs.readdirSync(bin)) {
    if (f === "ffplay.exe") continue; // lecteur inutile ici
    fs.copyFileSync(path.join(bin, f), path.join(VENDOR, f));
  }
  // Licence GPL de FFmpeg : obligatoire pour redistribuer le build
  const ffLicense = ["LICENSE.txt", "LICENSE", "COPYING.GPLv3"].map(f => path.join(TMP, extracted, f)).find(p => fs.existsSync(p));
  if (!ffLicense) throw new Error("Licence de FFmpeg introuvable dans l'archive");
  fs.copyFileSync(ffLicense, path.join(VENDOR, "FFMPEG-LICENSE.txt"));
  fs.rmSync(path.join(TMP, extracted), { recursive: true, force: true });

  let total = 0;
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : (total += fs.statSync(p).size); } };
  walk(VENDOR);
  console.log(`\nvendor/ prêt : ${(total / 1048576).toFixed(0)} Mo`);
})().catch(e => { console.error("\nÉCHEC :", e.message); process.exit(1); });
