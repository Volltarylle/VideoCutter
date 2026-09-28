// Génère l'icône de l'appli (build/icon.png, 512 px) à partir d'un dessin SVG.
// Utilisation : npx electron build/render-icon.js
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#a06bff"/><stop offset="1" stop-color="#5b21b6"/>
    </linearGradient>
    <clipPath id="left"><rect x="0" y="0" width="238" height="512"/></clipPath>
    <clipPath id="right"><rect x="274" y="0" width="238" height="512"/></clipPath>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bg)"/>
  <g fill="#fff">
    <path clip-path="url(#left)"  d="M176 132 L396 256 L176 380 Z" transform="translate(-10 0)" stroke="#fff" stroke-width="28" stroke-linejoin="round"/>
    <path clip-path="url(#right)" d="M176 132 L396 256 L176 380 Z" transform="translate(10 0)" stroke="#fff" stroke-width="28" stroke-linejoin="round"/>
  </g>
  <line x1="256" y1="70" x2="256" y2="442" stroke="#fff" stroke-opacity=".75" stroke-width="10" stroke-linecap="round" stroke-dasharray="4 26"/>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  const html = `<html><body style="margin:0;background:transparent">${SVG}</body></html>`;
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise(r => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const png = img.resize({ width: 512, height: 512, quality: "best" }).toPNG();
  const root = path.join(__dirname, "..");
  fs.writeFileSync(path.join(__dirname, "icon.png"), png);
  fs.writeFileSync(path.join(root, "src", "icon.png"), png);
  fs.writeFileSync(path.join(root, "src", "renderer", "icon.png"), img.resize({ width: 80, height: 80, quality: "best" }).toPNG());
  fs.writeFileSync(path.join(__dirname, "icon.svg"), SVG);
  console.log("Icône générée.");
  app.quit();
});
