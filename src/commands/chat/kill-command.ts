import { ChatInputCommandInteraction, PermissionsString } from 'discord.js';

import { getGameByMafiaChannel } from '../../game/gameState.js';
import { resolveNight } from '../../game/phases.js';
import { Language } from '../../models/enum-helpers/index.js';
import { EventData } from '../../models/internal-models.js';
import { Lang } from '../../services/index.js';
import { Command, CommandDeferType } from '../index.js';

export class KillCommand implements Command {
    public names = [Lang.getRef('chatCommands.kill', Language.Default)];
    public deferType = CommandDeferType.HIDDEN;
    public requireClientPerms: PermissionsString[] = [];

    public async execute(intr: ChatInputCommandInteraction, _data: EventData): Promise<void> {
        // Must be used in a mafia secret channel
        const game = getGameByMafiaChannel(intr.channelId);

        if (!game) {
            await intr.editReply(
                '❌ This command can only be used in the mafia secret channel during night phase.'
            );
            return;
        }

        if (game.phase !== 'night') {
            await intr.editReply(
                `❌ Night actions can only be submitted during the night phase. Current phase: **${game.phase}**.`
            );
            return;
        }

        const player = game.players[intr.user.id];
        if (!player || player.role !== 'mafia' || !player.alive) {
            await intr.editReply('❌ Only alive Mafia members can use this command.');
            return;
        }

        const targetUser = intr.options.getUser('target', false);
        const targetNameStr = intr.options.getString('name', false);

        if (!targetUser && !targetNameStr) {
            await intr.editReply(
                '❌ Please specify a target using `@mention` or the `name` option for AI players.'
            );
            return;
        }

        let targetPlayer;
        let targetId: string;

        if (targetNameStr) {
            const found = Object.values(game.players).find(
                p => p.name.toLowerCase() === targetNameStr.toLowerCase()
            );
            if (!found) {
                await intr.editReply(`❌ No player named **${targetNameStr}** in this game.`);
                return;
            }
            targetPlayer = found;
            targetId = found.id;
        } else {
            targetId = targetUser!.id;
            targetPlayer = game.players[targetId];
            if (!targetPlayer) {
                await intr.editReply('❌ That player is not in this game.');
                return;
            }
        }

        if (!targetPlayer.alive) {
            await intr.editReply(`❌ **${targetPlayer.name}** is already dead.`);
            return;
        }

        if (targetId === intr.user.id) {
            await intr.editReply('❌ You cannot target yourself.');
            return;
        }

        if (targetPlayer.role === 'mafia') {
            await intr.editReply('❌ You cannot target a fellow Mafia member.');
            return;
        }

        // Set kill target (overrides previous entry from any mafia member)
        game.night.killTarget = targetId;

        // Mark kill as received if not already
        if (!game.night.actionsReceived.includes('kill')) {
            game.night.actionsReceived.push('kill');
        }

        await intr.editReply(
            `✅ Kill target set to **${targetPlayer.name}**. The team can still change this before the night ends.`
        );

        // Check if ALL night actions are in — if so, resolve early
        const alive = Object.values(game.players).filter(p => p.alive);
        const needKill = alive.some(p => p.role === 'mafia');
        const needInvestigate = alive.some(p => p.role === 'detective');
        const needProtect = alive.some(p => p.role === 'doctor');

        const allDone =
            (!needKill || game.night.actionsReceived.includes('kill')) &&
            (!needInvestigate || game.night.actionsReceived.includes('investigate')) &&
            (!needProtect || game.night.actionsReceived.includes('protect'));

        if (allDone) {
            await resolveNight(game, intr.client);
        }
    }
}
