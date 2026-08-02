# Déploiement (Render — Background Worker)

1. Pousse ce dossier sur un repo GitHub (index.js, package.json).
2. Sur render.com : New + → Background Worker (PAS "Web Service" — un bot Baileys
   n'écoute aucun port HTTP, il maintient juste une connexion WebSocket sortante).
3. Runtime : Node. Build command : npm install. Start command : node index.js.
4. Variables d'environnement à ajouter dans Render :
   - OWNER_NUMBER → ton numéro (ex: 22890000000, sans le +)
   - BOT_NUMBER → le numéro qui sera lié au bot
   - OPENAI_API_KEY → (optionnel, pour activer !ia)
5. Déploie. Ouvre les Logs en direct : le code de pairing s'affiche là.
6. Sur ton téléphone : WhatsApp → Réglages → Appareils liés → Lier un appareil →
   "Lier avec un numéro de téléphone" → entre le code affiché dans les logs.
7. Une fois lié, le dossier auth_info/ contient la session. Sur Render, ce dossier
   est éphémère par défaut : ajoute un Persistent Disk monté sur
   /opt/render/project/src/auth_info pour ne pas avoir à rescanner à chaque
   redéploiement.

## Pourquoi pas Vercel ni AI Studio ?
- Vercel = fonctions serverless de quelques secondes → connexion WebSocket coupée
  immédiatement.
- Google AI Studio = prototypage IA, pas un serveur permanent ; WhatsApp bloque une
  partie des IP Google Cloud.
- Render/Railway (Background Worker) = process Node continu → seul type compatible
  avec Baileys.
