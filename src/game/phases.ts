import {
    ChannelType,
    Client,
    EmbedBuilder,
    Message,
    PermissionFlagsBits,
    TextChannel,
    time,
    WebhookClient,
} from 'discord.js';

import {
    clearTimers,
    createNightState,
    createVoteState,
    deleteGame,
    GameState,
    getGame,
    PlayerState,
} from './gameState.js';
import {
    generateAIReply,
    generateDayMessage,
    isAIId,
    logEvent,
    pickVoteTarget,
    runAINightAction,
} from './aiPlayer.js';
import { assignRoles, getRoleCard, getRoleDisplayName, getRoleEmoji } from './roles.js';
import { checkWin } from './winCheck.js';
import { Logger } from '../services/index.js';

// ─── Timings ────────────────────────────────────────────────────────────────
const NIGHT_MS = 120 * 1000;
const NIGHT_WARN_MS = 60 * 1000;
const DAY_MS = 5 * 60 * 1000;
const VOTE_MS = 120 * 1000;
const VOTE_WARN_MS = 60 * 1000;

// ─── Webhook cache (one per game channel) ───────────────────────────────────
const gameWebhooks = new Map<string, WebhookClient>();
const resolvingNightGames = new Set<string>();
const resolvingVoteGames = new Set<string>();

// cooldown: each AI can only auto-reply to questions once per 60 s (prevents reply chains)
const aiQuestionCooldowns = new Map<string, number>();
const AI_QUESTION_COOLDOWN_MS = 60_000;

/** Returns an avatar URL for an AI player using DiceBear bottts style. */
function aiAvatarUrl(name: string): string {
    return `https://api.dicebear.com/9.x/bottts-neutral/png?seed=${encodeURIComponent(name)}&size=128`;
}

/**
 * Lazily creates (or reuses) a webhook for the given channel.
 * The webhook is named after the game so multiple concurrent games don’t clash.
 */
async function getOrCreateWebhook(
    channel: TextChannel,
    gameNumber: number
): Promise<WebhookClient | null> {
    const cached = gameWebhooks.get(channel.id);
    if (cached) return cached;
    try {
        const hook = await channel.createWebhook({
            name: `Mafia Game #${gameNumber}`,
            reason: 'AI player chat webhook',
        });
        const client = new WebhookClient({ id: hook.id, token: hook.token! });
        gameWebhooks.set(channel.id, client);
        return client;
    } catch (err) {
        Logger.error('Failed to create AI webhook', err);
        return null;
    }
}

// ─── Question-reply handler (called by MessageHandler) ─────────────────────

/**
 * Core logic: scan `text` for questions directed at alive AI players and fire
 * immediate replies. Works for both human and AI senders.
 */
function triggerAIQuestionReplies(
    channelId: string,
    channel: TextChannel,
    askerName: string,
    text: string
): void {
    const game = getGame(channelId);
    if (!game || game.phase !== 'day') return;

    const lowerText = text.toLowerCase();
    const now = Date.now();

    for (const player of Object.values(game.players)) {
        if (!player.alive || !isAIId(player.id)) continue;

        const nameLower = player.name.toLowerCase();
        if (!lowerText.includes(nameLower)) continue;

        // Only react to questions ('?') or direct address (starts with the name)
        const isQuestion = text.includes('?');
        const isDirectAddress =
            lowerText.startsWith(nameLower) || lowerText.startsWith(`@${nameLower}`);
        if (!isQuestion && !isDirectAddress) continue;

        // Enforce cooldown
        const key = `${channelId}:${player.id}`;
        if (now - (aiQuestionCooldowns.get(key) ?? 0) < AI_QUESTION_COOLDOWN_MS) continue;
        aiQuestionCooldowns.set(key, now);

        const capturedPlayerId = player.id;
        void (async () => {
            const g = getGame(channelId);
            if (!g || g.phase !== 'day') return;
            const p = g.players[capturedPlayerId];
            if (!p || !p.alive) return;

            const webhook = await getOrCreateWebhook(channel, g.gameNumber);
            let pendingWebhookId: string | null = null;

            if (webhook) {
                const pending = await webhook
                    .send({
                        content: '💭 thinking...',
                        username: `${p.name} 🤖`,
                        avatarURL: aiAvatarUrl(p.name),
                    })
                    .catch(() => null);
                pendingWebhookId = pending?.id ?? null;
            }

            const reply = await generateAIReply(g, p, askerName, text);

            if (webhook && pendingWebhookId) {
                await webhook.editMessage(pendingWebhookId, { content: reply }).catch(() =>
                    webhook
                        .send({
                            content: reply,
                            username: `${p.name} 🤖`,
                            avatarURL: aiAvatarUrl(p.name),
                        })
                        .catch(() => null)
                );
            } else if (webhook) {
                await webhook
                    .send({
                        content: reply,
                        username: `${p.name} 🤖`,
                        avatarURL: aiAvatarUrl(p.name),
                    })
                    .catch(() => null);
            } else {
                await channel.send(`**${p.name} 🤖:** ${reply}`).catch(() => null);
            }

            const g2 = getGame(channelId);
            if (g2) logEvent(g2, `[Day ${g2.round}] ${p.name}: "${reply}"`);
        })().catch(err => Logger.error('AI question reply failed', err));
    }
}

