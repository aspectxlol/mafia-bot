import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Module mocks (must be hoisted before imports) ────────────────────────────

vi.mock('../../src/services/index.js', () => ({
    Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../../config/config.json', () => ({ default: { geminiApiKey: 'test-key' } }));
vi.mock('../../config/debug.json', () => ({}));
vi.mock('../../lang/logs.json', () => ({}));

// Mock GoogleGenerativeAI so no real HTTP calls are made
const mockGenerateContent = vi.fn();
vi.mock('@google/generative-ai', () => ({
    GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
        getGenerativeModel: vi.fn().mockReturnValue({
            generateContent: mockGenerateContent,
        }),
    })),
}));

import {
    AI_NAMES,
    generateDayMessage,
    isAIId,
    logEvent,
    newAIId,
    pickVoteTarget,
    runAINightAction,
} from '../../src/game/aiPlayer.js';
import {
    createNightState,
    createVoteState,
    GameState,
    PlayerState,
} from '../../src/game/gameState.js';
import { Logger } from '../../src/services/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePlayer(id: string, overrides: Partial<PlayerState> = {}): PlayerState {
    return {
        id,
        name: `Player_${id}`,
        role: 'civilian',
        alive: true,
        isAI: false,
        protectedLastNight: false,
        lastProtectedId: null,
        selfProtectUsed: false,
        ...overrides,
    };
}

function makeGame(overrides: Partial<GameState> = {}): GameState {
    return {
        phase: 'night',
        gameNumber: 1,
        hostId: 'host',
        guildId: 'guild1',
        players: {
            m1: makePlayer('m1', { name: 'Alice', role: 'mafia' }),
            d1: makePlayer('d1', { name: 'Bob', role: 'detective' }),
            doc1: makePlayer('doc1', { name: 'Carol', role: 'doctor' }),
            c1: makePlayer('c1', { name: 'Dave', role: 'civilian' }),
            c2: makePlayer('c2', { name: 'Eve', role: 'civilian' }),
        },
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
        ...overrides,
    };
}

/** Make Gemini respond with a specific string. */
function mockGeminiResponse(text: string) {
    mockGenerateContent.mockResolvedValueOnce({
        response: { text: () => text },
    });
}

/** Make Gemini throw an error. */
function mockGeminiError(msg = 'API error') {
    mockGenerateContent.mockRejectedValueOnce(new Error(msg));
}

afterEach(() => {
    vi.clearAllMocks();
});

// ─── AI_NAMES ─────────────────────────────────────────────────────────────────

describe('AI_NAMES', () => {
    it('contains at least 10 names', () => {
        expect(AI_NAMES.length).toBeGreaterThanOrEqual(10);
    });

    it('contains only non-empty strings', () => {
        for (const name of AI_NAMES) {
            expect(typeof name).toBe('string');
            expect(name.trim().length).toBeGreaterThan(0);
        }
    });

    it('has no duplicate names', () => {
        const unique = new Set(AI_NAMES);
        expect(unique.size).toBe(AI_NAMES.length);
    });
});

// ─── newAIId ──────────────────────────────────────────────────────────────────

describe('newAIId', () => {
    it('returns a string starting with "ai:"', () => {
        expect(newAIId(1, 1)).toBe('ai:1:1');
    });

    it('encodes gameNumber and index', () => {
        expect(newAIId(42, 7)).toBe('ai:42:7');
    });

    it('different inputs produce different IDs', () => {
        expect(newAIId(1, 1)).not.toBe(newAIId(1, 2));
        expect(newAIId(1, 1)).not.toBe(newAIId(2, 1));
    });
});

// ─── isAIId ───────────────────────────────────────────────────────────────────

describe('isAIId', () => {
    it('returns true for IDs produced by newAIId', () => {
        expect(isAIId(newAIId(1, 1))).toBe(true);
        expect(isAIId(newAIId(99, 3))).toBe(true);
    });

    it('returns false for real Discord user IDs', () => {
        expect(isAIId('123456789012345678')).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(isAIId('')).toBe(false);
    });

    it('returns false for strings that only partially match', () => {
        expect(isAIId('notai:1:1')).toBe(false);
        expect(isAIId('xai:1:1')).toBe(false);
    });
});

