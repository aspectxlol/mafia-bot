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
            await intr.editReply(
                '❌ You have already submitted your investigation for this night.'
            );
            return;
        }

        const target = intr.options.getUser('target', true);
        const targetPlayer = game.players[target.id];

        if (!targetPlayer) {
            await intr.editReply('❌ That player is not in this game.');
            return;
        }

        if (!targetPlayer.alive) {
            await intr.editReply(`❌ **${targetPlayer.name}** is already dead.`);
            return;
        }

        if (target.id === intr.user.id) {
            await intr.editReply('❌ You cannot investigate yourself.');
            return;
        }

        game.night.investigateTarget = target.id;
        game.night.actionsReceived.push('investigate');

        await intr.editReply(
            `✅ You will investigate **${targetPlayer.name}** tonight. Your result will arrive at the end of the night.`
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