/**
 * Called by MessageHandler for every human day-phase message.
 */
export function handleDayPlayerMessage(msg: Message): void {
    const game = getGame(msg.channelId);
    if (!game || game.phase !== 'day') return;
    const text = msg.content?.trim() ?? '';
    if (!text) return;
    const askerName = game.players[msg.author.id]?.name ?? msg.author.username;
    triggerAIQuestionReplies(msg.channelId, msg.channel as TextChannel, askerName, text);
}

// ─── DM helper ──────────────────────────────────────────────────────────────
export async function sendDM(
    client: Client,
    userId: string,
    content: string | EmbedBuilder
): Promise<void> {
    try {
        const user = await client.users.fetch(userId);
        if (typeof content === 'string') {
            await user.send(content);
        } else {
            await user.send({ embeds: [content] });
        }
    } catch {
        // User may have DMs disabled — silently ignore
    }
}

// ─── Launch (lobby → night) ─────────────────────────────────────────────────
export async function launchGame(game: GameState, client: Client): Promise<void> {
    clearTimers(game);

    const playerIds = Object.keys(game.players);
    const roleAssignment = assignRoles(playerIds);

    for (const [id, role] of Object.entries(roleAssignment)) {
        game.players[id].role = role;
    }

    const mafiaIds = playerIds.filter(id => game.players[id].role === 'mafia');
    const mafiaNames = mafiaIds.map(id => game.players[id].name);
    const realMafiaIds = mafiaIds.filter(id => !isAIId(id));

    // ── Create mafia secret channel ──────────────────────────────────────────
    try {
        const guild = await client.guilds.fetch(game.guildId);
        const mafiaChannel = await guild.channels.create({
            name: `mafia-secret-${game.gameNumber}`,
            type: ChannelType.GuildText,
            topic: `Mafia secret channel — Game #${game.gameNumber}`,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionFlagsBits.ViewChannel],
                },
                {
                    id: client.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                    ],
                },
                ...realMafiaIds.map(id => ({
                    id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                    ],
                })),
            ],
        });

        game.mafiaChannelId = mafiaChannel.id;

        await mafiaChannel.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x8b0000)
                    .setTitle('🔫 Welcome to the Mafia Channel!')
                    .setDescription(
                        `This channel is only visible to Mafia members. Use it to coordinate your nightly kill.`
                    )
                    .addFields(
                        { name: 'Your Team', value: mafiaNames.join(', ') || 'Just you!' },
                        {
                            name: 'Night Action',
                            value: 'Each night, use `/kill @target` here to choose who to eliminate.',
                        }
                    )
                    .setFooter({ text: `Game #${game.gameNumber}` }),
            ],
        });
    } catch (err) {
        Logger.error('Failed to create mafia channel', err);
    }

    // ── DM role cards ────────────────────────────────────────────────────────
    for (const [id, player] of Object.entries(game.players)) {
        if (player.isAI) continue; // AI players don't need DMs
        const teammates = mafiaIds.filter(mid => mid !== id).map(mid => game.players[mid].name);
        await sendDM(client, id, getRoleCard(player.role, teammates, id));
    }

    // ── Log game start ───────────────────────────────────────────────────────
    const allNames = Object.values(game.players)
        .map(p => p.name)
        .join(', ');
    logEvent(game, `[Game Start] Players: ${allNames}`);

    // ── Announcement ─────────────────────────────────────────────────────────
    const gameChannel = (await client.channels
        .fetch(game.gameChannelId)
        .catch(() => null)) as TextChannel | null;
    if (gameChannel) {
        await gameChannel.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x6600cc)
                    .setTitle(`🎭 Game #${game.gameNumber} is Starting!`)
                    .setDescription(
                        `Roles have been secretly assigned and sent to each player via DM. Check your DMs now!`
                    )
                    .addFields({
                        name: `Players (${Object.keys(game.players).length})`,
                        value: Object.values(game.players)
                            .map(p => `• **${p.name}**`)
                            .join('\n'),
                    })
                    .setFooter({ text: 'Night 1 begins shortly...' }),
            ],
        });
    }

    await startNightPhase(game, client);
}

