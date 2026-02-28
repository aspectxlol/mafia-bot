import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    clearTimers,
    createNightState,
    createVoteState,
    deleteGame,
    GameState,
    getAllGames,
    getGame,
    getGameByMafiaChannel,
    getGameByUser,
    getNextGameNumber,
    NightState,
    PlayerState,
    setGame,
    VoteState,
} from '../../src/game/gameState.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makePlayer(id: string, overrides: Partial<PlayerState> = {}): PlayerState {
    return {
        id,
        name: `Player${id}`,
        role: 'civilian',
        alive: true,
        protectedLastNight: false,
        lastProtectedId: null,
        isAI: false,
        selfProtectUsed: false,
        ...overrides,
    };
}

function makeGame(channelId: string, overrides: Partial<GameState> = {}): GameState {
    return {
        phase: 'lobby',
        gameNumber: 1,
        hostId: 'host1',
        guildId: 'guild1',
        players: {},
        readyPlayers: new Set(),
        night: createNightState(),
        vote: createVoteState(),
        mafiaChannelId: null,
        gameChannelId: channelId,
        round: 0,
        phaseTimer: null,
        reminderTimer: null,
        readyTimerFired: false,
        readyMessageId: null,
        tallyMessageId: null,
        lastNightDeath: null,
        lastNightSaved: false,
        gameLog: [],
        ...overrides,
    };
}

// ── cleanup ───────────────────────────────────────────────────────────────────

const TEST_CHANNEL_IDS = ['ch1', 'ch2', 'ch3', 'ch4', 'testChannel', 'gameA', 'gameB', 'mafia-ch'];

afterEach(() => {
    TEST_CHANNEL_IDS.forEach(id => deleteGame(id));
});

// ── getNextGameNumber ─────────────────────────────────────────────────────────

describe('getNextGameNumber', () => {
    it('returns a positive integer', () => {
        const n = getNextGameNumber();
        expect(n).toBeGreaterThan(0);
    });

    it('increments with each call', () => {
        const a = getNextGameNumber();
        const b = getNextGameNumber();
        expect(b).toBe(a + 1);
    });

    it('always returns a unique number across consecutive calls', () => {
        const numbers = Array.from({ length: 10 }, () => getNextGameNumber());
        const unique = new Set(numbers);
        expect(unique.size).toBe(10);
    });
});

// ── setGame / getGame ─────────────────────────────────────────────────────────

describe('setGame / getGame', () => {
    it('returns undefined for an unknown channel', () => {
        expect(getGame('ch1')).toBeUndefined();
    });

    it('returns the game after it is set', () => {
        const g = makeGame('ch1');
        setGame('ch1', g);
        expect(getGame('ch1')).toBe(g);
    });

    it('overwrites the previous game for the same channel', () => {
        const g1 = makeGame('ch1', { gameNumber: 1 });
        const g2 = makeGame('ch1', { gameNumber: 2 });
        setGame('ch1', g1);
        setGame('ch1', g2);
        expect(getGame('ch1')?.gameNumber).toBe(2);
    });

    it('stores multiple games independently', () => {
        const g1 = makeGame('ch1');
        const g2 = makeGame('ch2');
        setGame('ch1', g1);
        setGame('ch2', g2);
        expect(getGame('ch1')).toBe(g1);
        expect(getGame('ch2')).toBe(g2);
    });
});

// ── deleteGame ────────────────────────────────────────────────────────────────

describe('deleteGame', () => {
    it('removes a stored game', () => {
        setGame('ch1', makeGame('ch1'));
        deleteGame('ch1');
        expect(getGame('ch1')).toBeUndefined();
    });

    it('does not throw when deleting a non-existent game', () => {
        expect(() => deleteGame('ch1')).not.toThrow();
    });

    it('only removes the targeted game', () => {
        setGame('ch1', makeGame('ch1'));
        setGame('ch2', makeGame('ch2'));
        deleteGame('ch1');
        expect(getGame('ch1')).toBeUndefined();
        expect(getGame('ch2')).toBeDefined();
    });
});

// ── getAllGames ───────────────────────────────────────────────────────────────

describe('getAllGames', () => {
    it('returns an empty array when no games exist (after cleanup)', () => {
        // Assumes no games were left over — afterEach handles TEST_CHANNEL_IDS
        const known = getAllGames().filter(g => TEST_CHANNEL_IDS.includes(g.gameChannelId));
        expect(known).toHaveLength(0);
    });

    it('includes all added games', () => {
        setGame('gameA', makeGame('gameA'));
        setGame('gameB', makeGame('gameB'));
        const all = getAllGames();
        const ids = all.map(g => g.gameChannelId);
        expect(ids).toContain('gameA');
        expect(ids).toContain('gameB');
    });

    it('returns a snapshot array (not the internal map)', () => {
        setGame('gameA', makeGame('gameA'));
        const before = getAllGames().length;
        setGame('gameB', makeGame('gameB'));
        const after = getAllGames().length;
        expect(after).toBe(before + 1);
    });
});

// ── getGameByMafiaChannel ─────────────────────────────────────────────────────

