import { ChatInputCommandInteraction, PermissionsString } from 'discord.js';

import { Language } from '../../models/enum-helpers/index.js';
import { EventData } from '../../models/internal-models.js';
import { Lang } from '../../services/index.js';
import { ClientUtils, FormatUtils, InteractionUtils } from '../../utils/index.js';
import { Command, CommandDeferType } from '../index.js';

export class HelpCommand implements Command {
    public names = [Lang.getRef('chatCommands.help', Language.Default)];
    public deferType = CommandDeferType.HIDDEN;
    public requireClientPerms: PermissionsString[] = [];
    public async execute(intr: ChatInputCommandInteraction, data: EventData): Promise<void> {
        const [
            cmdHelp,
            cmdInfo,
            cmdStart,
            cmdKill,
            cmdInvestigate,
            cmdProtect,
            cmdVote,
            cmdStatus,
            cmdEnd,
        ] = await Promise.all([
            ClientUtils.findAppCommand(
                intr.client,
                Lang.getRef('chatCommands.help', Language.Default)
            ),
            ClientUtils.findAppCommand(
                intr.client,
                Lang.getRef('chatCommands.info', Language.Default)
            ),
            ClientUtils.findAppCommand(
                intr.client,
                Lang.getRef('chatCommands.start', Language.Default)
            ),
            ClientUtils.findAppCommand(
                intr.client,
                Lang.getRef('chatCommands.kill', Language.Default)
            ),
            ClientUtils.findAppCommand(
                intr.client,
                Lang.getRef('chatCommands.investigate', Language.Default)
            ),
            ClientUtils.findAppCommand(
                intr.client,
                Lang.getRef('chatCommands.protect', Language.Default)
            ),
            ClientUtils.findAppCommand(
                intr.client,
                Lang.getRef('chatCommands.vote', Language.Default)
            ),
            ClientUtils.findAppCommand(
                intr.client,
                Lang.getRef('chatCommands.status', Language.Default)
            ),
            ClientUtils.findAppCommand(
                intr.client,
                Lang.getRef('chatCommands.end', Language.Default)
            ),
        ]);

        const embed = Lang.getEmbed('displayEmbeds.helpCommands', data.lang, {
            CMD_LINK_HELP: FormatUtils.commandMention(cmdHelp),
            CMD_LINK_INFO: FormatUtils.commandMention(cmdInfo),
            CMD_LINK_START: FormatUtils.commandMention(cmdStart),
            CMD_LINK_KILL: FormatUtils.commandMention(cmdKill),
            CMD_LINK_INVESTIGATE: FormatUtils.commandMention(cmdInvestigate),
            CMD_LINK_PROTECT: FormatUtils.commandMention(cmdProtect),
            CMD_LINK_VOTE: FormatUtils.commandMention(cmdVote),
            CMD_LINK_STATUS: FormatUtils.commandMention(cmdStatus),
            CMD_LINK_END: FormatUtils.commandMention(cmdEnd),
        });

        await InteractionUtils.send(intr, embed);
    }
}