// ─── Night Phase ─────────────────────────────────────────────────────────────
export async function startNightPhase(game: GameState, client: Client): Promise<void> {
    game.phase = 'night';
    game.night = createNightState();
    clearTimers(game);

    const channel = (await client.channels
        .fetch(game.gameChannelId)
        .catch(() => null)) as TextChannel | null;
    if (!channel) return;

    // Lock channel during night — @everyone cannot send messages
    try {
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
            SendMessages: false,
        });
    } catch {
        // Ignore permission errors (missing Manage Channel perms)
    }

    const alivePlayers = Object.values(game.players).filter(p => p.alive);
    const aliveList = alivePlayers.map(p => `• ${p.name}`).join('\n');

    const nightEndsAt = new Date(Date.now() + NIGHT_MS);

    const embed = new EmbedBuilder()
        .setColor(0x1a0033)
        .setTitle(`🌙 Night ${game.round} begins`)
        .setDescription(
            `The town falls asleep...\n\n` +
                `**Alive players:**\n${aliveList}\n\n` +
                `Check your DMs for your night action. \n` +
                `☀️ Day begins ${time(nightEndsAt, 'R')} — actions auto-resolve at the end`
        );

    await channel.send({ embeds: [embed] });

    // ── DM prompts ──────────────────────────────────────────────────────────
    for (const player of alivePlayers) {
        if (player.isAI) continue; // AI handled by scheduler below
        if (player.role === 'mafia') {
            const mafiaTeam = alivePlayers
                .filter(p => p.role === 'mafia' && p.id !== player.id)
                .map(p => p.name)
                .join(', ');
            await sendDM(
                client,
                player.id,
                new EmbedBuilder()
                    .setColor(0x8b0000)
                    .setTitle(`🌙 Night ${game.round} — Mafia Action`)
                    .addFields(
                        { name: 'Teammates', value: mafiaTeam || 'none' },
                        {
                            name: 'Action',
                            value: 'Use `/kill @target` in the **secret Mafia channel** to eliminate someone.',
                        },
                        { name: 'Alive Players', value: aliveList }
                    )
            );
        } else if (player.role === 'detective') {
            await sendDM(
                client,
                player.id,
                new EmbedBuilder()
                    .setColor(0x4169e1)
                    .setTitle(`🌙 Night ${game.round} — Detective Action`)
                    .addFields(
                        {
                            name: 'Action',
                            value: 'Use `/investigate @target` in **DM with me** to check if someone is Mafia.',
                        },
                        { name: 'Alive Players', value: aliveList }
                    )
            );
        } else if (player.role === 'doctor') {
            const constraints: string[] = [];
            if (game.round > 1 && game.players[player.id].protectedLastNight)
                constraints.push('⚠️ Cannot protect the same person as last night.');
            if (game.players[player.id].selfProtectUsed)
                constraints.push('⚠️ Self-protect already used.');
            else constraints.push('✅ You may still protect yourself (once per game).');
            await sendDM(
                client,
                player.id,
                new EmbedBuilder()
                    .setColor(0x00c851)
                    .setTitle(`🌙 Night ${game.round} — Doctor Action`)
                    .addFields(
                        {
                            name: 'Action',
                            value: 'Use `/protect @target` in **DM with me** to protect someone tonight.',
                        },
                        { name: 'Restrictions', value: constraints.join('\n') },
                        { name: 'Alive Players', value: aliveList }
                    )
            );
        }
    }

    // ── AI night actions ────────────────────────────────────────────────────
    const aiNightPlayers = alivePlayers.filter(p => isAIId(p.id) && p.role !== 'civilian');
    for (const aiPlayer of aiNightPlayers) {
        void (async () => {
            const g = getGame(game.gameChannelId);
            if (!g || g.phase !== 'night') return;
            const p = g.players[aiPlayer.id];
            if (!p || !p.alive) return;
            await runAINightAction(g, p);
            // Resolve immediately if all expected night actions are now in
            const g2 = getGame(game.gameChannelId);
            if (!g2 || g2.phase !== 'night') return;
            const alive2 = Object.values(g2.players).filter(p2 => p2.alive);
            const allDone =
                (!alive2.some(p2 => p2.role === 'mafia') ||
                    g2.night.actionsReceived.includes('kill')) &&
                (!alive2.some(p2 => p2.role === 'detective') ||
                    g2.night.actionsReceived.includes('investigate')) &&
                (!alive2.some(p2 => p2.role === 'doctor') ||
                    g2.night.actionsReceived.includes('protect'));
            if (allDone) await resolveNight(g2, client);
        })().catch(err => Logger.error('AI night action failed', err));
    }

    // ── 1-minute reminder ───────────────────────────────────────────────────
    game.reminderTimer = setTimeout(async () => {
        const g = getGame(game.gameChannelId);
        if (!g || g.phase !== 'night') return;

        const missing: string[] = [];
        const alive = Object.values(g.players).filter(p => p.alive);
        if (alive.some(p => p.role === 'mafia') && !g.night.actionsReceived.includes('kill'))
            missing.push('Mafia (kill)');
        if (
            alive.some(p => p.role === 'detective') &&
            !g.night.actionsReceived.includes('investigate')
        )
            missing.push('Detective (investigate)');
        if (alive.some(p => p.role === 'doctor') && !g.night.actionsReceived.includes('protect'))
            missing.push('Doctor (protect)');

        if (missing.length > 0) {
            await channel.send({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xff9900)
                        .setTitle('⏰ 1 Minute Remaining — Night Phase')
                        .setDescription(`Still waiting for: **${missing.join(', ')}**`),
                ],
            });
        }
    }, NIGHT_WARN_MS);

    // ── Auto-resolve timer ──────────────────────────────────────────────────
    game.phaseTimer = setTimeout(async () => {
        const g = getGame(game.gameChannelId);
        if (!g || g.phase !== 'night') return;
        await resolveNight(g, client);
    }, NIGHT_MS);
}

