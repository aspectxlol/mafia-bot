import { ChatInputCommandInteraction, PermissionsString } from 'discord.js';

import { getGame } from '../../game/gameState.js';
import { resolveVote, updateVoteTally } from '../../game/phases.js';
import { Language } from '../../models/enum-helpers/index.js';
import { EventData } from '../../models/internal-models.js';
import { Lang } from '../../services/index.js';
import { Command, CommandDeferType } from '../index.js';

export class VoteCommand implements Command {
    public names = [Lang.getRef('chatCommands.vote', Language.Default)];
    public deferType = CommandDeferType.HIDDEN;
    public requireClientPerms: PermissionsString[] = [];

    public async execute(intr: ChatInputCommandInteraction, _data: EventData): Promise<void> {
        if (!intr.guild) {
            await intr.editReply('❌ This command must be used in the game channel.');
            return;
        }

        const game = getGame(intr.channelId);

        if (!game) {
            await intr.editReply('❌ No active game in this channel.');
            return;
        }

        if (game.phase !== 'vote') {
            await intr.editReply(
                `❌ Voting is not currently open. Current phase: **${game.phase}**.`
            );
            return;
        }

        const voter = game.players[intr.user.id];
        if (!voter || !voter.alive) {
            await intr.editReply('❌ Only alive players in this game can vote.');
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
            await intr.editReply('❌ You cannot vote for yourself.');
            return;
        }

        const previousVote = game.vote.votes[intr.user.id];
        game.vote.votes[intr.user.id] = target.id;

        if (previousVote && previousVote !== target.id) {
            const prev = game.players[previousVote];
            await intr.editReply(
                `✅ Vote changed from **${prev?.name ?? '?'}** to **${targetPlayer.name}**.`
            );
        } else {
            await intr.editReply(`✅ You voted to eliminate **${targetPlayer.name}**.`);
        }

        // Update live tally
        await updateVoteTally(game, intr.client);

        // Check if everyone alive has voted — resolve early
        const alivePlayers = Object.values(game.players).filter(p => p.alive);
        const allVoted = alivePlayers.every(p => game.vote.votes[p.id] !== undefined);
        if (allVoted) {
            await resolveVote(game, intr.client);
        }
    }
}
