import { ChatInputCommandInteraction, EmbedBuilder, PermissionsString } from 'discord.js';

import { GameState, getAllGames, getGame, getGameByUser } from '../../game/gameState.js';
import { getRoleDisplayName, getRoleEmoji } from '../../game/roles.js';
import { Language } from '../../models/enum-helpers/index.js';
import { EventData } from '../../models/internal-models.js';
import { Lang } from '../../services/index.js';
import { InteractionUtils } from '../../utils/index.js';
import { Command, CommandDeferType } from '../index.js';

export class StatusCommand implements Command {
    public names = [Lang.getRef('chatCommands.status', Language.Default)];
    public deferType = CommandDeferType.HIDDEN;
    public requireClientPerms: PermissionsString[] = [];

    public async execute(intr: ChatInputCommandInteraction, _data: EventData): Promise<void> {
        // Try to find the game context: game channel > user's game > any game in server
        let game: GameState | undefined =
            getGame(intr.channelId) ??
            getGameByUser(intr.user.id) ??
            (intr.guild
                ? getAllGames().find(g => g.guildId === intr.guild.id && g.phase !== 'ended')
                : undefined);

        if (!game) {
            await intr.editReply('❌ No active Mafia game found.');
            return;
        }

        const alivePlayers = Object.values(game.players).filter(p => p.alive);
        const deadPlayers = Object.values(game.players).filter(p => !p.alive);

        const aliveList = alivePlayers.map(p => `• ${p.name}`).join('\n') || 'None';
        const deadList =
            deadPlayers
                .map(p => `• ${p.name} — ${getRoleDisplayName(p.role)} ${getRoleEmoji(p.role)}`)
                .join('\n') || 'None';

        const phaseEmoji: Record<string, string> = {
            lobby: '🏠',
            night: '🌙',
            day: '☀️',
            vote: '🗳️',
            ended: '🏁',
        };

        const embed = new EmbedBuilder()
            .setColor(0x7b2dff)
            .setTitle(`${phaseEmoji[game.phase] ?? '🎭'} Mafia Game #${game.gameNumber} — Status`)
            .addFields(
                {
                    name: 'Phase',
                    value: `**${game.phase.charAt(0).toUpperCase() + game.phase.slice(1)}** (Round ${game.round})`,
                    inline: true,
                },
                { name: 'Host', value: `<@${game.hostId}>`, inline: true },
                { name: '\u200B', value: '\u200B', inline: true },
                { name: `Alive (${alivePlayers.length})`, value: aliveList },
                { name: `Dead (${deadPlayers.length})`, value: deadList }
            );

        // Show live vote tally if in vote phase
        if (game.phase === 'vote' && Object.keys(game.vote.tally).length > 0) {
            const tallyText = Object.entries(game.vote.tally)
                .sort(([, a], [, b]) => b - a)
                .map(([id, count]) => `• **${game.players[id]?.name ?? id}**: ${count} vote(s)`)
                .join('\n');
            embed.addFields({ name: '🗳️ Current Vote Tally', value: tallyText });
        }

        await InteractionUtils.send(intr, embed, true);
    }
}