// ─── Night Resolution ────────────────────────────────────────────────────────
export async function resolveNight(game: GameState, client: Client): Promise<void> {
    if (game.phase !== 'night') return;
    if (resolvingNightGames.has(game.gameChannelId)) return;
    resolvingNightGames.add(game.gameChannelId);

    try {
        clearTimers(game);

        const { killTarget, protectTarget, investigateTarget } = game.night;

        // ── Doctor saves? ────────────────────────────────────────────────────────
        let saved = false;
        let killed: PlayerState | null = null;

        if (killTarget) {
            if (killTarget === protectTarget) {
                saved = true;
            } else {
                killed = game.players[killTarget] ?? null;
                if (killed) killed.alive = false;
            }
        }

        // ── Update doctor's last-night-protect flag ──────────────────────────────
        for (const player of Object.values(game.players)) {
            if (player.role === 'doctor') {
                player.protectedLastNight = protectTarget !== null;
                player.lastProtectedId = protectTarget;
            }
        }

        // ── Detective result DM ──────────────────────────────────────────────────
        if (investigateTarget) {
            const detective = Object.values(game.players).find(
                p => p.role === 'detective' && p.alive
            );
            if (detective) {
                const target = game.players[investigateTarget];
                const isMafia = target?.role === 'mafia';
                (game.playerLogs[detective.id] ??= []).push(
                    `[Night ${game.round}] You investigated ${target?.name ?? '?'}: ${isMafia ? 'MAFIA' : 'not Mafia'}`
                );
                if (!detective.isAI) {
                    await sendDM(
                        client,
                        detective.id,
                        new EmbedBuilder()
                            .setColor(isMafia ? 0x8b0000 : 0x00c851)
                            .setTitle(`🔍 Investigation Result — Night ${game.round}`)
                            .addFields({
                                name: target?.name ?? 'Unknown',
                                value: isMafia ? '🔫 **Mafia!**' : '✅ **Not Mafia**',
                            })
                    );
                }
            }
        }

        game.lastNightDeath = killed?.id ?? null;
        game.lastNightSaved = saved;

        if (saved) {
            logEvent(game, `[Night ${game.round}] Doctor saved someone from a Mafia kill`);
        } else if (killed) {
            logEvent(game, `[Night ${game.round}] ${killed.name} was killed by Mafia`);
        } else {
            logEvent(game, `[Night ${game.round}] No kill (no target chosen)`);
        }

        const win = checkWin(game);
        if (win) {
            await endGame(game, client, win);
            return;
        }

        await startDayPhase(game, client);
    } finally {
        resolvingNightGames.delete(game.gameChannelId);
    }
}

