import { ChatInputCommandInteraction, PermissionsString } from 'discord.js';

import { getGameByUser } from '../../game/gameState.js';
import { resolveNight } from '../../game/phases.js';
import { Language } from '../../models/enum-helpers/index.js';
import { EventData } from '../../models/internal-models.js';
import { Lang } from '../../services/index.js';
import { Command, CommandDeferType } from '../index.js';

export class InvestigateCommand implements Command {
    public names = [Lang.getRef('chatCommands.investigate', Language.Default)];
    public deferType = CommandDeferType.HIDDEN;
    public requireClientPerms: PermissionsString[] = [];

    public async execute(intr: ChatInputCommandInteraction, _data: EventData): Promise<void> {
        // Must be used in DM
        if (intr.guild) {
            await intr.editReply(
                '❌ Use this command in a **DM with me**, not in a server channel.'
            );
            return;
        }

        const game = getGameByUser(intr.user.id);

        if (!game) {
            await intr.editReply('❌ You are not in an active game.');
            return;
        }

        if (game.phase !== 'night') {
            await intr.editReply(
                `❌ Night actions can only be submitted during the night phase. Current phase: **${game.phase}**.`
            );
            return;
        }

        const player = game.players[intr.user.id];
        if (!player || player.role !== 'detective' || !player.alive) {
            await intr.editReply('❌ Only the alive Detective can use this command.');
            return;
        }

        if (game.night.actionsReceived.includes('investigate')) {
            // Allow changing target — remove old action so it can be re-submitted
            const idx = game.night.actionsReceived.indexOf('investigate');
            if (idx !== -1) game.night.actionsReceived.splice(idx, 1);
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
            await intr.editReply('❌ You cannot investigate yourself.');
            return;
        }

        game.night.investigateTarget = targetId;
        game.night.actionsReceived.push('investigate');

        await intr.editReply(
            `✅ You will investigate **${targetPlayer.name}** tonight. You can change this before the night ends.`
        );

        // Check if all night actions are received — resolve early if so
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
