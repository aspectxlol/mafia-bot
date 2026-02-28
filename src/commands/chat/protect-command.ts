import { ChatInputCommandInteraction, PermissionsString } from 'discord.js';

import { getGameByUser } from '../../game/gameState.js';
import { resolveNight } from '../../game/phases.js';
import { Language } from '../../models/enum-helpers/index.js';
import { EventData } from '../../models/internal-models.js';
import { Lang } from '../../services/index.js';
import { Command, CommandDeferType } from '../index.js';

export class ProtectCommand implements Command {
    public names = [Lang.getRef('chatCommands.protect', Language.Default)];
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

        const doctor = game.players[intr.user.id];
        if (!doctor || doctor.role !== 'doctor' || !doctor.alive) {
            await intr.editReply('❌ Only the alive Doctor can use this command.');
            return;
        }

        if (game.night.actionsReceived.includes('protect')) {
            await intr.editReply('❌ You have already submitted your protection for this night.');
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

        // Rule: cannot protect same person two nights in a row
        if (doctor.lastProtectedId && doctor.lastProtectedId === target.id) {
            await intr.editReply(
                `❌ You cannot protect **${targetPlayer.name}** two nights in a row. Choose someone else.`
            );
            return;
        }

        // Rule: can only self-protect once per game
        if (target.id === intr.user.id) {
            if (doctor.selfProtectUsed) {
                await intr.editReply('❌ You have already used your self-protect this game.');
                return;
            }
            doctor.selfProtectUsed = true;
        }

        game.night.protectTarget = target.id;
        game.night.actionsReceived.push('protect');

        await intr.editReply(`✅ You will protect **${targetPlayer.name}** tonight.`);

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