// ─── Day Phase ───────────────────────────────────────────────────────────────
export async function startDayPhase(game: GameState, client: Client): Promise<void> {
    game.phase = 'day';
    clearTimers(game);

    const channel = (await client.channels
        .fetch(game.gameChannelId)
        .catch(() => null)) as TextChannel | null;
    if (!channel) return;

    // Unlock channel for day discussion
    try {
        await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
            SendMessages: null, // reset to inherit
        });
    } catch {
        // Ignore permission errors
    }

    const alivePlayers = Object.values(game.players).filter(p => p.alive);

    let deathLine: string;
    if (game.lastNightSaved) {
        deathLine = '☀️ **Everyone survived the night.** The doctor protected someone!';
    } else if (game.lastNightDeath) {
        const dead = game.players[game.lastNightDeath];
        deathLine = `☀️ **${dead.name}** was found dead. They were a **${getRoleDisplayName(dead.role)}** ${getRoleEmoji(dead.role)} 💀`;
    } else {
        deathLine = '☀️ **Day begins.** No one was eliminated last night.';
    }

    const voteStartsAt = new Date(Date.now() + DAY_MS);

    const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle(`☀️ Day ${game.round}`)
        .setDescription(
            `${deathLine}\n\n` +
                `**Alive players (${alivePlayers.length}):**\n${alivePlayers.map(p => `• ${p.name}`).join('\n')}\n\n` +
                `Discuss and figure out who the Mafia is!\n` +
                `🗳️ Voting opens ${time(voteStartsAt, 'R')}`
        )
        .setFooter({ text: `Discussion ends ${time(voteStartsAt, 'T')}` });

    await channel.send({ embeds: [embed] });

    // ── AI day messages ──────────────────────────────────────────────────────
    const aiAlive = alivePlayers.filter(p => isAIId(p.id));
    const webhook = aiAlive.length > 0 ? await getOrCreateWebhook(channel, game.gameNumber) : null;

    /** Sends one AI day message for the given player ID. Returns the sent text, or null if aborted. */
    async function sendOneAIMessage(aiPlayerId: string): Promise<string | null> {
        const g = getGame(game.gameChannelId);
        if (!g || g.phase !== 'day') return null;
        const p = g.players[aiPlayerId];
        if (!p || !p.alive) return null;

        let pendingChannelMessage: { edit: (content: string) => Promise<unknown> } | null = null;
        let pendingWebhookMessageId: string | null = null;

        if (webhook) {
            const pending = await webhook
                .send({
                    content: '💭 thinking...',
                    username: `${p.name} 🤖`,
                    avatarURL: aiAvatarUrl(p.name),
                })
                .catch(() => null);
            pendingWebhookMessageId = pending?.id ?? null;
        } else {
            pendingChannelMessage = await channel
                .send(`**${p.name} 🤖:** _thinking..._`)
                .catch(() => null);
        }

        const text = await generateDayMessage(g, p);

        if (webhook) {
            if (pendingWebhookMessageId) {
                await webhook.editMessage(pendingWebhookMessageId, { content: text }).catch(() =>
                    webhook
                        .send({
                            content: text,
                            username: `${p.name} 🤖`,
                            avatarURL: aiAvatarUrl(p.name),
                        })
                        .catch(() => channel.send(text).catch(() => null))
                );
            } else {
                await webhook
                    .send({
                        content: text,
                        username: `${p.name} 🤖`,
                        avatarURL: aiAvatarUrl(p.name),
                    })
                    .catch(() => channel.send(text).catch(() => null));
            }
        } else {
            if (pendingChannelMessage) {
                await pendingChannelMessage
                    .edit(`**${p.name} 🤖:** ${text}`)
                    .catch(() => channel.send(`**${p.name} 🤖:** ${text}`).catch(() => null));
            } else {
                await channel.send(`**${p.name} 🤖:** ${text}`).catch(() => null);
            }
        }
        const gLog = getGame(game.gameChannelId);
        if (gLog) logEvent(gLog, `[Day ${gLog.round}] ${p.name}: "${text}"`);
        // Check if this AI message contains a question directed at another AI and trigger reply
        if (text) triggerAIQuestionReplies(game.gameChannelId, channel, p.name, text);
        return text;
    }

    // Assign each AI a random number of messages for the round:
    //   10% silent (0), 20% → 1, 30% → 2, 25% → 3, 15% → 4
    // All message slots are placed at fully random times across the day window,
    // creating natural back-and-forth bursts and silences instead of a uniform cadence.
    // Each slot fires independently via setTimeout so they don't block each other.
    const dayStart = Date.now();
    const safeWindowMs = DAY_MS - 30_000; // leave 30 s clear before voting

    function randomMsgCount(): number {
        const r = Math.random();
        if (r < 0.1) return 0;
        if (r < 0.3) return 1;
        if (r < 0.6) return 2;
        if (r < 0.85) return 3;
        return 4;
    }

    for (const aiPlayer of aiAlive) {
        const count = randomMsgCount();
        for (let i = 0; i < count; i++) {
            const delay = Math.floor(Math.random() * safeWindowMs);
            setTimeout(() => {
                sendOneAIMessage(aiPlayer.id).catch(err =>
                    Logger.error('AI day message failed', err)
                );
            }, delay);
        }
    }
    void dayStart; // suppress unused-var warning

    game.phaseTimer = setTimeout(async () => {
        const g = getGame(game.gameChannelId);
        if (!g || g.phase !== 'day') return;
        await startVotePhase(g, client);
    }, DAY_MS);
}

