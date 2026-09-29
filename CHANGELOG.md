# Journal des versions

## 1.2.0 — en préparation

### Nouveautés
- **« Quoi de neuf ? »** : quand une mise à jour est disponible, un bouton affiche en quelques lignes ce qui change (texte de la release GitHub).
- **Export GIF** : 12 images/s, 480 px maximum, palette de couleurs optimisée. Compatible avec le recadrage 9:16 / 1:1, la vitesse et les extraits recollés.
- **Vitesse** de l'extrait : ×0,5 (ralenti) à ×2 (accéléré).
- **Vidéo sans le son**, en une case à cocher.
- **Taille maximale** : 10 Mo (Discord), 25 Mo (e-mail) ou 50 Mo. C'est un plafond : un petit extrait reste petit.
- **Taille estimée** avant le téléchargement.
- **Miniatures du début et de la fin** de l'extrait, pour voir exactement où l'on coupe.
- **Zoom sur la barre de découpe** (×4, ×16, ×64) pour régler finement sur les vidéos longues.
- **Nom du fichier modifiable**, avec nettoyage automatique des emojis, #hashtags, @pseudos et « … ».
- **Glisser le fichier terminé** directement dans un autre logiciel (montage, Discord, dossier…), et bouton **« Ouvrir »**.
- **File d'attente** : ajouter des extraits réglés un par un, ou coller une liste de liens (vidéos entières), puis tout télécharger à la suite.
- **Choix mémorisés** d'une ouverture à l'autre (format, cadrage, vitesse, options…).
- **Notification Windows** à la fin d'un téléchargement quand l'appli est en arrière-plan.
- **Progression dans la barre des tâches** Windows.
- **Fond flou** : en 9:16, 1:1 ou 4:5, toute l'image est gardée, centrée sur un fond flou (au lieu d'être rognée).
- **Format 4:5** (publications Instagram).
- **Chapitres** : choisir un chapitre règle le passage ; « tous les chapitres » donne un fichier par chapitre, nommé d'après son titre (pratique pour un album).
- **Lien avec un temps** (`?t=1m30s`) : le passage commence directement à cet instant.
- **Capture d'image** 📷 : enregistre en PNG l'image affichée (touche `S`), recadrée si un cadrage est choisi.
- **Miniature** de la vidéo enregistrable en JPEG.
- **Enlever un passage** ✂ : retire le passage choisi et garde tout le reste, recollé (touche `X`).
- **Playlist** : toutes ses vidéos s'ajoutent à la file d'attente (bouton sous le titre, ou lien de playlist collé dans la file).
- **Qualité audio** au choix pour MP3, M4A, OGG et OPUS (meilleure, 320, 256, 192 ou 128 kbit/s).
- **Fondu** au début et à la fin (image et son).
- **Volume harmonisé** au niveau des réseaux sociaux (−14 LUFS).
- **Boomerang** : l'extrait est joué à l'endroit puis à l'envers (30 s maximum).
- **Texte** incrusté en haut ou en bas de la vidéo.
- **Logo** incrusté dans un coin (image choisie une fois, gardée pour les fois suivantes).
- **Sous-titres** du site : en fichier `.srt` à part ou incrustés dans l'image, recalés sur l'extrait (début, vitesse, extraits recollés).
- **Version anglaise** de l'appli (automatique selon la langue de Windows, ou via le menu « ⋯ »).

### Améliorations
- **Interface épurée** : options d'export rangées dans un bloc « Options » repliable (avec un résumé des options actives), boutons de découpe regroupés sur une ligne, miniatures alignées sur les champs Début / Fin, pied de page réduit à des icônes et un menu « ⋯ ».
- **Qualité** : recadrage, vitesse, effets, incrustations, son et taille sont appliqués en un seul réencodage (meilleure image, plus rapide).
- **Plus rapide** : si seul le son change (retrait du son, volume, fondu sonore), l'image est copiée telle quelle, sans réencodage.
- Bouton de téléchargement plus clair quand les extraits sont recollés.

## 1.1.0

- Mise à jour automatique de l'appli depuis GitHub (avec l'accord de l'utilisateur).
- Recadrage vertical 9:16 et carré 1:1, avec un cadre à déplacer sur l'aperçu.
- Plusieurs extraits d'un coup : en fichiers séparés ou recollés en un seul.
- Raccourcis clavier (`I`, `O`, `Espace`, flèches, `P`, `A`) et fenêtre d'aide (touche `?`).
- Lien du presse-papiers proposé automatiquement.
- Historique des téléchargements (stocké uniquement sur le PC).
- Glisser-déposer d'un lien dans la fenêtre.

## 1.0.0

Première version publique.
- Plus de 1000 sites pris en charge (YouTube, X, Instagram, TikTok, Dailymotion, Reddit, SoundCloud…).
- Découpe au dixième de seconde avec aperçu.
- Vidéo : MP4, MKV, WEBM, MOV, AVI · Musique : MP3, WAV, FLAC, M4A, OGG, OPUS.
- Qualité automatique : le menu ne propose que les qualités qui existent pour la vidéo.
- Connexion aux sites pour les vidéos réservées aux membres, séparée du navigateur.
- Conditions d'utilisation au premier lancement ; aucune collecte de données.
