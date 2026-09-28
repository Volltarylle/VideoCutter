# Composants tiers

VideoCutter est distribué sous licence **GNU GPL v3 ou ultérieure** (voir `LICENSE`).
L'installateur Windows inclut les logiciels suivants, chacun sous sa propre licence.

## FFmpeg

- Rôle : découpe, conversion et assemblage des fichiers audio/vidéo.
- Licence : **GNU GPL v3** (build « gpl-shared »). Le texte de licence fourni avec le build est inclus dans l'application (`resources/bin/FFMPEG-LICENSE.txt`).
- Build utilisé : [yt-dlp/FFmpeg-Builds](https://github.com/yt-dlp/FFmpeg-Builds) (variante `ffmpeg-master-latest-win64-gpl-shared`).
- Code source correspondant :
  - FFmpeg : <https://github.com/FFmpeg/FFmpeg> (<https://ffmpeg.org/download.html>)
  - Scripts de compilation et bibliothèques incluses : <https://github.com/yt-dlp/FFmpeg-Builds>
- FFmpeg est lancé comme programme séparé : VideoCutter ne l'intègre pas dans son propre code.

## yt-dlp

- Rôle : lecture des pages vidéo et téléchargement.
- Licence : **The Unlicense** (domaine public) — <https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE>.
- Build utilisé : `yt-dlp_win.zip`, publié sur <https://github.com/yt-dlp/yt-dlp/releases>. Ce build embarque Python et d'autres bibliothèques sous leurs propres licences, détaillées dans le dépôt de yt-dlp.

## Electron / Chromium / Node.js

- Rôle : fenêtre de l'application et moteur JavaScript.
- Licence : **MIT** pour Electron — <https://github.com/electron/electron/blob/main/LICENSE>.
- Chromium et Node.js sont inclus sous leurs licences respectives ; la liste complète est fournie avec l'application (`LICENSES.chromium.html`, `LICENSE.electron.txt`).
