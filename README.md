<p align="center">
  <img src="build/icon.png" width="96" alt="">
</p>

<h1 align="center">VideoCutter</h1>

<p align="center">
  Télécharge <b>seulement le passage qui t'intéresse</b> d'une vidéo en ligne,<br>
  en vidéo ou en musique, sans passer par un logiciel de montage.
</p>

---

## Ce que fait VideoCutter

1. Tu colles le lien d'une vidéo (YouTube, X, Instagram, TikTok, Dailymotion, Reddit, SoundCloud… plus de 1000 sites).
2. Tu choisis le début et la fin de l'extrait, avec un aperçu de la vidéo.
3. Tu choisis le format, et seul ce morceau est téléchargé.

**Formats** — Vidéo : MP4, MKV, WEBM, MOV, AVI · Musique : MP3, WAV, FLAC, M4A, OGG, OPUS
**Qualité** — « Auto » prend la meilleure qualité disponible ; le menu ne propose que les qualités qui existent pour la vidéo.

Autres fonctions : annulation d'un téléchargement, choix du dossier de destination, mise à jour automatique de l'outil de téléchargement, connexion aux sites pour les vidéos réservées aux membres.

## Installation (Windows 10 / 11)

1. Télécharge `VideoCutter-Setup-x.y.z.exe` dans la page **[Releases](../../releases)**.
2. Lance-le. Windows peut afficher « Windows a protégé votre ordinateur » car l'installateur n'est pas signé :
   clique sur **Informations complémentaires**, puis **Exécuter quand même**.
3. Pour mettre à jour, lance simplement l'installateur de la nouvelle version : l'ancienne est remplacée, tes réglages sont conservés.

## 🔒 Confidentialité et sécurité

- **Aucun serveur** : VideoCutter n'envoie rien à personne. Pas de compte, pas de statistiques, pas de publicité, pas de pistage.
- L'appli ne communique qu'avec **le site de la vidéo** que tu télécharges, et avec **GitHub** pour mettre à jour yt-dlp.
- **Connexions aux sites** : elles se font dans une fenêtre de l'appli séparée de ton navigateur. Elles restent **sur ton PC**, chiffrées par Windows, et ne sont utilisées que si un site l'exige. Tes mots de passe sont tapés sur la page officielle du site ; l'appli ne les enregistre pas.
- La fenêtre de l'appli n'a aucun accès direct au système ; tous les liens, temps et formats sont vérifiés avant d'être transmis aux outils de téléchargement.
- Les outils inclus (yt-dlp, FFmpeg) sont vérifiés par empreinte SHA-256 lors de la fabrication de l'installateur et à chaque mise à jour.

## Compiler soi-même

Prérequis : [Node.js](https://nodejs.org) 20 ou plus récent, Windows.

```bash
npm install          # dépendances (Electron, electron-builder)
npm run binaries     # télécharge et vérifie yt-dlp et FFmpeg dans vendor/
npm start            # lance l'appli en mode développement
npm run dist         # fabrique l'installateur dans dist/
```

`npm run icon` régénère l'icône à partir du dessin contenu dans `build/render-icon.js`.

## Utilisation responsable

Ne télécharge que des contenus que tu as le droit de télécharger, et respecte les conditions d'utilisation des sites.
Au premier lancement, VideoCutter affiche ses conditions d'utilisation, qui doivent être acceptées : chaque utilisateur est seul responsable de ce qu'il télécharge.
VideoCutter n'est affilié à aucun des sites pris en charge ; leurs noms sont cités uniquement pour indiquer la compatibilité.

## Licence

VideoCutter est un logiciel libre, distribué sous licence **GNU GPL v3 ou ultérieure** — voir [`LICENSE`](LICENSE).
Il est fourni sans aucune garantie.

Il s'appuie sur [yt-dlp](https://github.com/yt-dlp/yt-dlp), [FFmpeg](https://ffmpeg.org) et [Electron](https://www.electronjs.org) :
voir [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) pour leurs licences et l'accès à leur code source.
