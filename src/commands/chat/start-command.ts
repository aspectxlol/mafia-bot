import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    ChatInputCommandInteraction,
    EmbedBuilder,
    PermissionFlagsBits,
    PermissionsString,
    TextChannel,
    User,
} from 'discord.js';

import {
    GameState,
    getGame,
    getGameByUser,
    getNextGameNumber,
    PlayerState,
    setGame,
} from '../../game/gameState.js';
import { AI_NAMES, newAIId } from '../../game/aiPlayer.js';
import { buildRoleListText } from '../../game/roles.js';
import { Language } from '../../models/enum-helpers/index.js';
import { EventData } from '../../models/internal-models.js';
import { Lang } from '../../services/index.js';
import { Command, CommandDeferType } from '../index.js';

export class StartCommand implements Command {
    public names = [Lang.getRef('chatCommands.start', Language.Default)];
    public deferType = CommandDeferType.PUBLIC;
    public requireClientPerms: PermissionsString[] = [
        'ManageChannels',
        'ManageRoles',
        'ManageWebhooks',
    ];

    public async execute(intr: ChatInputCommandInteraction, _data: EventData): Promise<void> {
        if (!intr.guild) {
            await intr.editReply('❌ This command must be used in a server.');
            return;
        }

        // Check if host already in a game
        if (getGameByUser(intr.user.id)) {
            await intr.editReply(
                '❌ You are already in an active game! Use `/end` to cancel it first.'
            );
            return;
        }

        // Collect players: host + up to 7 mentions
        const aiCount = intr.options.getInteger('ai', false) ?? 0;
        const mentioned: User[] = [];
        for (let i = 1; i <= 7; i++) {
            const u = intr.options.getUser(`player${i}`, false);
            if (u) mentioned.push(u);
        }

        // Deduplicate (host auto-included)
        const seen = new Set<string>();
        const uniqueUsers: User[] = [];
        for (const u of [intr.user, ...mentioned]) {
            if (!seen.has(u.id)) {
                seen.add(u.id);
                uniqueUsers.push(u);
            }
        }

        // Check if any mentioned players are already in an active game
        const busyPlayers = uniqueUsers.filter(u => u.id !== intr.user.id && getGameByUser(u.id));
        if (busyPlayers.length > 0) {
            const names = busyPlayers.map(u => `<@${u.id}>`).join(', ');
            await intr.editReply(
                `❌ The following player(s) are already in an active game: ${names}`
            );
            return;
        }

        const totalPlayers = uniqueUsers.length + aiCount;
        if (totalPlayers < 5 || totalPlayers > 8) {
            await intr.editReply(
                `❌ Need **5–8 players** total (you + mentions + AI bots). Got **${totalPlayers}**.`
            );
            return;
        }

        if (uniqueUsers.some(u => u.bot)) {
            await intr.editReply('❌ Bot accounts cannot play Mafia.');
            return;
        }

        const gameNumber = getNextGameNumber();

        // ── Create game channel ────────────────────────────────────────────────
        let gameChannel: TextChannel;
        try {
            gameChannel = await intr.guild.channels.create({
                name: `mafia-game-${gameNumber}`,
                type: ChannelType.GuildText,
                topic: `Mafia Game #${gameNumber} | Phase: Lobby`,
                permissionOverwrites: [
                    {
                        id: intr.guild.roles.everyone.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.ReadMessageHistory,
                        ],
                        deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions],
                    },
                    {
                        id: intr.client.user.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.ManageMessages,
                            PermissionFlagsBits.ManageChannels,
                            PermissionFlagsBits.ReadMessageHistory,
                            PermissionFlagsBits.AddReactions,
                        ],
                    },
                    ...uniqueUsers.map(u => ({
                        id: u.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.ReadMessageHistory,
                            PermissionFlagsBits.AddReactions,
                        ],
                    })),
                ],
            });
        } catch {
            await intr.editReply(
                '❌ Failed to create game channel. Make sure I have **Manage Channels** and **Manage Roles** permissions.'
            );
            return;
        }

        // ── Build initial player state ─────────────────────────────────────────
        const players: Record<string, PlayerState> = {};
        for (const u of uniqueUsers) {
            const member = await intr.guild.members.fetch(u.id).catch(() => null);
            players[u.id] = {
                id: u.id,
                name: member?.displayName ?? u.username,
                role: 'civilian', // placeholder
                alive: true,
                isAI: false,
                protectedLastNight: false,
                lastProtectedId: null,
                selfProtectUsed: false,
            };
        }

        // ── Add AI players ─────────────────────────────────────────────────────
        const shuffledAINames = [...AI_NAMES].sort(() => Math.random() - 0.5);
        for (let i = 0; i < aiCount; i++) {
            const aiId = newAIId(gameNumber, i + 1);
            players[aiId] = {
                id: aiId,
                name: shuffledAINames[i % shuffledAINames.length],
                role: 'civilian', // placeholder
                alive: true,
                isAI: true,
                protectedLastNight: false,
                lastProtectedId: null,
                selfProtectUsed: false,
            };
        }

        // ── Build game state ───────────────────────────────────────────────────
        const gameState: GameState = {
            phase: 'lobby',
            gameNumber,
            hostId: intr.user.id,
            guildId: intr.guild.id,
            players,
            readyPlayers: new Set<string>(),
            night: {
                killTarget: null,
                protectTarget: null,
                investigateTarget: null,
                actionsReceived: [],
            },
            vote: { votes: {}, tally: {} },
            mafiaChannelId: null,
            gameChannelId: gameChannel.id,
            round: 1,
            phaseTimer: null,
            reminderTimer: null,
            readyTimerFired: false,
            readyMessageId: null,
            tallyMessageId: null,
            lastNightDeath: null,
            lastNightSaved: false,
            gameLog: [],
            playerLogs: {},
            aiTimers: [],
        };

        setGame(gameChannel.id, gameState);

        // Pre-ready all AI players (they don't need to click Ready)
        for (let i = 0; i < aiCount; i++) {
            gameState.readyPlayers.add(newAIId(gameNumber, i + 1));
        }

        // ── Post lobby embed with Ready button ─────────────────────────────────
        const realList = uniqueUsers.map(u => `<@${u.id}>`).join(', ');
        const aiList = Object.values(players)
            .filter(p => p.isAI)
            .map(p => `${p.name} 🤖`)
            .join(', ');
        const playerList = [realList, aiList].filter(Boolean).join(', ');
        const roleList = buildRoleListText(gameState);

        const embed = new EmbedBuilder()
            .setColor(0x7b2dff)
            .setTitle(`🎭 Mafia Game #${gameNumber} — Lobby`)
            .setDescription(
                `Welcome! A social deduction game of **Town vs Mafia**.\n\n` +
                    `**Players (${totalPlayers}):** ${playerList}\n\n` +
                    `**Roles in this game:**\n${roleList}\n\n` +
                    `**Quick Rules:**\n` +
                    `🌙 **Night** — Mafia kills. Detective investigates. Doctor protects.\n` +
                    `☀️ **Day** — Discuss for 5 minutes.\n` +
                    `🗳️ **Vote** — Use \`/vote @player\` to eliminate someone.\n\n` +
                    `🏆 Town wins when all Mafia are dead.\n` +
                    `🏆 Mafia wins when they equal or outnumber the Town.\n\n` +
                    `**Click ✅ Ready when you're set to go!**`
            )
            .setFooter({
                text: 'Host gets a Force Start button after 5 minutes if not all ready.',
            });

        const readyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`ready:${gameChannel.id}`)
                .setLabel('✅  Ready!')
                .setStyle(ButtonStyle.Success)
        );

        const readyMsg = await gameChannel.send({ embeds: [embed], components: [readyRow] });
        gameState.readyMessageId = readyMsg.id;

        const aiReadyNote =
            aiCount > 0 ? ` (${aiCount} AI player${aiCount > 1 ? 's' : ''} auto-ready)` : '';
        await gameChannel.send(`**Ready: 0 / ${uniqueUsers.length}**${aiReadyNote}`);

        // ── 5-minute force-start timer ─────────────────────────────────────────
        gameState.phaseTimer = setTimeout(
            async () => {
                const g = getGame(gameChannel.id);
                if (!g || g.phase !== 'lobby') return;
                g.readyTimerFired = true;

                const forceRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`forcestart:${gameChannel.id}`)
                        .setLabel('⚡ Force Start')
                        .setStyle(ButtonStyle.Danger)
                );

                await gameChannel.send({
                    content: `<@${intr.user.id}> Not all players are ready after 5 minutes. Click below to force start (unready players will be removed).`,
                    components: [forceRow],
                });
            },
            5 * 60 * 1000
        );

        await intr.editReply(
            `✅ Game channel created: ${gameChannel}. Head over to start the game!`
        );
    }
}
