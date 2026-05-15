require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');

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
SAFETY NETS
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
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers
    ],
    partials: [
        Partials.Message,
        Partials.Channel,
        Partials.Reaction
    ]
});

/*
=====================================
DATABASE
=====================================
*/
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
        message_id TEXT,
        claimed_by TEXT,
        PRIMARY KEY (message_id, claimed_by)
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
            .toJSON(),

        new SlashCommandBuilder()
            .setName('refresh-leaderboard')
            .setDescription('Force refresh leaderboard embed (Admin only)')
            .toJSON(),

        new SlashCommandBuilder()
            .setName('addpoints')
            .setDescription('Add points to a user (Admin only)')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('The user to add points to')
                    .setRequired(true))
            .addIntegerOption(option =>
                option.setName('amount')
                    .setDescription('Number of points to add')
                    .setRequired(true)
                    .setMinValue(1))
            .toJSON(),

        new SlashCommandBuilder()
            .setName('removepoints')
            .setDescription('Remove points from a user (Admin only)')
            .addUserOption(option =>
                option.setName('user')
                    .setDescription('The user to remove points from')
                    .setRequired(true))
            .addIntegerOption(option =>
                option.setName('amount')
                    .setDescription('Number of points to remove')
                    .setRequired(true)
                    .setMinValue(1))
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
SEASON RESET
=====================================
*/
async function checkSeasonReset() {
    const current = getSeasonKey();

    db.get(`SELECT value FROM seasons WHERE key='current'`, async (err, row) => {
        if (!row) {
            db.run(`INSERT INTO seasons(key,value) VALUES('current',?)`, [current]);
            return;
        }

        if (row.value === current) return;

        const channel = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
        if (!channel) return;

        const topUser = await getTopUser();
        const guild = channel.guild;

        let newMVP = null;

        if (TOP_ROLE_ID) {
            try {
                const members = await guild.members.fetch();
                const oldMVP = members.find(m => m.roles.cache.has(TOP_ROLE_ID));
                if (oldMVP) await oldMVP.roles.remove(TOP_ROLE_ID).catch(() => {});
            } catch (e) {
                console.error("Failed removing old MVP:", e);
            }
        }

        if (topUser && TOP_ROLE_ID) {
            try {
                const member = await guild.members.fetch(topUser.user_id);
                await member.roles.add(TOP_ROLE_ID);
                newMVP = member;
            } catch (e) {
                console.error("MVP role assignment failed:", e);
            }
        }

        await channel.send({
            embeds: [
                new EmbedBuilder()
                    .setTitle(`🏁 Season Complete — ${row.value}`)
                    .setDescription(
`**🏆 MVP**
${topUser ? `${topUser.username} — ${topUser.points}` : 'None'}

${newMVP ? `🎖 Role assigned to ${newMVP.user.username}` : ''}

A new quarter has started. All scores have been reset.`
                    )
            ]
        });

        db.run(`UPDATE leaderboard SET points = 0`);
        db.run(`UPDATE seasons SET value=? WHERE key='current'`, [current]);
    });
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
REACTION HANDLER
=====================================
*/
client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.emoji.name !== EMOJI) return;

    if (reaction.partial) {
        try { await reaction.fetch(); }
        catch (e) { console.error("Failed to fetch reaction:", e); return; }
    }

    if (reaction.message.partial) {
        try { await reaction.message.fetch(); }
        catch (e) { console.error("Failed to fetch message:", e); return; }
    }

    const messageId = reaction.message.id;
    const userId = user.id;

    if (reaction.message.author?.id === userId) return;

    db.get(
        `SELECT claimed_by FROM claims WHERE message_id = ? AND claimed_by = ?`,
        [messageId, userId],
        async (err, row) => {
            if (err || row) return;

            db.run(
                `INSERT OR IGNORE INTO claims(message_id, claimed_by) VALUES(?, ?)`,
                [messageId, userId]
            );

            db.run(
                `INSERT INTO leaderboard(user_id, username, points)
                 VALUES(?, ?, 1)
                 ON CONFLICT(user_id) DO UPDATE SET
                    points = points + 1,
                    username = excluded.username`,
                [userId, user.username]
            );

            await updateLeaderboard();
        }
    );
});

/*
=====================================
SLASH COMMANDS
=====================================
*/
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const isAdmin = interaction.memberPermissions?.has(
        PermissionsBitField.Flags.Administrator
    );

    if (!isAdmin) {
        return interaction.reply({ content: "❌ Admin only.", ephemeral: true });
    }

    // -------------------------
    // RESET
    // -------------------------
    if (interaction.commandName === 'reset-leaderboard') {
        await interaction.reply({ content: "Resetting leaderboard...", ephemeral: true });

        db.run(`UPDATE leaderboard SET points = 0`);
        db.run(`DELETE FROM claims`);

        await updateLeaderboard();

        return interaction.followUp({ content: "✅ Reset complete.", ephemeral: true });
    }

    // -------------------------
    // REFRESH
    // -------------------------
    if (interaction.commandName === 'refresh-leaderboard') {
        await interaction.reply({ content: "🔄 Refreshing leaderboard...", ephemeral: true });

        await updateLeaderboard();

        return interaction.followUp({ content: "✅ Updated.", ephemeral: true });
    }

    // -------------------------
    // ADD POINTS
    // -------------------------
    if (interaction.commandName === 'addpoints') {
        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');

        db.run(
            `INSERT INTO leaderboard(user_id, username, points)
             VALUES(?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
                points = points + ?,
                username = excluded.username`,
            [target.id, target.username, amount, amount],
            async (err) => {
                if (err) {
                    console.error("addpoints error:", err);
                    return interaction.reply({ content: "❌ Failed to add points.", ephemeral: true });
                }

                await updateLeaderboard();

                return interaction.reply({
                    content: `✅ Added **${amount}** point(s) to **${target.username}**.`,
                    ephemeral: true
                });
            }
        );

        return;
    }

    // -------------------------
    // REMOVE POINTS
    // -------------------------
    if (interaction.commandName === 'removepoints') {
        const target = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');

        db.run(
            `UPDATE leaderboard SET points = MAX(0, points - ?) WHERE user_id = ?`,
            [amount, target.id],
            async (err) => {
                if (err) {
                    console.error("removepoints error:", err);
                    return interaction.reply({ content: "❌ Failed to remove points.", ephemeral: true });
                }

                await updateLeaderboard();

                return interaction.reply({
                    content: `✅ Removed **${amount}** point(s) from **${target.username}**.`,
                    ephemeral: true
                });
            }
        );

        return;
    }
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
        .setFooter({ text: `Updated ${new Date().toLocaleString()}` });
}

async function getTopUser() {
    return new Promise(res => {
        db.get(
            `SELECT user_id, username, points FROM leaderboard ORDER BY points DESC LIMIT 1`,
            (err, row) => res(row || null)
        );
    });
}

/*
=====================================
HEALTH CHECK (FLY.IO)
=====================================
*/
http.createServer((req, res) => res.end('OK')).listen(3000, '0.0.0.0', () => {
    console.log('Health check listening on port 3000');
});

/*
=====================================
LOGIN
=====================================
*/
client.login(process.env.TOKEN);