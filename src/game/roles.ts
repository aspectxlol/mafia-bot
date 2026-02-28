import { EmbedBuilder } from 'discord.js';

import { GameState, Role } from './gameState.js';

export interface RoleBalance {
    mafia: number;
    detective: number;
    doctor: number;
    civilian: number;
}

export const BALANCE_TABLE: Record<number, RoleBalance> = {
    5: { mafia: 1, detective: 1, doctor: 0, civilian: 3 },
    6: { mafia: 1, detective: 1, doctor: 1, civilian: 3 },
    7: { mafia: 2, detective: 1, doctor: 1, civilian: 3 },
    8: { mafia: 2, detective: 1, doctor: 1, civilian: 4 },
};

export function getBalance(playerCount: number): RoleBalance | null {
    return BALANCE_TABLE[playerCount] ?? null;
}

export function assignRoles(playerIds: string[]): Record<string, Role> {
    const count = playerIds.length;
    const balance = BALANCE_TABLE[count];
    if (!balance) throw new Error(`Invalid player count: ${count}`);

    const roles: Role[] = [
        ...Array<Role>(balance.mafia).fill('mafia'),
        ...Array<Role>(balance.detective).fill('detective'),
        ...Array<Role>(balance.doctor).fill('doctor'),
        ...Array<Role>(balance.civilian).fill('civilian'),
    ];

    // Fisher-Yates shuffle
    for (let i = roles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [roles[i], roles[j]] = [roles[j], roles[i]];
    }

    const result: Record<string, Role> = {};
    playerIds.forEach((id, i) => {
        result[id] = roles[i];
    });
    return result;
}

export function getRoleEmoji(role: Role): string {
    switch (role) {
        case 'mafia':
            return '🔫';
        case 'detective':
            return '🔍';
        case 'doctor':
            return '💊';
        case 'civilian':
            return '👤';
    }
}

export function getRoleDisplayName(role: Role): string {
    switch (role) {
        case 'mafia':
            return 'Mafia';
        case 'detective':
            return 'Detective';
        case 'doctor':
            return 'Doctor';
        case 'civilian':
            return 'Civilian';
    }
}

export function getRoleCard(role: Role, mafiaTeamNames: string[], _playerId: string): EmbedBuilder {
    switch (role) {
        case 'mafia':
            return new EmbedBuilder()
                .setColor(0x8b0000)
                .setTitle('🔫 You are Mafia!')
                .setDescription('Your goal: eliminate the Town before they vote you out.')
                .addFields(
                    {
                        name: 'Your Team',
                        value: mafiaTeamNames.join(', ') || 'Just you!',
                    },
                    {
                        name: 'Night Action',
                        value: 'Use `/kill @target` in the **secret Mafia channel** each night.',
                    }
                );
        case 'detective':
            return new EmbedBuilder()
                .setColor(0x4169e1)
                .setTitle('🔍 You are the Detective!')
                .setDescription('Your goal: identify and expose the Mafia to the Town.')
                .addFields({
                    name: 'Night Action',
                    value: 'Use `/investigate @target` in **DM with me** — I will tell you if they are Mafia.',
                });
        case 'doctor':
            return new EmbedBuilder()
                .setColor(0x00c851)
                .setTitle('💊 You are the Doctor!')
                .setDescription('Your goal: keep innocent players alive.')
                .addFields(
                    {
                        name: 'Night Action',
                        value: 'Use `/protect @target` in **DM with me** to shield someone from a Mafia kill.',
                    },
                    {
                        name: 'Rules',
                        value: '• Cannot protect the same person two nights in a row\n• Can self-protect, but only once per game',
                    }
                );
        case 'civilian':
            return new EmbedBuilder()
                .setColor(0xffd700)
                .setTitle('👤 You are a Civilian!')
                .setDescription('Your goal: help the Town identify and eliminate the Mafia.')
                .addFields({
                    name: 'Your Role',
                    value: 'You have no night action. Listen carefully, discuss, and vote wisely each day!',
                });
    }
}

export function buildRoleListText(game: GameState): string {
    const balance = BALANCE_TABLE[Object.keys(game.players).length];
    if (!balance) return '';
    return [
        `🔫 Mafia × ${balance.mafia}`,
        `🔍 Detective × ${balance.detective}`,
        balance.doctor > 0 ? `💊 Doctor × ${balance.doctor}` : null,
        `👤 Civilian × ${balance.civilian}`,
    ]
        .filter(Boolean)
        .join('\n');
}

export { Role };
