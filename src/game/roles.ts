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

export function getRoleCard(role: Role, mafiaTeamNames: string[], _playerId: string): string {
    switch (role) {
        case 'mafia':
            return (
                `🔫 **You are Mafia!**\n` +
                `Your goal: eliminate the Town.\n` +
                `Your team: **${mafiaTeamNames.join(', ') || 'Just you!'}**\n\n` +
                `Each night, use \`/kill @target\` in the secret Mafia channel.`
            );
        case 'detective':
            return (
                `🔍 **You are the Detective!**\n` +
                `Your goal: identify the Mafia.\n\n` +
                `Each night, use \`/investigate @target\` in **DM with me** to check if someone is Mafia.`
            );
        case 'doctor':
            return (
                `💊 **You are the Doctor!**\n` +
                `Your goal: protect innocent players.\n\n` +
                `Each night, use \`/protect @target\` in **DM with me** to protect someone from a Mafia kill.\n` +
                `Rules:\n` +
                `• Cannot protect the same person two nights in a row\n` +
                `• Can self-protect, but only once per game`
            );
        case 'civilian':
            return (
                `👤 **You are a Civilian!**\n` +
                `Your goal: help the Town identify the Mafia.\n\n` +
                `You have no night action. Use the day discussion and your votes wisely!`
            );
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