describe('getGameByMafiaChannel', () => {
    it('returns undefined when no game has a matching mafia channel', () => {
        setGame('ch1', makeGame('ch1', { mafiaChannelId: 'other' }));
        expect(getGameByMafiaChannel('mafia-ch')).toBeUndefined();
    });

    it('returns the game with the matching mafiaChannelId', () => {
        const g = makeGame('ch1', { mafiaChannelId: 'mafia-ch' });
        setGame('ch1', g);
        expect(getGameByMafiaChannel('mafia-ch')).toBe(g);
    });

    it('returns undefined for a game with null mafiaChannelId', () => {
        setGame('ch1', makeGame('ch1', { mafiaChannelId: null }));
        expect(getGameByMafiaChannel('mafia-ch')).toBeUndefined();
    });

    it('returns the correct game when many games exist', () => {
        setGame('ch1', makeGame('ch1', { mafiaChannelId: 'mafia-ch' }));
        setGame('ch2', makeGame('ch2', { mafiaChannelId: 'other-mafia' }));
        const result = getGameByMafiaChannel('other-mafia');
        expect(result?.gameChannelId).toBe('ch2');
    });
});

// ── getGameByUser ─────────────────────────────────────────────────────────────

describe('getGameByUser', () => {
    it('returns undefined when user is in no game', () => {
        expect(getGameByUser('user99')).toBeUndefined();
    });

    it('returns the game that contains the user', () => {
        const g = makeGame('ch1', {
            players: { user1: makePlayer('user1') },
        });
        setGame('ch1', g);
        expect(getGameByUser('user1')).toBe(g);
    });

    it('ignores games in "ended" phase', () => {
        const g = makeGame('ch1', {
            phase: 'ended',
            players: { user1: makePlayer('user1') },
        });
        setGame('ch1', g);
        expect(getGameByUser('user1')).toBeUndefined();
    });

    it('returns non-ended game over ended game for the same user', () => {
        const ended = makeGame('ch1', {
            phase: 'ended',
            players: { user1: makePlayer('user1') },
        });
        const active = makeGame('ch2', {
            phase: 'night',
            players: { user1: makePlayer('user1') },
        });
        setGame('ch1', ended);
        setGame('ch2', active);
        expect(getGameByUser('user1')).toBe(active);
    });

    it('finds user in a night-phase game', () => {
        const g = makeGame('ch1', {
            phase: 'night',
            players: { userA: makePlayer('userA'), userB: makePlayer('userB') },
        });
        setGame('ch1', g);
        expect(getGameByUser('userA')).toBe(g);
        expect(getGameByUser('userB')).toBe(g);
    });

    it('returns undefined for a user not in the players record', () => {
        const g = makeGame('ch1', {
            players: { user1: makePlayer('user1') },
        });
        setGame('ch1', g);
        expect(getGameByUser('user2')).toBeUndefined();
    });
});

// ── createNightState ──────────────────────────────────────────────────────────

describe('createNightState', () => {
    it('returns null for all targets', () => {
        const n: NightState = createNightState();
        expect(n.killTarget).toBeNull();
        expect(n.protectTarget).toBeNull();
        expect(n.investigateTarget).toBeNull();
    });

    it('returns an empty actionsReceived array', () => {
        const n = createNightState();
        expect(n.actionsReceived).toEqual([]);
    });

    it('returns a new object each time', () => {
        const a = createNightState();
        const b = createNightState();
        expect(a).not.toBe(b);
        a.actionsReceived.push('kill');
        expect(b.actionsReceived).toHaveLength(0);
    });
});

// ── createVoteState ───────────────────────────────────────────────────────────

describe('createVoteState', () => {
    it('returns empty votes and tally records', () => {
        const v: VoteState = createVoteState();
        expect(v.votes).toEqual({});
        expect(v.tally).toEqual({});
    });

    it('returns a new object each time', () => {
        const a = createVoteState();
        const b = createVoteState();
        expect(a).not.toBe(b);
        a.votes['x'] = 'y';
        expect(b.votes).toEqual({});
    });
});

// ── clearTimers ───────────────────────────────────────────────────────────────

describe('clearTimers', () => {
    it('clears phaseTimer and sets it to null', () => {
        const phaseTimer = setTimeout(() => {}, 99999);
        const g = makeGame('ch1', { phaseTimer });
        clearTimers(g);
        expect(g.phaseTimer).toBeNull();
    });

    it('clears reminderTimer and sets it to null', () => {
        const reminderTimer = setTimeout(() => {}, 99999);
        const g = makeGame('ch1', { reminderTimer });
        clearTimers(g);
        expect(g.reminderTimer).toBeNull();
    });

    it('handles a game with no timers without throwing', () => {
        const g = makeGame('ch1');
        expect(() => clearTimers(g)).not.toThrow();
        expect(g.phaseTimer).toBeNull();
        expect(g.reminderTimer).toBeNull();
    });

    it('calls clearTimeout with the timer handle', () => {
        const spy = vi.spyOn(globalThis, 'clearTimeout');
        const phaseTimer = setTimeout(() => {}, 99999);
        const reminderTimer = setTimeout(() => {}, 99999);
        const g = makeGame('ch1', { phaseTimer, reminderTimer });
        clearTimers(g);
        expect(spy).toHaveBeenCalledWith(phaseTimer);
        expect(spy).toHaveBeenCalledWith(reminderTimer);
        spy.mockRestore();
    });

    it('does not call clearTimeout when timers are already null', () => {
        const spy = vi.spyOn(globalThis, 'clearTimeout');
        const g = makeGame('ch1', { phaseTimer: null, reminderTimer: null });
        clearTimers(g);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});
