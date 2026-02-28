import { describe, expect, it } from 'vitest';

import {
    createNightState,
    createVoteState,
    GameState,
    PlayerState,
} from '../../src/game/gameState.js';
import {
    assignRoles,
    BALANCE_TABLE,
    buildRoleListText,
    getBalance,
    getRoleCard,
    getRoleDisplayName,
    getRoleEmoji,
    Role,
    RoleBalance,
} from '../../src/game/roles.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makePlayer(id: string, role: Role = 'civilian'): PlayerState {
    return {
        id,
        name: `Player${id}`,
        role,
        alive: true,
        protectedLastNight: false,
        lastProtectedId: null,
        selfProtectUsed: false,
    };
}

function gameWithNPlayers(n: number): GameState {
    const players: Record<string, PlayerState> = {};
    for (let i = 1; i <= n; i++) {
        players[`u${i}`] = makePlayer(`u${i}`);
    }
    return {
        phase: 'lobby',
        gameNumber: 1,
        hostId: 'u1',
        guildId: 'guild1',
        players,
        readyPlayers: new Set(),
        night: createNightState(),
        vote: createVoteState(),
        mafiaChannelId: null,
        gameChannelId: 'ch1',
        round: 0,
        phaseTimer: null,
        reminderTimer: null,
        readyTimerFired: false,
        readyMessageId: null,
        tallyMessageId: null,
        lastNightDeath: null,
        lastNightSaved: false,
    };
}

// ── BALANCE_TABLE ─────────────────────────────────────────────────────────────

describe('BALANCE_TABLE', () => {
    it('has entries for player counts 5 through 8', () => {
        expect(BALANCE_TABLE).toHaveProperty('5');
        expect(BALANCE_TABLE).toHaveProperty('6');
        expect(BALANCE_TABLE).toHaveProperty('7');
        expect(BALANCE_TABLE).toHaveProperty('8');
    });

    it('5-player balance: 1 mafia, 1 det, 0 doc, 3 civ', () => {
        const b = BALANCE_TABLE[5];
        expect(b.mafia).toBe(1);
        expect(b.detective).toBe(1);
        expect(b.doctor).toBe(0);
        expect(b.civilian).toBe(3);
    });

    it('6-player balance: 1 mafia, 1 det, 1 doc, 3 civ', () => {
        const b = BALANCE_TABLE[6];
        expect(b.mafia).toBe(1);
        expect(b.detective).toBe(1);
        expect(b.doctor).toBe(1);
        expect(b.civilian).toBe(3);
    });

    it('7-player balance: 2 mafia, 1 det, 1 doc, 3 civ', () => {
        const b = BALANCE_TABLE[7];
        expect(b.mafia).toBe(2);
        expect(b.detective).toBe(1);
        expect(b.doctor).toBe(1);
        expect(b.civilian).toBe(3);
    });

    it('8-player balance: 2 mafia, 1 det, 1 doc, 4 civ', () => {
        const b = BALANCE_TABLE[8];
        expect(b.mafia).toBe(2);
        expect(b.detective).toBe(1);
        expect(b.doctor).toBe(1);
        expect(b.civilian).toBe(4);
    });

    it('each balance sums to the player count', () => {
        for (const [count, b] of Object.entries(BALANCE_TABLE)) {
            const total = b.mafia + b.detective + b.doctor + b.civilian;
            expect(total).toBe(Number(count));
        }
    });
});

// ── getBalance ────────────────────────────────────────────────────────────────

describe('getBalance', () => {
    it('returns the correct balance for valid counts', () => {
        for (const count of [5, 6, 7, 8]) {
            const b: RoleBalance | null = getBalance(count);
            expect(b).not.toBeNull();
            expect(b).toEqual(BALANCE_TABLE[count]);
        }
    });

    it('returns null for count < 5', () => {
        expect(getBalance(4)).toBeNull();
        expect(getBalance(0)).toBeNull();
        expect(getBalance(-1)).toBeNull();
    });

    it('returns null for count > 8', () => {
        expect(getBalance(9)).toBeNull();
        expect(getBalance(100)).toBeNull();
    });
});