// ─── logEvent ─────────────────────────────────────────────────────────────────

describe('logEvent', () => {
    it('appends an event to gameLog', () => {
        const game = makeGame();
        logEvent(game, 'test event');
        expect(game.gameLog).toContain('test event');
    });

    it('appends multiple events in order', () => {
        const game = makeGame();
        logEvent(game, 'first');
        logEvent(game, 'second');
        logEvent(game, 'third');
        expect(game.gameLog).toEqual(['first', 'second', 'third']);
    });

    it('caps the log at 30 entries, dropping oldest', () => {
        const game = makeGame();
        for (let i = 1; i <= 35; i++) {
            logEvent(game, `event ${i}`);
        }
        expect(game.gameLog.length).toBe(30);
        expect(game.gameLog[0]).toBe('event 6');
        expect(game.gameLog[29]).toBe('event 35');
    });

    it('does not exceed 30 after many inserts', () => {
        const game = makeGame();
        for (let i = 0; i < 100; i++) logEvent(game, `e${i}`);
        expect(game.gameLog.length).toBe(30);
    });
});

// ─── runAINightAction — mafia ─────────────────────────────────────────────────

describe('runAINightAction – mafia', () => {
    it('sets killTarget to a non-mafia player', async () => {
        const game = makeGame();
        const mafia = game.players['m1'];
        mockGeminiResponse('Dave'); // picks civilian c1

        await runAINightAction(game, mafia);

        expect(game.night.killTarget).not.toBeNull();
        expect(game.players[game.night.killTarget!]?.role).not.toBe('mafia');
    });

    it('adds "kill" to actionsReceived', async () => {
        const game = makeGame();
        mockGeminiResponse('Dave');
        await runAINightAction(game, game.players['m1']);
        expect(game.night.actionsReceived).toContain('kill');
    });

    it('does not act a second time if kill already registered', async () => {
        const game = makeGame();
        game.night.actionsReceived.push('kill');
        game.night.killTarget = 'c1';

        await runAINightAction(game, game.players['m1']);

        // generateContent should NOT be called because action already taken
        expect(mockGenerateContent).not.toHaveBeenCalled();
        expect(game.night.killTarget).toBe('c1'); // unchanged
    });

    it('logs a game event after acting', async () => {
        const game = makeGame();
        mockGeminiResponse('Eve');
        await runAINightAction(game, game.players['m1']);
        expect(
            game.gameLog.some(e => e.includes('Night') && e.toLowerCase().includes('mafia'))
        ).toBe(true);
    });

    it('falls back to a random target when Gemini returns a nonsense name', async () => {
        const game = makeGame();
        mockGeminiResponse('zzznobody_xyz');
        await runAINightAction(game, game.players['m1']);
        // Should still pick someone (random fallback)
        expect(game.night.killTarget).not.toBeNull();
        expect(game.players[game.night.killTarget!]?.role).not.toBe('mafia');
    });

    it('does nothing if there are no valid targets', async () => {
        // All non-mafia players are dead
        const game = makeGame({
            players: {
                m1: makePlayer('m1', { name: 'Alice', role: 'mafia' }),
                c1: makePlayer('c1', { name: 'Dave', role: 'civilian', alive: false }),
            },
        });
        await runAINightAction(game, game.players['m1']);
        expect(game.night.killTarget).toBeNull();
        expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('does not target fellow mafia members', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', { name: 'Alice', role: 'mafia' }),
                m2: makePlayer('m2', { name: 'Frank', role: 'mafia' }),
                c1: makePlayer('c1', { name: 'Dave', role: 'civilian' }),
            },
        });
        // Force Gemini to "choose" mafia teammate
        mockGeminiResponse('Frank');
        await runAINightAction(game, game.players['m1']);
        // Should fall back to the only valid target (c1)
        expect(game.night.killTarget).toBe('c1');
    });
});

// ─── runAINightAction — detective ─────────────────────────────────────────────

