require('dotenv').config();

const fs = require('fs');
const path = require('path');

const {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    PermissionsBitField,
    REST,
    Routes,
    SlashCommandBuilder
} = require('discord.js');

const sqlite3 = require('sqlite3').verbose();

/*
=====================================
SAFETY NET
=====================================
*/
process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);

/*
=====================================
CONFIG
=====================================
*/
const EMOJI = '💉';
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;
const TOP_ROLE_ID = process.env.TOP_RESPONDER_ROLE_ID;
const CLIENT_ID = process.env.CLIENT_ID;

/*
=====================================
VALIDATION
=====================================
*/
if (!process.env.TOKEN) throw new Error("Missing TOKEN");
if (!LEADERBOARD_CHANNEL_ID) throw new Error("Missing LEADERBOARD_CHANNEL_ID");
if (!CLIENT_ID) console.warn("⚠️ Missing CLIENT_ID (slash commands will fail)");
if (!TOP_ROLE_ID) console.warn("⚠️ TOP_RESPONDER_ROLE_ID not set (role system disabled)");

/*
=====================================
CLIENT
=====================================
*/
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions
    ],
    partials: [
        Partials.Message,
        Partials.Channel,
        Partials.Reaction
    ]
});

/*
=====================================
DATABASE (FIXED FOR FLY.IO)
=====================================
*/

// ensure /data exists (CRITICAL on Fly)
const dataDir = '/data';
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'leaderboard.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("DB ERROR:", err);
    else console.log("📦 SQLite connected:", dbPath);
});

db.serialize(() => {

    db.run(`CREATE TABLE IF NOT EXISTS leaderboard (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        points INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS claims (
        message_id TEXT PRIMARY KEY,
        claimed_by TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS seasons (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);
});

/*
=====================================
SLASH COMMAND REGISTRATION
=====================================
*/
async function registerCommands() {
    if (!CLIENT_ID) return;

    const commands = [
        new SlashCommandBuilder()
            .setName('reset-leaderboard')
            .setDescription('Reset leaderboard (Admin only)')
            .toJSON()
    ];

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

    try {
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands }
        );

        console.log("Slash commands registered.");
    } catch (err) {
        console.error("Slash command error:", err);
    }
}

/*
=====================================
SEASON HELPERS
=====================================
*/
function getSeasonKey() {
    const d = new Date();
    const q = Math.floor(d.getMonth() / 3) + 1;
    return `Q${q}-${d.getFullYear()}`;
}

/*
=====================================
READY
=====================================
*/
client.once('ready', async () => {
    console.log(`💉 Online as ${client.user.tag}`);

    await registerCommands();

    await ensureLeaderboardMessage();
    await checkSeasonReset();
    await updateLeaderboard();

    setInterval(checkSeasonReset, 60 * 60 * 1000);
});

/*
=====================================
SLASH COMMAND
=====================================
*/
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'reset-leaderboard') return;

    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    }

    await interaction.reply({ content: "Resetting leaderboard...", ephemeral: true });

    db.run(`UPDATE leaderboard SET points = 0`);
    db.run(`DELETE FROM claims`);

    await updateLeaderboard();

    await interaction.followUp({ content: "✅ Reset complete.", ephemeral: true });
});

/*
=====================================
LEADERBOARD MESSAGE
=====================================
*/
async function ensureLeaderboardMessage() {
    const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    if (!channel) return;

    db.get(`SELECT value FROM config WHERE key='leaderboard_message'`, async (err, row) => {
        if (err || row) return;

        const msg = await channel.send({
            embeds: [buildEmbed("No activity yet.")]
        });

        db.run(
            `INSERT INTO config(key,value) VALUES('leaderboard_message',?)`,
            [msg.id]
        );
    });
}

/*
=====================================
UPDATE LEADERBOARD
=====================================
*/
async function updateLeaderboard() {
    db.get(`SELECT value FROM config WHERE key='leaderboard_message'`, async (err, row) => {
        if (err || !row) return;

        const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
        const message = await channel.messages.fetch(row.value);

        db.all(
            `SELECT username, points FROM leaderboard ORDER BY points DESC LIMIT 50`,
            async (err, rows) => {

                if (err) return;

                let board = "No activity yet.";

                if (rows?.length) {
                    board = rows.map((r, i) => {
                        const medal =
                            i === 0 ? '🥇' :
                            i === 1 ? '🥈' :
                            i === 2 ? '🥉' :
                            `${i + 1}.`;

                        return `${medal} ${r.username} — ${r.points} 💉`;
                    }).join("\n");
                }

                await message.edit({ embeds: [buildEmbed(board)] });
            }
        );
    });
}

/*
=====================================
UTILS
=====================================
*/

function buildEmbed(boardText) {
    return new EmbedBuilder()
        .setTitle(`💉 Top Responder Leaderboard — ${getSeasonKey()}`)
        .setDescription(
`**What this is**
A quarterly leaderboard tracking verified revive assistance activity.

**How it works**
- React 💉 on a revive request = +1 point
- Each message can only be claimed once per user
- Scores reset every quarter (seasonal system)

**Rules**
- Do not farm reactions or coordinate fake revives
- Abuse of the system may result in score removal or moderation action

---

**Leaderboard**
${boardText}`
        )
        .setFooter({
            text: `Updated ${new Date().toLocaleString()}`
        });
}
/*
=====================================
LOGIN
=====================================
*/
client.login(process.env.TOKEN);