// ── assignRoles ───────────────────────────────────────────────────────────────

describe('assignRoles', () => {
    it('throws for player counts outside 5–8', () => {
        expect(() => assignRoles(['a', 'b', 'c', 'd'])).toThrow();
        expect(() => assignRoles(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])).toThrow();
    });

    it('throws for 0 players', () => {
        expect(() => assignRoles([])).toThrow();
    });

    it('assigns a role to every player for each valid count', () => {
        for (const count of [5, 6, 7, 8]) {
            const ids = Array.from({ length: count }, (_, i) => `p${i}`);
            const result = assignRoles(ids);
            expect(Object.keys(result)).toHaveLength(count);
            for (const id of ids) {
                expect(result[id]).toBeDefined();
            }
        }
    });

    it('5-player game has exactly 1 mafia', () => {
        const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
        for (let trial = 0; trial < 20; trial++) {
            const result = assignRoles(ids);
            const roles = Object.values(result);
            expect(roles.filter(r => r === 'mafia')).toHaveLength(1);
        }
    });

    it('5-player game has no doctor', () => {
        const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
        for (let trial = 0; trial < 20; trial++) {
            const result = assignRoles(ids);
            const roles = Object.values(result);
            expect(roles.filter(r => r === 'doctor')).toHaveLength(0);
        }
    });

    it('6-player game has exactly 1 doctor', () => {
        const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
        for (let trial = 0; trial < 20; trial++) {
            const result = assignRoles(ids);
            const roles = Object.values(result);
            expect(roles.filter(r => r === 'doctor')).toHaveLength(1);
        }
    });

    it('7-player game has exactly 2 mafia', () => {
        const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
        for (let trial = 0; trial < 20; trial++) {
            const result = assignRoles(ids);
            const roles = Object.values(result);
            expect(roles.filter(r => r === 'mafia')).toHaveLength(2);
        }
    });

    it('8-player game has exactly 4 civilians', () => {
        const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
        for (let trial = 0; trial < 20; trial++) {
            const result = assignRoles(ids);
            const roles = Object.values(result);
            expect(roles.filter(r => r === 'civilian')).toHaveLength(4);
        }
    });

    it('each assigned role is one of the four valid roles', () => {
        const valid: Role[] = ['mafia', 'detective', 'doctor', 'civilian'];
        const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
        const result = assignRoles(ids);
        for (const role of Object.values(result)) {
            expect(valid).toContain(role);
        }
    });

    it('produces different distributions across multiple calls (shuffle works)', () => {
        // Run 50 times; if every assignment were identical the shuffle is broken
        const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
        const firstAssignments = new Set<string>();
        for (let i = 0; i < 50; i++) {
            const result = assignRoles(ids);
            firstAssignments.add(result['p1']);
        }
        // p1 should get multiple different roles across 50 trials
        expect(firstAssignments.size).toBeGreaterThan(1);
    });
});

// ── getRoleEmoji ──────────────────────────────────────────────────────────────

describe('getRoleEmoji', () => {
    it('returns 🔫 for mafia', () => {
        expect(getRoleEmoji('mafia')).toBe('🔫');
    });

    it('returns 🔍 for detective', () => {
        expect(getRoleEmoji('detective')).toBe('🔍');
    });

    it('returns 💊 for doctor', () => {
        expect(getRoleEmoji('doctor')).toBe('💊');
    });

    it('returns 👤 for civilian', () => {
        expect(getRoleEmoji('civilian')).toBe('👤');
    });
});

// ── getRoleDisplayName ────────────────────────────────────────────────────────