describe('runAINightAction – detective', () => {
    it('sets investigateTarget to some alive player', async () => {
        const game = makeGame();
        mockGeminiResponse('Alice');
        await runAINightAction(game, game.players['d1']);
        expect(game.night.investigateTarget).not.toBeNull();
    });

    it('adds "investigate" to actionsReceived', async () => {
        const game = makeGame();
        mockGeminiResponse('Alice');
        await runAINightAction(game, game.players['d1']);
        expect(game.night.actionsReceived).toContain('investigate');
    });

    it('does not investigate a second time if already registered', async () => {
        const game = makeGame();
        game.night.actionsReceived.push('investigate');
        game.night.investigateTarget = 'c1';

        await runAINightAction(game, game.players['d1']);

        expect(mockGenerateContent).not.toHaveBeenCalled();
        expect(game.night.investigateTarget).toBe('c1');
    });

    it('logs the investigation result (found Mafia)', async () => {
        const game = makeGame();
        mockGeminiResponse('Alice'); // Alice is mafia
        await runAINightAction(game, game.players['d1']);
        expect(game.gameLog.some(e => e.includes('MAFIA'))).toBe(true);
    });

    it('logs the investigation result (innocent)', async () => {
        const game = makeGame();
        mockGeminiResponse('Dave'); // Dave is civilian
        await runAINightAction(game, game.players['d1']);
        expect(game.gameLog.some(e => e.includes('not Mafia'))).toBe(true);
    });

    it('does not investigate self', async () => {
        const game = makeGame();
        // Even if Gemini asks to investigate self, "d1" is not in candidates
        // The investigate candidates filter out self; if Gemini returns Bob (d1's name),
        // pickFromList will exclude self and fall back to first valid match or random
        // We just verify it completes without error and sets a target
        mockGeminiResponse('Bob');
        await runAINightAction(game, game.players['d1']);
        expect(game.night.investigateTarget).not.toBe('d1');
    });
});

// ─── runAINightAction — doctor ────────────────────────────────────────────────

describe('runAINightAction – doctor', () => {
    it('sets protectTarget to some alive player', async () => {
        const game = makeGame();
        mockGeminiResponse('Dave');
        await runAINightAction(game, game.players['doc1']);
        expect(game.night.protectTarget).not.toBeNull();
    });

    it('adds "protect" to actionsReceived', async () => {
        const game = makeGame();
        mockGeminiResponse('Dave');
        await runAINightAction(game, game.players['doc1']);
        expect(game.night.actionsReceived).toContain('protect');
    });

    it('does not protect a second time if already registered', async () => {
        const game = makeGame();
        game.night.actionsReceived.push('protect');
        game.night.protectTarget = 'c1';

        await runAINightAction(game, game.players['doc1']);

        expect(mockGenerateContent).not.toHaveBeenCalled();
        expect(game.night.protectTarget).toBe('c1');
    });

    it('cannot protect the same player two rounds in a row', async () => {
        const game = makeGame({ round: 2 });
        // Set lastProtectedId to 'c1' (doctor protected c1 last round)
        game.players['doc1'].lastProtectedId = 'c1';

        mockGeminiResponse('Dave'); // valid — c1 filtered out
        await runAINightAction(game, game.players['doc1']);

        expect(game.night.protectTarget).not.toBe('c1');
    });

    it('marks selfProtectUsed when doctor self-protects', async () => {
        const game = makeGame();
        // Guard: self-protect allowed on round 1
        mockGeminiResponse('Carol'); // Carol is doc1
        await runAINightAction(game, game.players['doc1']);

        if (game.night.protectTarget === 'doc1') {
            expect(game.players['doc1'].selfProtectUsed).toBe(true);
        }
    });

    it('cannot self-protect if selfProtectUsed is true', async () => {
        const game = makeGame();
        game.players['doc1'].selfProtectUsed = true;
        // Only valid targets now are non-self players
        mockGeminiResponse('Carol'); // Carol = doc1 = filtered out, fallback to others
        await runAINightAction(game, game.players['doc1']);
        expect(game.night.protectTarget).not.toBe('doc1');
    });

    it('logs a protect event', async () => {
        const game = makeGame();
        mockGeminiResponse('Dave');
        await runAINightAction(game, game.players['doc1']);
        expect(game.gameLog.some(e => e.toLowerCase().includes('doctor'))).toBe(true);
    });

    it('does nothing if there are no valid targets', async () => {
        const game = makeGame({
            players: {
                doc1: makePlayer('doc1', { name: 'Carol', role: 'doctor', selfProtectUsed: true }),
            },
        });
        game.players['doc1'].lastProtectedId = 'doc1'; // last protected = self (already used)
        // No targets available
        await runAINightAction(game, game.players['doc1']);
        expect(game.night.protectTarget).toBeNull();
        expect(mockGenerateContent).not.toHaveBeenCalled();
    });
});

