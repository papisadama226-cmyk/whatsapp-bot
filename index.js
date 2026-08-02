/**
 * ============================================================
 *  BOT WHATSAPP TOUT-EN-UN — fichier unique
 *  Connexion : PAIRING CODE (pas de QR)
 *  Lib       : @whiskeysockets/baileys (temps réel, WebSocket persistant)
 *  Hébergement recommandé : Render / Railway (process persistant 24/7)
 *  ⚠️ NE FONCTIONNE PAS sur Vercel (serverless) ni durablement sur
 *     Google AI Studio (IP Google Cloud bloquées par WhatsApp).
 * ============================================================
 *
 * INSTALLATION :
 *   npm init -y
 *   npm install @whiskeysockets/baileys @hapi/boom pino wa-sticker-formatter sharp qrcode-terminal
 *
 * VARIABLES D'ENVIRONNEMENT (à définir sur Render/Railway) :
 *   OWNER_NUMBER      = ex: 22890000000 (ton numéro, sans le +)
 *   BOT_NUMBER        = ex: 22890000001 (numéro utilisé pour le pairing code)
 *   PREFIX            = ! (optionnel, défaut "!")
 *   GEMINI_API_KEY    = (optionnel, active !ia avec Gemini — clé depuis aistudio.google.com)
 *   GEMINI_MODEL      = gemini-2.0-flash (optionnel)
 *
 * DÉMARRAGE :
 *   node index.js
 *   -> le bot affiche le CODE DE PAIRING dans la console
 *   -> WhatsApp > Appareils liés > Lier avec un numéro de téléphone
 * ============================================================
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ---------- Config ----------
const PREFIX = process.env.PREFIX || '!';
const OWNER_NUMBER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const BOT_NUMBER = (process.env.BOT_NUMBER || '').replace(/\D/g, '');
const START_TIME = Date.now();
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Petite persistance JSON (temps réel, pas de simulation) ----------
function loadJSON(name, fallback) {
  const p = path.join(DATA_DIR, name);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJSON(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data, null, 2));
}

let db = {
  warns: loadJSON('warns.json', {}),        // { groupId: { userId: count } }
  bans: loadJSON('bans.json', {}),          // { userId: true }
  settings: loadJSON('settings.json', {}),  // { groupId: { antilink, welcome, bye, muted, rules, prefix } }
};
function persist() {
  saveJSON('warns.json', db.warns);
  saveJSON('bans.json', db.bans);
  saveJSON('settings.json', db.settings);
}
function groupSettings(gid) {
  if (!db.settings[gid]) db.settings[gid] = { antilink: false, welcome: false, bye: false, rules: '' };
  return db.settings[gid];
}

// ---------- Utilitaires ----------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

function jidToNumber(jid) {
  return jid ? jid.split('@')[0].split(':')[0] : '';
}
function isOwner(jid) {
  return jidToNumber(jid) === OWNER_NUMBER;
}
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

const QUOTES = [
  "Le succès, c'est aller d'échec en échec sans perdre son enthousiasme.",
  "Ce n'est pas parce que les choses sont difficiles que nous n'osons pas, c'est parce que nous n'osons pas qu'elles sont difficiles.",
  "La discipline est le pont entre les objectifs et les résultats.",
  "Un obstacle est souvent un raccourci mal éclairé.",
  "Fais ce que tu peux, avec ce que tu as, là où tu es.",
];

async function translateText(text, targetLang) {
  // API gratuite, sans clé — appel réel, aucune simulation
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=auto|${targetLang}`;
  const res = await fetch(url);
  const json = await res.json();
  return json?.responseData?.translatedText || 'Traduction indisponible pour le moment.';
}

async function getWeather(city) {
  const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`);
  return await res.text();
}

async function askOpenAI(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return "⚠️ !ia n'est pas configuré. Ajoute la variable d'environnement GEMINI_API_KEY pour l'activer.";
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );
  const json = await res.json();
  return (
    json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
    "Je n'ai pas pu générer de réponse."
  );
}

function simpleSummary(text, maxSentences = 3) {
  // Résumé extractif basique (aucune clé requise) : garde les phrases les plus longues/informatives
  const sentences = text.replace(/\n/g, ' ').split(/(?<=[.?!])\s+/).filter(Boolean);
  if (sentences.length <= maxSentences) return text;
  const ranked = sentences
    .map((s, i) => ({ s, i, score: s.length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.i - b.i);
  return ranked.map((r) => r.s).join(' ');
}

// ---------- Liste des commandes (menu généré dynamiquement) ----------
const MENU = `
╭─❖ *BOT WHATSAPP* ❖─╮
Préfixe : ${PREFIX}

*🧩 GÉNÉRAL*
${PREFIX}menu / ${PREFIX}help – ce menu
${PREFIX}ping – latence du bot
${PREFIX}runtime – durée de fonctionnement
${PREFIX}about – à propos du bot
${PREFIX}owner – contact du propriétaire
${PREFIX}quote – citation aléatoire
${PREFIX}weather <ville> – météo en temps réel
${PREFIX}trad <code_langue> <texte> – traduction
${PREFIX}resume <texte> – résumé automatique
${PREFIX}ia <question> – intelligence artificielle

*👮 MODÉRATION (groupe, admin)*
${PREFIX}kick @user – expulser
${PREFIX}promote @user – passer admin
${PREFIX}demote @user – retirer admin
${PREFIX}warn @user – avertir
${PREFIX}unwarn @user – enlever un avertissement
${PREFIX}ban @user – bannir (auto-kick si rejoint)
${PREFIX}unban @user – débannir
${PREFIX}mute – verrouiller le groupe (admins only)
${PREFIX}unmute – déverrouiller le groupe
${PREFIX}tagall <texte> – mentionner tout le monde
${PREFIX}hidetag <texte> – mention invisible
${PREFIX}antilink on/off – suppression auto des liens
${PREFIX}welcome on/off – message de bienvenue
${PREFIX}bye on/off – message de départ
${PREFIX}setrules <texte> – définir le règlement
${PREFIX}rules – afficher le règlement
${PREFIX}group – infos du groupe

*🎨 MEDIA*
${PREFIX}sticker – (répondre à une image/vidéo) créer un sticker
${PREFIX}toimg – (répondre à un sticker) reconvertir en image

*📊 OUTILS*
${PREFIX}poll <question> | <opt1> | <opt2> – créer un sondage réel

*🔐 PROPRIÉTAIRE*
${PREFIX}broadcast <texte> – message à tous les groupes
${PREFIX}restart – redémarrer le bot
╰────────────────╯
`.trim();

// ---------- Démarrage du socket ----------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.ubuntu('Chrome'),
  });

  // ----- Pairing code (pas de QR) -----
  if (!sock.authState.creds.registered) {
    const numberToUse = BOT_NUMBER || (await ask('📱 Entre le numéro WhatsApp du bot (avec indicatif, sans +) : '));
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(numberToUse.replace(/\D/g, ''));
        console.log('\n============================');
        console.log(' CODE DE PAIRING : ' + code);
        console.log(' -> WhatsApp > Réglages > Appareils liés > Lier avec un numéro de téléphone');
        console.log('============================\n');
      } catch (e) {
        console.error('Erreur génération du code de pairing :', e);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connexion fermée. Reconnexion :', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot connecté en temps réel à WhatsApp.');
    }
  });

  // ----- Bienvenue / Départ -----
  sock.ev.on('group-participants.update', async (ev) => {
    const settings = groupSettings(ev.id);
    try {
      if (ev.action === 'add') {
        for (const participant of ev.participants) {
          if (db.bans[participant]) {
            await sock.groupParticipantsUpdate(ev.id, [participant], 'remove');
            continue;
          }
          if (settings.welcome) {
            await sock.sendMessage(ev.id, {
              text: `👋 Bienvenue @${jidToNumber(participant)} dans le groupe !`,
              mentions: [participant],
            });
          }
        }
      } else if (ev.action === 'remove' && settings.bye) {
        for (const participant of ev.participants) {
          await sock.sendMessage(ev.id, {
            text: `👋 @${jidToNumber(participant)} a quitté le groupe.`,
            mentions: [participant],
          });
        }
      }
    } catch (e) {
      console.error('Erreur group-participants.update:', e);
    }
  });

  // ----- Messages -----
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const sender = isGroup ? msg.key.participant : from;
    const body =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      '';

    // Antilien (temps réel : vérifie chaque message d'un groupe)
    if (isGroup) {
      const settings = groupSettings(from);
      if (settings.antilink && /(chat\.whatsapp\.com|https?:\/\/)/i.test(body)) {
        try {
          const meta = await sock.groupMetadata(from);
          const senderIsAdmin = meta.participants.find((p) => p.id === sender)?.admin;
          if (!senderIsAdmin) {
            await sock.sendMessage(from, { delete: msg.key });
            await sock.sendMessage(from, {
              text: `🚫 Lien supprimé — @${jidToNumber(sender)}, les liens ne sont pas autorisés ici.`,
              mentions: [sender],
            });
            return;
          }
        } catch (e) { console.error(e); }
      }
    }

    if (!body.startsWith(PREFIX)) return;
    const args = body.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = args.shift().toLowerCase();
    const reply = (text, extra = {}) => sock.sendMessage(from, { text, ...extra }, { quoted: msg });

    let meta = null;
    let senderIsAdmin = false;
    if (isGroup) {
      try {
        meta = await sock.groupMetadata(from);
        senderIsAdmin = !!meta.participants.find((p) => p.id === sender)?.admin;
      } catch {}
    }
    const mentioned =
      msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
    const target = mentioned[0] || quotedParticipant;

    try {
      switch (cmd) {
        // ---------- GÉNÉRAL ----------
        case 'menu':
        case 'help':
          await reply(MENU);
          break;

        case 'ping': {
          const start = Date.now();
          await sock.sendMessage(from, { text: 'Calcul en cours...' });
          await reply(`🏓 Pong ! ${Date.now() - start} ms`);
          break;
        }

        case 'runtime':
          await reply(`⏱️ En ligne depuis : ${fmtUptime(Date.now() - START_TIME)}`);
          break;

        case 'about':
          await reply('🤖 Bot WhatsApp multi-fonctions — Baileys, connexion pairing code, 100% temps réel.');
          break;

        case 'owner':
          await reply(`👤 Propriétaire : wa.me/${OWNER_NUMBER}`);
          break;

        case 'quote':
          await reply('💬 ' + QUOTES[Math.floor(Math.random() * QUOTES.length)]);
          break;

        case 'weather': {
          const city = args.join(' ');
          if (!city) { await reply('Usage : ' + PREFIX + 'weather <ville>'); break; }
          await reply(await getWeather(city));
          break;
        }

        case 'trad': {
          const lang = args.shift();
          const text = args.join(' ');
          if (!lang || !text) { await reply('Usage : ' + PREFIX + 'trad <code_langue> <texte>'); break; }
          await reply(await translateText(text, lang));
          break;
        }

        case 'resume': {
          const text = args.join(' ');
          if (!text) { await reply('Usage : ' + PREFIX + 'resume <texte>'); break; }
          await reply('📝 ' + simpleSummary(text));
          break;
        }

        case 'ia': {
          const prompt = args.join(' ');
          if (!prompt) { await reply('Usage : ' + PREFIX + 'ia <question>'); break; }
          await reply(await askOpenAI(prompt));
          break;
        }

        // ---------- MODÉRATION ----------
        case 'group': {
          if (!isGroup) { await reply('Commande valable uniquement en groupe.'); break; }
          await reply(
            `📋 *${meta.subject}*\nParticipants : ${meta.participants.length}\nID : ${meta.id}\nDescription : ${meta.desc || 'aucune'}`
          );
          break;
        }

        case 'kick': {
          if (!isGroup || !senderIsAdmin) { await reply('Réservé aux admins.'); break; }
          if (!target) { await reply('Mentionne ou réponds à la personne à expulser.'); break; }
          await sock.groupParticipantsUpdate(from, [target], 'remove');
          await reply(`✅ @${jidToNumber(target)} a été expulsé.`, { mentions: [target] });
          break;
        }

        case 'promote': {
          if (!isGroup || !senderIsAdmin) { await reply('Réservé aux admins.'); break; }
          if (!target) { await reply('Mentionne la personne à promouvoir.'); break; }
          await sock.groupParticipantsUpdate(from, [target], 'promote');
          await reply(`⬆️ @${jidToNumber(target)} est maintenant admin.`, { mentions: [target] });
          break;
        }

        case 'demote': {
          if (!isGroup || !senderIsAdmin) { await reply('Réservé aux admins.'); break; }
          if (!target) { await reply('Mentionne la personne à rétrograder.'); break; }
          await sock.groupParticipantsUpdate(from, [target], 'demote');
          await reply(`⬇️ @${jidToNumber(target)} n'est plus admin.`, { mentions: [target] });
          break;
        }

        case 'warn': {
          if (!isGroup || !senderIsAdmin) { await reply('Réservé aux admins.'); break; }
          if (!target) { await reply('Mentionne la personne à avertir.'); break; }
          db.warns[from] = db.warns[from] || {};
          db.warns[from][target] = (db.warns[from][target] || 0) + 1;
          persist();
          const count = db.warns[from][target];
          await reply(`⚠️ @${jidToNumber(target)} averti (${count}/3).`, { mentions: [target] });
          if (count >= 3) {
            await sock.groupParticipantsUpdate(from, [target], 'remove');
            await reply(`🚫 @${jidToNumber(target)} expulsé après 3 avertissements.`, { mentions: [target] });
            db.warns[from][target] = 0;
            persist();
          }
          break;
        }

        case 'unwarn': {
          if (!isGroup || !senderIsAdmin) { await reply('Réservé aux admins.'); break; }
          if (!target) { await reply('Mentionne la personne concernée.'); break; }
          if (db.warns[from]?.[target]) db.warns[from][target]--;
          persist();
          await reply(`✅ Avertissement retiré pour @${jidToNumber(target)}.`, { mentions: [target] });
          break;
        }

        case 'ban': {
          if (!senderIsAdmin && isGroup) { await reply('Réservé aux admins.'); break; }
          if (!target) { await reply('Mentionne la personne à bannir.'); break; }
          db.bans[target] = true;
          persist();
          if (isGroup) await sock.groupParticipantsUpdate(from, [target], 'remove');
          await reply(`🚫 @${jidToNumber(target)} banni du bot (et expulsé si présent).`, { mentions: [target] });
          break;
        }

        case 'unban': {
          if (!target) { await reply('Mentionne la personne à débannir.'); break; }
          delete db.bans[target];
          persist();
          await reply(`✅ @${jidToNumber(target)} débanni.`, { mentions: [target] });
          break;
        }

        case 'mute': {
          if (!isGroup || !senderIsAdmin) { await reply('Réservé aux admins.'); break; }
          await sock.groupSettingUpdate(from, 'announcement');
          await reply('🔒 Groupe verrouillé : seuls les admins peuvent écrire.');
          break;
        }

        case 'unmute': {
          if (!isGroup || !senderIsAdmin) { await reply('Réservé aux admins.'); break; }
          await sock.groupSettingUpdate(from, 'not_announcement');
          await reply('🔓 Groupe déverrouillé : tout le monde peut écrire.');
          break;
        }

        case 'tagall': {
          if (!isGroup) { await reply('Commande valable uniquement en groupe.'); break; }
          const text = args.join(' ') || 'Attention à tous 📢';
          const ids = meta.participants.map((p) => p.id);
          const list = ids.map((id) => `@${jidToNumber(id)}`).join(' ');
          await sock.sendMessage(from, { text: `${text}\n\n${list}`, mentions: ids });
          break;
        }

        case 'hidetag': {
          if (!isGroup) { await reply('Commande valable uniquement en groupe.'); break; }
          const text = args.join(' ') || '📢';
          const ids = meta.participants.map((p) => p.id);
          await sock.sendMessage(from, { text, mentions: ids });
          break;
        }

        case 'antilink': {
          if (!isGroup || !senderIsAdmin) { await reply('Réservé aux admins.'); break; }
          const s = groupSettings(from);
          const arg = (args[0] || '').toLowerCase();
          if (arg !== 'on' && arg !== 'off') { await reply('Usage : ' + PREFIX + 'antilink on/off'); break; }
          s.antilink = arg === 'on';
          persist();
          await reply(`Antilien ${s.antilink ? 'activé ✅' : 'désactivé ❌'}.`);
          break;
        }

        case 'welcome': {
          if (!isGroup || !senderIsAdmin) { await reply('Réservé aux admins.'); break; }
          const s = groupSettings(from);
          const arg = (args[0] || '').toLowerCase();
          if (arg !== 'on' && arg !== 'off') { await reply('Usage : ' + PREFIX + 'welcome on/off'); break; }
          s.welcome = arg === 'on';
          persist();
          await reply(`Message de bienvenue ${s.welcome ? 'activé ✅' : 'désactivé ❌'}.`);
          break;
        }

        case 'bye': {
          if (!isGroup || !senderIsAdmin) { await reply('Réservé aux admins.'); break; }
          const s = groupSettings(from);
          const arg = (args[0] || '').toLowerCase();
          if (arg !== 'on' && arg !== 'off') { await reply('Usage : ' + PREFIX + 'bye on/off'); break; }
          s.bye = arg === 'on';
          persist();
          await reply(`Message de départ ${s.bye ? 'activé ✅' : 'désactivé ❌'}.`);
          break;
        }

        case 'setrules': {
          if (!isGroup || !senderIsAdmin) { await reply('Réservé aux admins.'); break; }
          const text = args.join(' ');
          if (!text) { await reply('Usage : ' + PREFIX + 'setrules <texte>'); break; }
          groupSettings(from).rules = text;
          persist();
          await reply('✅ Règlement mis à jour.');
          break;
        }

        case 'rules': {
          if (!isGroup) { await reply('Commande valable uniquement en groupe.'); break; }
          const r = groupSettings(from).rules;
          await reply(r ? '📜 Règlement :\n' + r : 'Aucun règlement défini. Utilise ' + PREFIX + 'setrules.');
          break;
        }

        // ---------- MEDIA ----------
        case 'sticker': {
          const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
          const target_msg = quoted || msg.message;
          const isImage = target_msg.imageMessage;
          const isVideo = target_msg.videoMessage;
          if (!isImage && !isVideo) { await reply('Réponds à une image ou une courte vidéo avec ' + PREFIX + 'sticker'); break; }
          const buffer = await downloadMediaMessage(
            { message: target_msg, key: msg.key },
            'buffer', {}, { logger }
          );
          const { Sticker } = require('wa-sticker-formatter');
          const sticker = new Sticker(buffer, { pack: 'Mon Bot', author: 'WhatsApp Bot' });
          const stickerBuffer = await sticker.toBuffer();
          await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });
          break;
        }

        case 'toimg': {
          const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted?.stickerMessage) { await reply('Réponds à un sticker avec ' + PREFIX + 'toimg'); break; }
          const buffer = await downloadMediaMessage(
            { message: quoted, key: msg.key },
            'buffer', {}, { logger }
          );
          await sock.sendMessage(from, { image: buffer, caption: '✅ Reconverti en image' }, { quoted: msg });
          break;
        }

        // ---------- OUTILS ----------
        case 'poll': {
          const parts = args.join(' ').split('|').map((p) => p.trim()).filter(Boolean);
          if (parts.length < 3) { await reply('Usage : ' + PREFIX + 'poll Question | Option1 | Option2'); break; }
          const [question, ...options] = parts;
          await sock.sendMessage(from, {
            poll: { name: question, values: options, selectableCount: 1 },
          });
          break;
        }

        // ---------- OWNER ----------
        case 'broadcast': {
          if (!isOwner(sender)) { await reply('Réservé au propriétaire.'); break; }
          const text = args.join(' ');
          if (!text) { await reply('Usage : ' + PREFIX + 'broadcast <texte>'); break; }
          const groups = await sock.groupFetchAllParticipating();
          for (const gid of Object.keys(groups)) {
            await sock.sendMessage(gid, { text: `📢 ${text}` });
          }
          await reply(`✅ Diffusé à ${Object.keys(groups).length} groupe(s).`);
          break;
        }

        case 'restart': {
          if (!isOwner(sender)) { await reply('Réservé au propriétaire.'); break; }
          await reply('♻️ Redémarrage...');
          process.exit(0); // le superviseur (Render/Railway) relance le process
          break;
        }

        default:
          await reply(`Commande inconnue. Tape ${PREFIX}menu pour la liste des commandes.`);
      }
    } catch (e) {
      console.error('Erreur commande', cmd, e);
      await reply('❌ Une erreur est survenue lors de l\'exécution de la commande.');
    }
  });

  return sock;
}

startBot();
