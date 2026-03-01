import { ButtonInteraction, MessageFlags, TextChannel } from 'discord.js';

import { Button, ButtonDeferType } from './button.js';
import { clearTimers, deleteGame, getGame } from '../game/gameState.js';
import { launchGame } from '../game/phases.js';
import { EventData } from '../models/internal-models.js';

export class ReadyButton implements Button {
    // Matches 'ready:<channelId>' and 'forcestart:<channelId>'
    public ids = ['ready', 'forcestart'];
    public deferType = ButtonDeferType.NONE;
    public requireGuild = true;
    public requireEmbedAuthorTag = false;

    public async execute(intr: ButtonInteraction, _data: EventData): Promise<void> {
        const colonIdx = intr.customId.indexOf(':');
        const action = intr.customId.slice(0, colonIdx);
        const channelId = intr.customId.slice(colonIdx + 1);

        const game = getGame(channelId);

        if (!game || game.phase !== 'lobby') {
            await intr.reply({
                content: '❌ No active lobby found for this game.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // ── READY ──────────────────────────────────────────────────────────────
        if (action === 'ready') {
            if (!game.players[intr.user.id]) {
                await intr.reply({
                    content: '❌ You are not in this game!',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            game.readyPlayers.add(intr.user.id);
            const humanPlayers = Object.values(game.players).filter(p => !p.isAI);
            const total = humanPlayers.length;
            const ready = humanPlayers.filter(p => game.readyPlayers.has(p.id)).length;

            await intr.reply({
                content: `✅ You're ready! (**${ready}/${total}** ready)`,
                flags: MessageFlags.Ephemeral,
            });

            // Update count message in channel
            try {
                const channel = intr.channel as TextChannel;
                const messages = await channel.messages.fetch({ limit: 10 });
                const countMsg = messages.find(
                    m => m.author.id === intr.client.user.id && m.content.startsWith('**Ready:')
                );
                if (countMsg) {
                    await countMsg.edit(`**Ready: ${ready} / ${total}**`);
                }
            } catch {
                // Ignore
            }

            // Launch if all ready
            if (ready === total) {
                clearTimers(game);
                await launchGame(game, intr.client);
            }

            // ── FORCE START ────────────────────────────────────────────────────────
        } else if (action === 'forcestart') {
            if (intr.user.id !== game.hostId) {
                await intr.reply({
                    content: '❌ Only the host can force start.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            // Remove unready players
            const unreadyIds = Object.keys(game.players).filter(id => !game.readyPlayers.has(id));
            for (const id of unreadyIds) {
                delete game.players[id];
                try {
                    const ch = intr.channel as TextChannel;
                    await ch.permissionOverwrites.delete(id, 'Removed from game (not ready)');
                } catch {
                    // Ignore
                }
            }

            const remaining = Object.keys(game.players).length;

            // Need at least 5 players
            if (remaining < 5) {
                clearTimers(game);
                deleteGame(game.gameChannelId);
                await intr.reply({
                    content: `❌ Only **${remaining}** player(s) are ready (minimum 5). Game cancelled.`,
                });
                return;
            }

            await intr.reply({
                content: `⚡ Force starting with **${remaining}** players!`,
            });

            clearTimers(game);
            await launchGame(game, intr.client);
        }
    }
}
