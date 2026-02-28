import {
    ApplicationCommandType,
    RESTPostAPIChatInputApplicationCommandsJSONBody,
    RESTPostAPIContextMenuApplicationCommandsJSONBody,
} from 'discord.js';

import { Args } from './index.js';
import { Language } from '../models/enum-helpers/index.js';
import { Lang } from '../services/index.js';

export const ChatCommandMetadata: {
    [command: string]: RESTPostAPIChatInputApplicationCommandsJSONBody;
} = {
    HELP: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.help', Language.Default),
        name_localizations: Lang.getRefLocalizationMap('chatCommands.help'),
        description: Lang.getRef('commandDescs.help', Language.Default),
        description_localizations: Lang.getRefLocalizationMap('commandDescs.help'),
        dm_permission: true,
        default_member_permissions: undefined,
    },
    INFO: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.info', Language.Default),
        name_localizations: Lang.getRefLocalizationMap('chatCommands.info'),
        description: Lang.getRef('commandDescs.info', Language.Default),
        description_localizations: Lang.getRefLocalizationMap('commandDescs.info'),
        dm_permission: true,
        default_member_permissions: undefined,
    },

    // ── Mafia game commands ─────────────────────────────────────────────────
    START: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.start', Language.Default),
        description: Lang.getRef('commandDescs.start', Language.Default),
        dm_permission: false,
        default_member_permissions: undefined,
        options: [
            Args.player(1, false),
            Args.player(2, false),
            Args.player(3, false),
            Args.player(4, false),
            Args.player(5, false),
            Args.player(6, false),
            Args.player(7, false),
            { ...Args.AI_COUNT, required: false },
        ],
    },
    KILL: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.kill', Language.Default),
        description: Lang.getRef('commandDescs.kill', Language.Default),
        dm_permission: false,
        default_member_permissions: undefined,
        options: [{ ...Args.TARGET_USER, required: true }],
    },
    INVESTIGATE: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.investigate', Language.Default),
        description: Lang.getRef('commandDescs.investigate', Language.Default),
        dm_permission: true,
        default_member_permissions: undefined,
        options: [{ ...Args.TARGET_USER, required: true }],
    },
    PROTECT: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.protect', Language.Default),
        description: Lang.getRef('commandDescs.protect', Language.Default),
        dm_permission: true,
        default_member_permissions: undefined,
        options: [{ ...Args.TARGET_USER, required: true }],
    },
    VOTE: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.vote', Language.Default),
        description: Lang.getRef('commandDescs.vote', Language.Default),
        dm_permission: false,
        default_member_permissions: undefined,
        options: [{ ...Args.TARGET_USER, required: true }],
    },
    STATUS: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.status', Language.Default),
        description: Lang.getRef('commandDescs.status', Language.Default),
        dm_permission: true,
        default_member_permissions: undefined,
    },
    END: {
        type: ApplicationCommandType.ChatInput,
        name: Lang.getRef('chatCommands.end', Language.Default),
        description: Lang.getRef('commandDescs.end', Language.Default),
        dm_permission: true,
        default_member_permissions: undefined,
    },
};

export const MessageCommandMetadata: {
    [command: string]: RESTPostAPIContextMenuApplicationCommandsJSONBody;
} = {};

export const UserCommandMetadata: {
    [command: string]: RESTPostAPIContextMenuApplicationCommandsJSONBody;
} = {};
