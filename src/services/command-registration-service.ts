import { REST } from '@discordjs/rest';
import {
    APIApplicationCommand,
    RESTGetAPIApplicationCommandsResult,
    RESTPatchAPIApplicationCommandJSONBody,
    RESTPostAPIApplicationCommandsJSONBody,
    Routes,
} from 'discord.js';
import { createRequire } from 'node:module';

import { Logger } from './logger.js';

const require = createRequire(import.meta.url);
let Config = require('../../config/config.json');
let Logs = require('../../lang/logs.json');

export class CommandRegistrationService {
    constructor(private rest: REST) {}

    public async process(
        localCmds: RESTPostAPIApplicationCommandsJSONBody[],
        args: string[]
    ): Promise<void> {
        const parsed = this.parseArgs(args);
        const routes = this.getRoutes(parsed.guildId);

        let remoteCmds = (await this.rest.get(
            routes.commands as `/${string}`
        )) as RESTGetAPIApplicationCommandsResult;

        let localCmdsOnRemote = localCmds.filter(localCmd =>
            remoteCmds.some(remoteCmd => remoteCmd.name === localCmd.name)
        );
        let localCmdsOnly = localCmds.filter(
            localCmd => !remoteCmds.some(remoteCmd => remoteCmd.name === localCmd.name)
        );
        let remoteCmdsOnly = remoteCmds.filter(
            remoteCmd => !localCmds.some(localCmd => localCmd.name === remoteCmd.name)
        );

        switch (parsed.action) {
            case 'view': {
                Logger.info(
                    Logs.info.commandActionView
                        .replaceAll(
                            '{LOCAL_AND_REMOTE_LIST}',
                            this.formatCommandList(localCmdsOnRemote)
                        )
                        .replaceAll('{LOCAL_ONLY_LIST}', this.formatCommandList(localCmdsOnly))
                        .replaceAll('{REMOTE_ONLY_LIST}', this.formatCommandList(remoteCmdsOnly))
                );
                return;
            }
            case 'register': {
                if (localCmdsOnly.length > 0) {
                    Logger.info(
                        Logs.info.commandActionCreating.replaceAll(
                            '{COMMAND_LIST}',
                            this.formatCommandList(localCmdsOnly)
                        )
                    );
                    for (let localCmd of localCmdsOnly) {
                        await this.rest.post(routes.commands as `/${string}`, {
                            body: localCmd,
                        });
                    }
                    Logger.info(Logs.info.commandActionCreated);
                }

                if (localCmdsOnRemote.length > 0) {
                    Logger.info(
                        Logs.info.commandActionUpdating.replaceAll(
                            '{COMMAND_LIST}',
                            this.formatCommandList(localCmdsOnRemote)
                        )
                    );
                    for (let localCmd of localCmdsOnRemote) {
                        await this.rest.post(routes.commands as `/${string}`, {
                            body: localCmd,
                        });
                    }
                    Logger.info(Logs.info.commandActionUpdated);
                }

                return;
            }
            case 'rename': {
                let oldName = parsed.positionals[0];
                let newName = parsed.positionals[1];
                if (!(oldName && newName)) {
                    Logger.error(Logs.error.commandActionRenameMissingArg);
                    return;
                }

                let remoteCmd = remoteCmds.find(remoteCmd => remoteCmd.name == oldName);
                if (!remoteCmd) {
                    Logger.error(
                        Logs.error.commandActionNotFound.replaceAll('{COMMAND_NAME}', oldName)
                    );
                    return;
                }

                Logger.info(
                    Logs.info.commandActionRenaming
                        .replaceAll('{OLD_COMMAND_NAME}', remoteCmd.name)
                        .replaceAll('{NEW_COMMAND_NAME}', newName)
                );
                let body: RESTPatchAPIApplicationCommandJSONBody = {
                    name: newName,
                };
                await this.rest.patch(routes.command(remoteCmd.id) as `/${string}`, {
                    body,
                });
                Logger.info(Logs.info.commandActionRenamed);
                return;
            }
            case 'delete': {
                let name = parsed.positionals[0];
                if (!name) {
                    Logger.error(Logs.error.commandActionDeleteMissingArg);
                    return;
                }

                let remoteCmd = remoteCmds.find(remoteCmd => remoteCmd.name == name);
                if (!remoteCmd) {
                    Logger.error(
                        Logs.error.commandActionNotFound.replaceAll('{COMMAND_NAME}', name)
                    );
                    return;
                }

                Logger.info(
                    Logs.info.commandActionDeleting.replaceAll('{COMMAND_NAME}', remoteCmd.name)
                );
                await this.rest.delete(routes.command(remoteCmd.id) as `/${string}`);
                Logger.info(Logs.info.commandActionDeleted);
                return;
            }
            case 'clear': {
                Logger.info(
                    Logs.info.commandActionClearing.replaceAll(
                        '{COMMAND_LIST}',
                        this.formatCommandList(remoteCmds)
                    )
                );
                await this.rest.put(routes.commands as `/${string}`, { body: [] });
                Logger.info(Logs.info.commandActionCleared);
                return;
            }
        }
    }

    private parseArgs(args: string[]): {
        action: string;
        guildId?: string;
        positionals: string[];
    } {
        const relevant = args.slice(3);
        let guildId: string | undefined;
        const tokens: string[] = [];

        for (let index = 0; index < relevant.length; index++) {
            const token = relevant[index];
            if (token === '--guild' && relevant[index + 1]) {
                guildId = relevant[index + 1];
                index++;
                continue;
            }
            if (token.startsWith('--guild=')) {
                guildId = token.slice('--guild='.length);
                continue;
            }
            tokens.push(token);
        }

        return {
            action: tokens[0] ?? '',
            guildId,
            positionals: tokens.slice(1),
        };
    }

    private getRoutes(guildId?: string): {
        commands: `/${string}`;
        command: (commandId: string) => `/${string}`;
    } {
        if (guildId) {
            return {
                commands: Routes.applicationGuildCommands(Config.client.id, guildId),
                command: (commandId: string) =>
                    Routes.applicationGuildCommand(Config.client.id, guildId, commandId),
            };
        }

        return {
            commands: Routes.applicationCommands(Config.client.id),
            command: (commandId: string) => Routes.applicationCommand(Config.client.id, commandId),
        };
    }

    private formatCommandList(
        cmds: RESTPostAPIApplicationCommandsJSONBody[] | APIApplicationCommand[]
    ): string {
        return cmds.length > 0
            ? cmds.map((cmd: { name: string }) => `'${cmd.name}'`).join(', ')
            : 'N/A';
    }
}