// ─── Vote Phase ──────────────────────────────────────────────────────────────
export async function startVotePhase(game: GameState, client: Client): Promise<void> {
    game.phase = 'vote';
    game.vote = createVoteState();
    clearTimers(game);

    const channel = (await client.channels
        .fetch(game.gameChannelId)
        .catch(() => null)) as TextChannel | null;
    if (!channel) return;

    const alivePlayers = Object.values(game.players).filter(p => p.alive);

    const voteEndsAt = new Date(Date.now() + VOTE_MS);

    const embed = new EmbedBuilder()
        .setColor(0xff6600)
        .setTitle('🗳️ Voting Phase')
        .setDescription(
            `Time to vote! Use \`/vote @player\` (or \`/vote name:PlayerName\` for AI players).\n` +
                `Voting closes ${time(voteEndsAt, 'R')}\n\n` +
                `**Alive players:**\n${alivePlayers.map(p => `• ${p.name}`).join('\n')}`
        )
        .addFields({ name: '📊 Vote Tally', value: 'No votes yet' })
        .setFooter({
            text: `Most votes = eliminated. Tie = no elimination. Closes ${time(voteEndsAt, 'T')}`,
        });

    const tallyMsg = await channel.send({ embeds: [embed] });
    game.tallyMessageId = tallyMsg.id;

    // ── AI votes ─────────────────────────────────────────────────────────────
    const aiAliveVote = alivePlayers.filter(p => isAIId(p.id));
    for (const aiPlayer of aiAliveVote) {
        void (async () => {
            const g = getGame(game.gameChannelId);
            if (!g || g.phase !== 'vote') return;
            const p = g.players[aiPlayer.id];
            if (!p || !p.alive || g.vote.votes[p.id]) return;
            const targetId = await pickVoteTarget(g, p);
            if (!targetId) return;
            g.vote.votes[p.id] = targetId;
            await updateVoteTally(g, client);
            const allAlive = Object.values(g.players).filter(pp => pp.alive);
            if (allAlive.every(pp => g.vote.votes[pp.id] !== undefined)) {
                await resolveVote(g, client);
            }
        })().catch(err => Logger.error('AI vote failed', err));
    }

    // ── 1-minute warning ─────────────────────────────────────────────────────
    game.reminderTimer = setTimeout(async () => {
        const g = getGame(game.gameChannelId);
        if (!g || g.phase !== 'vote') return;
        await channel.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(0xff9900)
                    .setTitle('⏰ 1 Minute Remaining — Voting Phase')
                    .setDescription(
                        'Cast or change your vote with `/vote @player` before time runs out!'
                    ),
            ],
        });
    }, VOTE_WARN_MS);

    // ── Auto-resolve timer ────────────────────────────────────────────────────
    game.phaseTimer = setTimeout(async () => {
        const g = getGame(game.gameChannelId);
        if (!g || g.phase !== 'vote') return;
        await resolveVote(g, client);
    }, VOTE_MS);
}

