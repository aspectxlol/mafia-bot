import { APIApplicationCommandBasicOption, ApplicationCommandOptionType } from 'discord.js';

import { DevCommandName } from '../enums/index.js';
import { Language } from '../models/enum-helpers/index.js';
import { Lang } from '../services/index.js';

export class Args {
    // ── Mafia game ─────────────────────────────────────────────────────────
    public static readonly TARGET_USER: APIApplicationCommandBasicOption = {
        name: 'target',
        description: Lang.getRef('argDescs.target', Language.Default),
        type: ApplicationCommandOptionType.User,
    };

    public static readonly TARGET_NAME: APIApplicationCommandBasicOption = {
        name: 'name',
        description: 'Name of an AI player to vote for (use this instead of @ for AI players)',
        type: ApplicationCommandOptionType.String,
    };

    public static readonly AI_COUNT: APIApplicationCommandBasicOption = {
        name: 'ai',
        description: 'Number of AI players to add (fills remaining slots up to 8 total).',
        type: ApplicationCommandOptionType.Integer,
        min_value: 1,
        max_value: 7,
    };

    public static player(n: number, required: boolean): APIApplicationCommandBasicOption {
        return {
            name: `player${n}`,
            description: Lang.getRef(`argDescs.player${n}`, Language.Default),
            type: ApplicationCommandOptionType.User,
            required,
        };
    }
    // ───────────────────────────────────────────────────────────────────────
    public static readonly DEV_COMMAND: APIApplicationCommandBasicOption = {
        name: Lang.getRef('arguments.command', Language.Default),
        name_localizations: Lang.getRefLocalizationMap('arguments.command'),
        description: Lang.getRef('argDescs.devCommand', Language.Default),
        description_localizations: Lang.getRefLocalizationMap('argDescs.devCommand'),
        type: ApplicationCommandOptionType.String,
        choices: [
            {
                name: Lang.getRef('devCommandNames.info', Language.Default),
                name_localizations: Lang.getRefLocalizationMap('devCommandNames.info'),
                value: DevCommandName.INFO,
            },
        ],
    };
}
