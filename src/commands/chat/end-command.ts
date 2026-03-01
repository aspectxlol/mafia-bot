import {
    ChatInputCommandInteraction,
    EmbedBuilder,
    PermissionFlagsBits,
    PermissionsString,
    TextChannel,
} from 'discord.js';

import { clearTimers, deleteGame, getAllGames, getGame } from '../../game/gameState.js';
import { cleanupGameWebhook } from '../../game/phases.js';
import { Language } from '../../models/enum-helpers/index.js';
import { EventData } from '../../models/internal-models.js';
import { Lang } from '../../services/index.js';
import { Command, CommandDeferType } from '../index.js';

export class EndCommand implements Command {
    public names = [Lang.getRef('chatCommands.end', Language.Default)];
    public deferType = CommandDeferType.HIDDEN;
    public requireClientPerms: PermissionsString[] = [];

    public async execute(intr: ChatInputCommandInteraction, _data: EventData): Promise<void> {
        // Find the game this host is associated with
        // Prioritize: game channel → game hosted by user → any game hosted by user in guild
        const channelGame = getGame(intr.channelId);
        const game =
            channelGame ??
            getAllGames().find(g => g.hostId === intr.user.id && g.phase !== 'ended') ??
            (intr.guild
                ? getAllGames().find(
                      g =>
                          g.guildId === intr.guild!.id &&
                          g.hostId === intr.user.id &&
                          g.phase !== 'ended'
                  )
                : undefined);

        if (!game) {
            await intr.editReply('❌ No active game found that you are hosting.');
            return;
        }

        if (game.hostId !== intr.user.id) {
            await intr.editReply('❌ Only the game host can force-end the game.');
            return;
        }

        clearTimers(game);
        game.phase = 'ended';

        // Announce in game channel
        try {
            const gameChannel = (await intr.client.channels
                .fetch(game.gameChannelId)
                .catch(() => null)) as TextChannel | null;
            if (gameChannel) {
                await gameChannel.send({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0xff4a4a)
                            .setTitle(`🛑 Game #${game.gameNumber} Force-Ended`)
                            .setDescription(
                                `The game was force-ended by the host <@${intr.user.id}>.`
                            ),
                    ],
                });
            }
        } catch {
            // Ignore
        }

        // Delete mafia channel
        if (game.mafiaChannelId) {
            try {
                const mafiaChannel = await intr.client.channels
                    .fetch(game.mafiaChannelId)
                    .catch(() => null);
                if (mafiaChannel) await (mafiaChannel as TextChannel).delete('Game force-ended');
            } catch {
                // Ignore
            }
        }

        // Archive game channel (read-only)
        try {
            const gameChannel = (await intr.client.channels
                .fetch(game.gameChannelId)
                .catch(() => null)) as TextChannel | null;
            if (gameChannel) {
                await gameChannel.permissionOverwrites.set([
                    {
                        id: gameChannel.guild.roles.everyone.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.ReadMessageHistory,
                        ],
                        deny: [PermissionFlagsBits.SendMessages],
                    },
                    {
                        id: intr.client.user!.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.ReadMessageHistory,
                        ],
                    },
                ]);
                await gameChannel.setTopic(
                    `Mafia Game #${game.gameNumber} — ARCHIVED | Force-ended`
                );
            }
        } catch {
            // Ignore permission errors
        }

        // Cleanup webhook
        cleanupGameWebhook(game.gameChannelId);

        deleteGame(game.gameChannelId);

        await intr.editReply(`✅ Game #${game.gameNumber} has been ended.`);
    }
}