// ─── Update Live Vote Tally ──────────────────────────────────────────────────
export async function updateVoteTally(game: GameState, client: Client): Promise<void> {
    if (!game.tallyMessageId) return;

    try {
        const channel = (await client.channels
            .fetch(game.gameChannelId)
            .catch(() => null)) as TextChannel | null;
        if (!channel) return;

        const msg = await channel.messages.fetch(game.tallyMessageId).catch(() => null);
        if (!msg) return;

        // Rebuild tally
        const tally: Record<string, number> = {};
        for (const targetId of Object.values(game.vote.votes)) {
            tally[targetId] = (tally[targetId] ?? 0) + 1;
        }
        game.vote.tally = tally;

        const alivePlayers = Object.values(game.players).filter(p => p.alive);
        const tallyLines = alivePlayers
            .map(p => `• **${p.name}**: ${tally[p.id] ?? 0} vote(s)`)
            .join('\n');

        const votedCount = Object.keys(game.vote.votes).length;
        const totalCount = alivePlayers.length;

        const embed = new EmbedBuilder()
            .setColor(0xff6600)
            .setTitle('🗳️ Voting Phase — Live Tally')
            .setDescription(
                `Use \`/vote @player\` to cast or change your vote.\n` +
                    `**${votedCount}/${totalCount}** players have voted.\n\n` +
                    `**Alive players:**\n${alivePlayers.map(p => `• ${p.name}`).join('\n')}`
            )
            .addFields({ name: '📊 Vote Tally', value: tallyLines || 'No votes' });

        await msg.edit({ embeds: [embed] });
    } catch (err) {
        Logger.error('Failed to update vote tally', err);
    }
}