describe('getRoleDisplayName', () => {
    it('returns Mafia for mafia', () => {
        expect(getRoleDisplayName('mafia')).toBe('Mafia');
    });

    it('returns Detective for detective', () => {
        expect(getRoleDisplayName('detective')).toBe('Detective');
    });

    it('returns Doctor for doctor', () => {
        expect(getRoleDisplayName('doctor')).toBe('Doctor');
    });

    it('returns Civilian for civilian', () => {
        expect(getRoleDisplayName('civilian')).toBe('Civilian');
    });
});

// ── getRoleCard ───────────────────────────────────────────────────────────────

describe('getRoleCard', () => {
    it('mafia card contains the team names', () => {
        const card = getRoleCard('mafia', ['Alice', 'Bob'], 'playerX');
        const json = JSON.stringify(card.data);
        expect(json).toContain('Alice');
        expect(json).toContain('Bob');
    });

    it('mafia card says "You are Mafia"', () => {
        const card = getRoleCard('mafia', [], 'playerX');
        expect(JSON.stringify(card.data)).toContain('You are Mafia');
    });

    it('mafia card with empty team shows "Just you!"', () => {
        const card = getRoleCard('mafia', [], 'playerX');
        expect(JSON.stringify(card.data)).toContain('Just you!');
    });

    it('detective card says "You are the Detective"', () => {
        const card = getRoleCard('detective', [], 'playerX');
        expect(JSON.stringify(card.data)).toContain('You are the Detective');
    });

    it('detective card mentions /investigate', () => {
        const card = getRoleCard('detective', [], 'playerX');
        expect(JSON.stringify(card.data)).toContain('/investigate');
    });

    it('doctor card says "You are the Doctor"', () => {
        const card = getRoleCard('doctor', [], 'playerX');
        expect(JSON.stringify(card.data)).toContain('You are the Doctor');
    });

    it('doctor card mentions /protect', () => {
        const card = getRoleCard('doctor', [], 'playerX');
        expect(JSON.stringify(card.data)).toContain('/protect');
    });

    it('doctor card mentions self-protect rule', () => {
        const card = getRoleCard('doctor', [], 'playerX');
        expect(JSON.stringify(card.data).toLowerCase()).toContain('self-protect');
    });

    it('civilian card says "You are a Civilian"', () => {
        const card = getRoleCard('civilian', [], 'playerX');
        expect(JSON.stringify(card.data)).toContain('You are a Civilian');
    });

    it('civilian card mentions no night action', () => {
        const card = getRoleCard('civilian', [], 'playerX');
        expect(JSON.stringify(card.data).toLowerCase()).toContain('no night action');
    });
});

// ── buildRoleListText ─────────────────────────────────────────────────────────

describe('buildRoleListText', () => {
    it('returns empty string for invalid player count', () => {
        const game = gameWithNPlayers(4); // invalid
        expect(buildRoleListText(game)).toBe('');
    });

    it('5-player game does NOT include doctor line', () => {
        const game = gameWithNPlayers(5);
        const text = buildRoleListText(game);
        expect(text).not.toContain('Doctor');
    });

    it('5-player game includes mafia and detective lines', () => {
        const game = gameWithNPlayers(5);
        const text = buildRoleListText(game);
        expect(text).toContain('🔫 Mafia');
        expect(text).toContain('🔍 Detective');
    });

    it('6-player game includes doctor line', () => {
        const game = gameWithNPlayers(6);
        const text = buildRoleListText(game);
        expect(text).toContain('💊 Doctor');
    });

    it('7-player game shows Mafia × 2', () => {
        const game = gameWithNPlayers(7);
        const text = buildRoleListText(game);
        expect(text).toContain('🔫 Mafia × 2');
    });

    it('8-player game shows Civilian × 4', () => {
        const game = gameWithNPlayers(8);
        const text = buildRoleListText(game);
        expect(text).toContain('👤 Civilian × 4');
    });

    it('all valid counts produce a non-empty string', () => {
        for (const n of [5, 6, 7, 8]) {
            const game = gameWithNPlayers(n);
            expect(buildRoleListText(game).length).toBeGreaterThan(0);
        }
    });
});