// ─── runAINightAction — civilian ──────────────────────────────────────────────

describe('runAINightAction – civilian', () => {
    it('does nothing for civilian role', async () => {
        const game = makeGame();
        await runAINightAction(game, game.players['c1']);
        expect(game.night.killTarget).toBeNull();
        expect(game.night.investigateTarget).toBeNull();
        expect(game.night.protectTarget).toBeNull();
        expect(mockGenerateContent).not.toHaveBeenCalled();
    });
});

// ─── runAINightAction — Gemini errors ─────────────────────────────────────────

describe('runAINightAction – Gemini errors', () => {
    it('falls back to random target when Gemini API throws', async () => {
        const game = makeGame();
        mockGeminiError('network timeout');
        // Despite the error, mafia should still get a kill target via random fallback
        await runAINightAction(game, game.players['m1']);
        // actionsReceived may or may not be updated depending on fallback path;
        // the key thing is no unhandled exception
        expect(game.night.killTarget).not.toBeNull();
    });
});

// ─── Retry / rate-limit logic ────────────────────────────────────────────────

/** Build a fake 429 error matching the Google SDK's shape. */
function make429(retryDelay = '10s') {
    return Object.assign(new Error('rate limited'), {
        status: 429,
        statusText: 'Too Many Requests',
        errorDetails: [
            {
                '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                retryDelay,
            },
        ],
    });
}