// ─── Vote Resolution ─────────────────────────────────────────────────────────
export async function resolveVote(game: GameState, client: Client): Promise<void> {
    if (game.phase !== 'vote') return;
    if (resolvingVoteGames.has(game.gameChannelId)) return;
    resolvingVoteGames.add(game.gameChannelId);

    try {
        clearTimers(game);

        const channel = (await client.channels
            .fetch(game.gameChannelId)
            .catch(() => null)) as TextChannel | null;
        if (!channel) return;

        const tally = game.vote.tally;
        const entries = Object.entries(tally).sort(([, a], [, b]) => b - a);

        if (entries.length === 0) {
            await channel.send({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x888888)
                        .setTitle('🤷 No Votes Cast')
                        .setDescription("The town couldn't decide. Nobody is eliminated."),
                ],
            });
        } else {
            const [topId, topVotes] = entries[0];
            const tied = entries.filter(([, v]) => v === topVotes);

            if (tied.length > 1) {
                const tieNames = tied.map(([id]) => game.players[id]?.name ?? id).join(', ');
                await channel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x888888)
                            .setTitle("⚖️ It's a Tie!")
                            .setDescription("The town couldn't decide. Nobody is eliminated.")
                            .addFields({
                                name: 'Tied Players',
                                value: `${tieNames} — each with **${topVotes}** vote(s)`,
                            }),
                    ],
                });
            } else {
                const eliminated = game.players[topId];
                if (eliminated) {
                    eliminated.alive = false;
                    logEvent(
                        game,
                        `[Day ${game.round}] ${eliminated.name} was eliminated by vote (was ${getRoleDisplayName(eliminated.role)})`
                    );
                    await channel.send({
                        embeds: [
                            new EmbedBuilder()
                                .setColor(0x8b0000)
                                .setTitle('🪓 Player Eliminated')
                                .setDescription(
                                    `**${eliminated.name}** has been eliminated with **${topVotes}** vote(s)!`
                                )
                                .addFields({
                                    name: 'Their Role',
                                    value: `${getRoleDisplayName(eliminated.role)} ${getRoleEmoji(eliminated.role)}`,
                                }),
                        ],
                    });
                }
            }
        }

        const win = checkWin(game);
        if (win) {
            await endGame(game, client, win);
            return;
        }

        game.round++;
        await startNightPhase(game, client);
    } finally {
        resolvingVoteGames.delete(game.gameChannelId);
    }
}

// ─── End Game ────────────────────────────────────────────────────────────────
export async function endGame(
    game: GameState,
    client: Client,
    winner: 'town' | 'mafia'
): Promise<void> {
    clearTimers(game);
    game.phase = 'ended';

    const channel = (await client.channels
        .fetch(game.gameChannelId)
        .catch(() => null)) as TextChannel | null;

    if (channel) {
        const allRoles = Object.values(game.players)
            .map(
                p =>
                    `• **${p.name}** — ${getRoleDisplayName(p.role)} ${getRoleEmoji(p.role)}${p.alive ? '' : ' 💀'}`
            )
            .join('\n');

        const embed = new EmbedBuilder()
            .setColor(winner === 'town' ? 0x00c851 : 0xff0000)
            .setTitle(winner === 'town' ? '🏆 Town Wins!' : '🏆 Mafia Wins!')
            .setDescription(
                winner === 'town'
                    ? 'The Mafia has been eliminated. The town is safe... for now!'
                    : 'The Mafia has seized control. Nobody is safe.'
            )
            .addFields({ name: 'All Roles Revealed', value: allRoles })
            .setFooter({ text: `Game #${game.gameNumber} | Thanks for playing Mafia!` });

        await channel.send({ embeds: [embed] });

        // Archive channel (read-only for everyone)
        try {
            await channel.permissionOverwrites.set([
                {
                    id: channel.guild.roles.everyone.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.ReadMessageHistory,
                    ],
                    deny: [PermissionFlagsBits.SendMessages],
                },
                {
                    id: client.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                    ],
                },
            ]);
            await channel.setTopic(
                `Mafia Game #${game.gameNumber} — ARCHIVED | ${winner === 'town' ? 'Town' : 'Mafia'} won`
            );
        } catch {
            // Ignore permission errors
        }
    }

    // Delete mafia secret channel
    if (game.mafiaChannelId) {
        try {
            const mafiaChannel = await client.channels.fetch(game.mafiaChannelId).catch(() => null);
            if (mafiaChannel) await (mafiaChannel as TextChannel).delete('Game ended');
        } catch {
            // Ignore
        }
    }

    // Delete AI webhook if one was created for this game
    const hook = gameWebhooks.get(game.gameChannelId);
    if (hook) {
        try {
            await hook.delete('Game ended');
        } catch {
            // Ignore — channel may already be archived/gone
        }
        hook.destroy();
        gameWebhooks.delete(game.gameChannelId);
    }

    deleteGame(game.gameChannelId);
}
