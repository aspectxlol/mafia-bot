import { ChannelType, Client, EmbedBuilder, PermissionFlagsBits, TextChannel } from 'discord.js';

import {
    clearTimers,
    createNightState,
    createVoteState,
    deleteGame,
    GameState,
    getGame,
    PlayerState,
} from './gameState.js';
import { assignRoles, getRoleCard, getRoleDisplayName, getRoleEmoji } from './roles.js';
import { checkWin } from './winCheck.js';
import { Logger } from '../services/index.js';

// ─── Timings ────────────────────────────────────────────────────────────────
const NIGHT_MS = 2 * 60 * 1000;
const NIGHT_WARN_MS = 1 * 60 * 1000;
const DAY_MS = 5 * 60 * 1000;
const VOTE_MS = 2 * 60 * 1000;
const VOTE_WARN_MS = 1 * 60 * 1000;

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
                ...mafiaIds.map(id => ({
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
        const teammates = mafiaIds.filter(mid => mid !== id).map(mid => game.players[mid].name);
        await sendDM(client, id, getRoleCard(player.role, teammates, id));
    }

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

    const embed = new EmbedBuilder()
        .setColor(0x1a0033)
        .setTitle(`🌙 Night ${game.round} begins`)
        .setDescription(
            `The town falls asleep...\n\n` +
                `**Alive players:**\n${aliveList}\n\n` +
                `Check your DMs for your night action.`
        )
        .setFooter({
            text: `${NIGHT_MS / 60000} minutes until day — actions auto-resolve at the end`,
        });

    await channel.send({ embeds: [embed] });

    // ── DM prompts ──────────────────────────────────────────────────────────
    for (const player of alivePlayers) {
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
        const detective = Object.values(game.players).find(p => p.role === 'detective' && p.alive);
        if (detective) {
            const target = game.players[investigateTarget];
            const isMafia = target?.role === 'mafia';
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

    game.lastNightDeath = killed?.id ?? null;
    game.lastNightSaved = saved;

    const win = checkWin(game);
    if (win) {
        await endGame(game, client, win);
        return;
    }

    await startDayPhase(game, client);
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

    const embed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle(`☀️ Day ${game.round}`)
        .setDescription(
            `${deathLine}\n\n` +
                `**Alive players (${alivePlayers.length}):**\n${alivePlayers.map(p => `• ${p.name}`).join('\n')}\n\n` +
                `Discuss and figure out who the Mafia is!\n` +
                `Voting opens in **${DAY_MS / 60000} minutes**.`
        )
        .setFooter({ text: `${DAY_MS / 60000} minutes of discussion` });

    await channel.send({ embeds: [embed] });

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

    const embed = new EmbedBuilder()
        .setColor(0xff6600)
        .setTitle('🗳️ Voting Phase')
        .setDescription(
            `Time to vote! Use \`/vote @player\` to vote to eliminate someone.\n` +
                `You have **${VOTE_MS / 60000} minutes**.\n\n` +
                `**Alive players:**\n${alivePlayers.map(p => `• ${p.name}`).join('\n')}`
        )
        .addFields({ name: 'Current Tally', value: 'No votes yet' })
        .setFooter({ text: 'Most votes = eliminated. Tie = no elimination.' });

    const tallyMsg = await channel.send({ embeds: [embed] });
    game.tallyMessageId = tallyMsg.id;

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

        const voteLines =
            Object.entries(game.vote.votes)
                .map(
                    ([vid, tid]) =>
                        `${game.players[vid]?.name ?? '?'} → ${game.players[tid]?.name ?? '?'}`
                )
                .join('\n') || 'No votes yet';

        const embed = new EmbedBuilder()
            .setColor(0xff6600)
            .setTitle('🗳️ Voting Phase — Live Tally')
            .setDescription(
                `Use \`/vote @player\` to cast or change your vote.\n\n` +
                    `**Alive players:**\n${alivePlayers.map(p => `• ${p.name}`).join('\n')}`
            )
            .addFields(
                { name: 'Votes', value: tallyLines || 'No votes' },
                { name: 'Who voted for whom', value: voteLines }
            );

        await msg.edit({ embeds: [embed] });
    } catch (err) {
        Logger.error('Failed to update vote tally', err);
    }
}

// ─── Vote Resolution ─────────────────────────────────────────────────────────
export async function resolveVote(game: GameState, client: Client): Promise<void> {
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

    deleteGame(game.gameChannelId);
}