describe('retry logic (rate-limit)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('retries after a 429 and returns the eventual response', async () => {
        const game = makeGame();
        mockGenerateContent
            .mockRejectedValueOnce(make429('5s'))
            .mockResolvedValueOnce({ response: { text: () => 'Dave' } });

        const promise = runAINightAction(game, game.players['m1']);
        await vi.runAllTimersAsync();
        await promise;

        expect(game.night.killTarget).not.toBeNull();
        expect(game.night.actionsReceived).toContain('kill');
        expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it('logs a warn (not error) on 429 retry', async () => {
        const game = makeGame();
        mockGenerateContent
            .mockRejectedValueOnce(make429('5s'))
            .mockResolvedValueOnce({ response: { text: () => 'Dave' } });

        const promise = runAINightAction(game, game.players['m1']);
        await vi.runAllTimersAsync();
        await promise;

        expect(vi.mocked(Logger.warn)).toHaveBeenCalledWith(
            expect.stringContaining('rate-limited'),
            expect.anything()
        );
        expect(vi.mocked(Logger.error)).not.toHaveBeenCalled();
    });

    it('waits the retry delay from errorDetails', async () => {
        const game = makeGame();
        const advanceSpy = vi.spyOn(global, 'setTimeout');
        mockGenerateContent
            .mockRejectedValueOnce(make429('30s'))
            .mockResolvedValueOnce({ response: { text: () => 'Dave' } });

        const promise = runAINightAction(game, game.players['m1']);
        await vi.runAllTimersAsync();
        await promise;

        // At least one setTimeout call should have delay >= 30_000 ms
        const delays = advanceSpy.mock.calls.map(c => c[1] as number);
        expect(delays.some(d => d >= 30_000)).toBe(true);
    });

    it('parses retryDelay from the error message as fallback', async () => {
        const game = makeGame();
        // Error with no errorDetails but message contains retry hint
        const err = Object.assign(new Error('Please retry in 20s.'), { status: 429 });
        mockGenerateContent
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce({ response: { text: () => 'Dave' } });

        const advanceSpy = vi.spyOn(global, 'setTimeout');
        const promise = runAINightAction(game, game.players['m1']);
        await vi.runAllTimersAsync();
        await promise;

        const delays = advanceSpy.mock.calls.map(c => c[1] as number);
        expect(delays.some(d => d >= 20_000)).toBe(true);
    });

    it('exhausts all retries and falls back to empty / random', async () => {
        const game = makeGame();
        mockGenerateContent
            .mockRejectedValueOnce(make429('1s'))
            .mockRejectedValueOnce(make429('1s'))
            .mockRejectedValueOnce(make429('1s'));

        const promise = runAINightAction(game, game.players['m1']);
        await vi.runAllTimersAsync();
        await promise;

        // After 3 failures, ask() returns '' and pickFromList falls back to random
        expect(game.night.killTarget).not.toBeNull();
        expect(mockGenerateContent).toHaveBeenCalledTimes(3);
        // Final failure should be logged as error
        expect(vi.mocked(Logger.error)).toHaveBeenCalled();
    });

    it('does not retry on non-429 errors', async () => {
        const game = makeGame();
        const err = Object.assign(new Error('Internal server error'), { status: 500 });
        mockGenerateContent.mockRejectedValueOnce(err);

        const promise = runAINightAction(game, game.players['m1']);
        await vi.runAllTimersAsync();
        await promise;

        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        expect(vi.mocked(Logger.error)).toHaveBeenCalled();
    });

    it('generateDayMessage retries on 429 and returns the eventual text', async () => {
        const game = makeGame();
        mockGenerateContent
            .mockRejectedValueOnce(make429('2s'))
            .mockResolvedValueOnce({ response: { text: () => 'I suspect Alice.' } });

        const promise = generateDayMessage(game, game.players['c1']);
        await vi.runAllTimersAsync();
        const msg = await promise;

        expect(msg).toBe('I suspect Alice.');
        expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it('pickVoteTarget retries on 429 and returns a valid target', async () => {
        const game = makeGame();
        mockGenerateContent
            .mockRejectedValueOnce(make429('2s'))
            .mockResolvedValueOnce({ response: { text: () => 'Alice' } });

        const promise = pickVoteTarget(game, game.players['c1']);
        await vi.runAllTimersAsync();
        const targetId = await promise;

        expect(targetId).toBe('m1'); // Alice = m1
        expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });
});

// ─── generateDayMessage ───────────────────────────────────────────────────────

describe('generateDayMessage', () => {
    it('returns the Gemini response text', async () => {
        const game = makeGame();
        mockGeminiResponse('I think Alice is suspicious.');
        const msg = await generateDayMessage(game, game.players['c1']);
        expect(msg).toBe('I think Alice is suspicious.');
    });

    it('returns default message when Gemini returns empty string', async () => {
        const game = makeGame();
        mockGeminiResponse('');
        const msg = await generateDayMessage(game, game.players['c1']);
        expect(msg).toBe('Not sure who to trust right now...');
    });

    it('returns default message when Gemini throws', async () => {
        const game = makeGame();
        mockGeminiError('quota exceeded');
        const msg = await generateDayMessage(game, game.players['c1']);
        expect(msg).toBe('Not sure who to trust right now...');
    });

    it('returns a non-empty string for any role', async () => {
        const game = makeGame();
        for (const player of Object.values(game.players)) {
            mockGeminiResponse('Something to say.');
            const msg = await generateDayMessage(game, player);
            expect(typeof msg).toBe('string');
            expect(msg.length).toBeGreaterThan(0);
        }
    });

    it('includes game context — calls Gemini exactly once per invocation', async () => {
        const game = makeGame({ gameLog: ['[Night 1] Mafia targeted someone'] });
        mockGeminiResponse('Hm, I wonder who did it.');
        await generateDayMessage(game, game.players['c1']);
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        const promptArg: string = mockGenerateContent.mock.calls[0][0] as string;
        expect(promptArg).toContain('RECENT EVENTS');
    });
});

// ─── pickVoteTarget ───────────────────────────────────────────────────────────

describe('pickVoteTarget', () => {
    it('returns an ID of an alive non-self player', async () => {
        const game = makeGame();
        mockGeminiResponse('Alice'); // Alice = m1
        const targetId = await pickVoteTarget(game, game.players['c1']);
        expect(targetId).not.toBeNull();
        expect(targetId).not.toBe('c1');
        expect(game.players[targetId!]).toBeDefined();
        expect(game.players[targetId!].alive).toBe(true);
    });

    it('resolves by player name match', async () => {
        const game = makeGame();
        mockGeminiResponse('Bob'); // Bob = d1
        const targetId = await pickVoteTarget(game, game.players['c1']);
        expect(targetId).toBe('d1');
    });

    it('falls back to random when name is unrecognised', async () => {
        const game = makeGame();
        mockGeminiResponse('zzznope_xyz');
        const targetId = await pickVoteTarget(game, game.players['c1']);
        expect(targetId).not.toBeNull();
        expect(targetId).not.toBe('c1');
    });

    it('returns null when no other alive players exist', async () => {
        const game = makeGame({
            players: {
                c1: makePlayer('c1', { name: 'Dave', role: 'civilian' }),
            },
        });
        const targetId = await pickVoteTarget(game, game.players['c1']);
        expect(targetId).toBeNull();
        expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('does not vote for dead players', async () => {
        const game = makeGame();
        game.players['m1'].alive = false;
        game.players['d1'].alive = false;

        mockGeminiResponse('Alice'); // Alice is dead — should fall back
        const targetId = await pickVoteTarget(game, game.players['c1']);
        // Result must be one of the still-alive, non-self players
        expect(targetId).not.toBeNull();
        expect(game.players[targetId!].alive).toBe(true);
    });

    it('returns an ID when Gemini throws (random fallback)', async () => {
        const game = makeGame();
        mockGeminiError('timeout');
        const targetId = await pickVoteTarget(game, game.players['c1']);
        expect(targetId).not.toBeNull();
    });

    it('calls Gemini exactly once per invocation', async () => {
        const game = makeGame();
        mockGeminiResponse('Dave');
        await pickVoteTarget(game, game.players['m1']);
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });
});

// ─── Integration: full night sequence ────────────────────────────────────────

describe('night sequence integration', () => {
    it('all three roles can act independently without interfering', async () => {
        const game = makeGame();
        // Mafia kills c1
        mockGeminiResponse('Dave');
        await runAINightAction(game, game.players['m1']);
        // Detective investigates m1
        mockGeminiResponse('Alice');
        await runAINightAction(game, game.players['d1']);
        // Doctor protects c1
        mockGeminiResponse('Dave');
        await runAINightAction(game, game.players['doc1']);

        expect(game.night.killTarget).toBe('c1');
        expect(game.night.investigateTarget).toBe('m1');
        expect(game.night.protectTarget).toBe('c1');
        expect(game.night.actionsReceived).toContain('kill');
        expect(game.night.actionsReceived).toContain('investigate');
        expect(game.night.actionsReceived).toContain('protect');
    });

    it('second mafia call is a no-op once kill is registered', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', { name: 'Alice', role: 'mafia' }),
                m2: makePlayer('m2', { name: 'Frank', role: 'mafia' }),
                c1: makePlayer('c1', { name: 'Dave', role: 'civilian' }),
            },
        });

        mockGeminiResponse('Dave');
        await runAINightAction(game, game.players['m1']);
        const killAfterFirst = game.night.killTarget;

        // Second mafia player acts — should be skipped
        await runAINightAction(game, game.players['m2']);
        expect(game.night.killTarget).toBe(killAfterFirst);
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('gameLog accumulates events from all roles acting', async () => {
        const game = makeGame();
        mockGeminiResponse('Dave');
        await runAINightAction(game, game.players['m1']);
        mockGeminiResponse('Alice');
        await runAINightAction(game, game.players['d1']);
        mockGeminiResponse('Dave');
        await runAINightAction(game, game.players['doc1']);

        expect(game.gameLog.length).toBe(3);
    });
});
