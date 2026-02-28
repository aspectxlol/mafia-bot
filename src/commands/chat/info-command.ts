import { ChatInputCommandInteraction, PermissionsString } from 'discord.js';

import { Language } from '../../models/enum-helpers/index.js';
import { EventData } from '../../models/internal-models.js';
import { Lang } from '../../services/index.js';
import { InteractionUtils } from '../../utils/index.js';
import { Command, CommandDeferType } from '../index.js';

export class InfoCommand implements Command {
    public names = [Lang.getRef('chatCommands.info', Language.Default)];
    public deferType = CommandDeferType.HIDDEN;
    public requireClientPerms: PermissionsString[] = [];

    public async execute(intr: ChatInputCommandInteraction, data: EventData): Promise<void> {
        const embed = Lang.getEmbed('displayEmbeds.about', data.lang);
        await InteractionUtils.send(intr, embed);
    }
}
