import { describe, expect, it } from 'vitest';

import {
    createNightState,
    createVoteState,
    GameState,
    PlayerState,
} from '../../src/game/gameState.js';
import { checkWin, WinResult } from '../../src/game/winCheck.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makePlayer(id: string, role: PlayerState['role'], alive = true): PlayerState {
    return {
        id,
        name: `Player${id}`,
        role,
        alive,
        isAI: false,
        protectedLastNight: false,
        lastProtectedId: null,
        selfProtectUsed: false,
    };
}

function makeGame(players: Record<string, PlayerState>): GameState {
    return {
        phase: 'day',
        gameNumber: 1,
        hostId: 'host',
        guildId: 'guild1',
        players,
        readyPlayers: new Set(),
        night: createNightState(),
        vote: createVoteState(),
        mafiaChannelId: null,
        gameChannelId: 'ch1',
        round: 1,
        phaseTimer: null,
        reminderTimer: null,
        readyTimerFired: false,
        readyMessageId: null,
        tallyMessageId: null,
        lastNightDeath: null,
        lastNightSaved: false,
        gameLog: [],
        playerLogs: {},
        aiTimers: [],
    };
}

// ── town win ──────────────────────────────────────────────────────────────────

describe('checkWin – town victory', () => {
    it('returns "town" when the last mafia is eliminated', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', false),
            d1: makePlayer('d1', 'detective', true),
            c1: makePlayer('c1', 'civilian', true),
        });
        expect(checkWin(game)).toBe<WinResult>('town');
    });

    it('returns "town" when all mafia are dead and many town remain', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', false),
            m2: makePlayer('m2', 'mafia', false),
            c1: makePlayer('c1', 'civilian', true),
            c2: makePlayer('c2', 'civilian', true),
            c3: makePlayer('c3', 'civilian', true),
        });
        expect(checkWin(game)).toBe<WinResult>('town');
    });

    it('returns "town" when all players are dead except no mafia', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', false),
            c1: makePlayer('c1', 'civilian', false),
        });
        // 0 alive mafia → town wins regardless of 0 town alive
        expect(checkWin(game)).toBe<WinResult>('town');
    });

    it('returns "town" with a detective alive and no mafia', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', false),
            det: makePlayer('det', 'detective', true),
            doc: makePlayer('doc', 'doctor', true),
        });
        expect(checkWin(game)).toBe<WinResult>('town');
    });
});

// ── mafia win ─────────────────────────────────────────────────────────────────

describe('checkWin – mafia victory', () => {
    it('returns "mafia" when mafia count equals town count (1 vs 1)', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', true),
            c1: makePlayer('c1', 'civilian', true),
        });
        expect(checkWin(game)).toBe<WinResult>('mafia');
    });

    it('returns "mafia" when mafia count exceeds town count (2 vs 1)', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', true),
            m2: makePlayer('m2', 'mafia', true),
            c1: makePlayer('c1', 'civilian', true),
        });
        expect(checkWin(game)).toBe<WinResult>('mafia');
    });

    it('returns "mafia" when all town are dead and mafia alive', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', true),
            c1: makePlayer('c1', 'civilian', false),
            c2: makePlayer('c2', 'civilian', false),
        });
        expect(checkWin(game)).toBe<WinResult>('mafia');
    });

    it('returns "mafia" when mafia equal alive town with dead players present', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', true),
            c1: makePlayer('c1', 'civilian', true),
            c2: makePlayer('c2', 'civilian', false), // dead
        });
        expect(checkWin(game)).toBe<WinResult>('mafia');
    });

    it('returns "mafia" with detective alive but mafia outnumbers (2 vs 1 detective)', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', true),
            m2: makePlayer('m2', 'mafia', true),
            det: makePlayer('det', 'detective', true),
        });
        expect(checkWin(game)).toBe<WinResult>('mafia');
    });
});

// ── game continues (null) ─────────────────────────────────────────────────────

describe('checkWin – game continues', () => {
    it('returns null when mafia < town (1 mafia vs 2 town)', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', true),
            c1: makePlayer('c1', 'civilian', true),
            c2: makePlayer('c2', 'civilian', true),
        });
        expect(checkWin(game)).toBeNull();
    });

    it('returns null at game start (1m 1d 1doc 2civ)', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', true),
            det: makePlayer('det', 'detective', true),
            doc: makePlayer('doc', 'doctor', true),
            c1: makePlayer('c1', 'civilian', true),
            c2: makePlayer('c2', 'civilian', true),
        });
        expect(checkWin(game)).toBeNull();
    });

    it('returns null for a 7-player starting state', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', true),
            m2: makePlayer('m2', 'mafia', true),
            det: makePlayer('det', 'detective', true),
            doc: makePlayer('doc', 'doctor', true),
            c1: makePlayer('c1', 'civilian', true),
            c2: makePlayer('c2', 'civilian', true),
            c3: makePlayer('c3', 'civilian', true),
        });
        expect(checkWin(game)).toBeNull();
    });

    it('returns null with some dead town but mafia still outnumbered', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', true),
            c1: makePlayer('c1', 'civilian', false),
            c2: makePlayer('c2', 'civilian', true),
            c3: makePlayer('c3', 'civilian', true),
        });
        // 1 mafia alive, 2 town alive → null
        expect(checkWin(game)).toBeNull();
    });

    it('returns null even with doctors and detectives as long as mafia < town', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', true),
            det: makePlayer('det', 'detective', true),
            doc: makePlayer('doc', 'doctor', true),
            c1: makePlayer('c1', 'civilian', true),
        });
        // 1 mafia vs 3 town → null
        expect(checkWin(game)).toBeNull();
    });
});

// ── edge cases ────────────────────────────────────────────────────────────────

describe('checkWin – edge cases', () => {
    it('returns "town" for a game with no players', () => {
        // 0 mafia alive → town wins per implementation
        const game = makeGame({});
        expect(checkWin(game)).toBe<WinResult>('town');
    });

    it('dead players do not count toward either side', () => {
        // 1 alive mafia, 1 dead mafia, 1 alive civilian, 1 dead civilian
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', true),
            m2: makePlayer('m2', 'mafia', false),
            c1: makePlayer('c1', 'civilian', true),
            c2: makePlayer('c2', 'civilian', false),
        });
        // alive: 1 mafia vs 1 civilian → mafia wins
        expect(checkWin(game)).toBe<WinResult>('mafia');
    });

    it('doctor counts as town for win-condition purposes', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', true),
            doc: makePlayer('doc', 'doctor', true),
        });
        // 1 mafia, 1 town (doctor) → mafia wins
        expect(checkWin(game)).toBe<WinResult>('mafia');
    });

    it('detective counts as town for win-condition purposes', () => {
        const game = makeGame({
            m1: makePlayer('m1', 'mafia', true),
            det: makePlayer('det', 'detective', true),
            c1: makePlayer('c1', 'civilian', true),
        });
        // 1 mafia vs 2 town → null (game continues)
        expect(checkWin(game)).toBeNull();
    });
});
