require('dotenv').config();

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

require('dotenv').config();

const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(':memory:');

db.run(`CREATE TABLE IF NOT EXISTS leaderboard (...)`);

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

/*
=====================================
VALIDATION
=====================================
*/
if (!process.env.TOKEN) throw new Error("Missing TOKEN");
if (!LEADERBOARD_CHANNEL_ID) throw new Error("Missing LEADERBOARD_CHANNEL_ID");
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
DATABASE
=====================================
*/
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

/*
=====================================
SLASH COMMAND REGISTRATION
=====================================
*/
async function registerCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('reset-leaderboard')
            .setDescription('Reset leaderboard (Admin only)')
            .toJSON()
    ];

    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

    await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commands }
    );

    console.log("Slash commands registered.");
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
SLASH COMMAND HANDLER
=====================================
*/
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName !== 'reset-leaderboard') return;

    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({
            content: "❌ Admin only.",
            ephemeral: true
        });
    }

    try {
        await interaction.reply({ content: "Resetting leaderboard...", ephemeral: true });

        db.run(`UPDATE leaderboard SET points = 0`);
        db.run(`DELETE FROM claims`);

        await updateLeaderboard();

        await interaction.followUp({
            content: "✅ Leaderboard reset complete.",
            ephemeral: true
        });

    } catch (err) {
        console.error(err);
        await interaction.followUp({
            content: "❌ Reset failed.",
            ephemeral: true
        });
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
        if (!channel) return;

        const message = await channel.messages.fetch(row.value);

        db.all(
            `SELECT username, points FROM leaderboard ORDER BY points DESC LIMIT 50`,
            async (err, rows) => {

                if (err) return;

                let board = "";

                if (!rows || rows.length === 0) {
                    board = "No activity yet.";
                } else {
                    rows.forEach((r, i) => {
                        const medal =
                            i === 0 ? '🥇' :
                            i === 1 ? '🥈' :
                            i === 2 ? '🥉' :
                            `${i + 1}.`;

                        board += `${medal} ${r.username} — ${r.points} 💉\n`;
                    });
                }

                await message.edit({
                    embeds: [buildEmbed(board)]
                });
            }
        );
    });
}

/*
=====================================
SEASON RESET + MVP ROLE
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

                if (oldMVP) {
                    await oldMVP.roles.remove(TOP_ROLE_ID).catch(() => {});
                }
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

        db.run(`UPDATE leaderboard SET points=0`);
        db.run(`UPDATE seasons SET value=? WHERE key='current'`, [current]);
    });
}

/*
=====================================
REACTION TRACKING
=====================================
*/
client.on('messageReactionAdd', async (reaction, user) => {

    try {
        if (user.bot) return;

        if (reaction.partial) await reaction.fetch();
        if (reaction.emoji.name !== EMOJI) return;

        db.get(`SELECT * FROM claims WHERE message_id=?`, [reaction.message.id], async (err, row) => {

            if (row) {
                return reaction.users.remove(user.id).catch(() => {});
            }

            db.run(`INSERT INTO claims(message_id,claimed_by) VALUES(?,?)`,
                [reaction.message.id, user.id]);

            db.run(`
                INSERT INTO leaderboard(user_id,username,points)
                VALUES(?,?,1)
                ON CONFLICT(user_id)
                DO UPDATE SET
                    points = points + 1,
                    username = excluded.username
            `, [user.id, user.username]);

            await updateLeaderboard();
        });

    } catch (err) {
        console.error(err);
    }
});

/*
=====================================
ADMIN COMMANDS
=====================================
*/
client.on('messageCreate', async (message) => {

    if (message.author.bot) return;
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

    const args = message.content.trim().split(/\s+/);
    const cmd = args[0];

    if (cmd !== '!add' && cmd !== '!remove') return;

    const user = message.mentions.users.first();
    if (!user) return message.reply("Mention a user.");

    const amount = parseInt(args[2] || "1");
    if (isNaN(amount)) return message.reply("Invalid number.");

    const delta = cmd === '!add' ? amount : -amount;

    db.run(`
        INSERT INTO leaderboard(user_id,username,points)
        VALUES(?,?,?)
        ON CONFLICT(user_id)
        DO UPDATE SET
            points = points + ?,
            username = excluded.username
    `, [user.id, user.username, delta, delta]);

    await updateLeaderboard();

    message.reply(
        `${cmd === '!add' ? 'Added' : 'Removed'} ${Math.abs(delta)} points for ${user.username}`
    );
});

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
Tracks completed revives across each quarter.

**How it works**
- React to revive request with 💉 to earn points
- Each message counts once per user
- Scores reset every quarter
- Abusing the system can result in a ban

---

**Leaderboard**
${boardText}`
        )
        .setFooter({
            text: `Updated ${new Date().toLocaleString()}`
        });
}

async function getTopUser() {
    return new Promise(res => {
        db.get(
            `SELECT user_id, username, points FROM leaderboard ORDER BY points DESC LIMIT 1`,
            (err, row) => {
                res(row || null);
            }
        );
    });
}

/*
=====================================
LOGIN
=====================================
*/
client.login(process.env.TOKEN);