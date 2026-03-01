import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Module mocks (must be hoisted before imports) ────────────────────────────

vi.mock('../../src/services/index.js', () => ({
    Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../../config/config.json', () => ({
    default: { groqApiKey: 'test-groq-key' },
}));
vi.mock('../../config/debug.json', () => ({}));
vi.mock('../../lang/logs.json', () => ({}));

// Mock groq-sdk so no real HTTP calls are made
const mockGroqCreate = vi.fn();
vi.mock('groq-sdk', () => ({
    default: vi.fn().mockImplementation(() => ({
        chat: {
            completions: {
                create: mockGroqCreate,
            },
        },
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
        playerLogs: {},
        ...overrides,
    };
}

/** Make Groq respond with a specific string. */
function mockGroqResponse(text: string) {
    mockGroqCreate.mockResolvedValueOnce({
        choices: [{ message: { content: text } }],
    });
}

/** Make Groq throw an error. */
function mockGroqError(msg = 'API error') {
    mockGroqCreate.mockRejectedValueOnce(new Error(msg));
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

    it('caps the log at 60 entries, dropping oldest', () => {
        const game = makeGame();
        for (let i = 1; i <= 65; i++) {
            logEvent(game, `event ${i}`);
        }
        expect(game.gameLog.length).toBe(60);
        expect(game.gameLog[0]).toBe('event 6');
        expect(game.gameLog[59]).toBe('event 65');
    });

    it('does not exceed 60 after many inserts', () => {
        const game = makeGame();
        for (let i = 0; i < 100; i++) logEvent(game, `e${i}`);
        expect(game.gameLog.length).toBe(60);
    });
});

// ─── runAINightAction — mafia ─────────────────────────────────────────────────

describe('runAINightAction – mafia', () => {
    it('sets killTarget to a non-mafia player', async () => {
        const game = makeGame();
        const mafia = game.players['m1'];
        mockGroqResponse('Dave'); // picks civilian c1

        await runAINightAction(game, mafia);

        expect(game.night.killTarget).not.toBeNull();
        expect(game.players[game.night.killTarget!]?.role).not.toBe('mafia');
    });

    it('adds "kill" to actionsReceived', async () => {
        const game = makeGame();
        mockGroqResponse('Dave');
        await runAINightAction(game, game.players['m1']);
        expect(game.night.actionsReceived).toContain('kill');
    });

    it('does not act a second time if kill already registered', async () => {
        const game = makeGame();
        game.night.actionsReceived.push('kill');
        game.night.killTarget = 'c1';

        await runAINightAction(game, game.players['m1']);

        // AI should NOT be called because action already taken
        expect(mockGroqCreate).not.toHaveBeenCalled();
        expect(game.night.killTarget).toBe('c1'); // unchanged
    });

    it('does not add a premature gameLog entry (kill is secret until night resolves)', async () => {
        const game = makeGame();
        mockGroqResponse('Eve');
        await runAINightAction(game, game.players['m1']);
        // Mafia kill target must not be broadcast to the shared log before night resolves
        expect(game.gameLog.some(e => e.toLowerCase().includes('mafia'))).toBe(false);
    });

    it('falls back to a random target when AI returns a nonsense name', async () => {
        const game = makeGame();
        mockGroqResponse('zzznobody_xyz');
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
        expect(mockGroqCreate).not.toHaveBeenCalled();
    });

    it('does not target fellow mafia members', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', { name: 'Alice', role: 'mafia' }),
                m2: makePlayer('m2', { name: 'Frank', role: 'mafia' }),
                c1: makePlayer('c1', { name: 'Dave', role: 'civilian' }),
            },
        });
        // Force AI to "choose" mafia teammate
        mockGroqResponse('Frank');
        await runAINightAction(game, game.players['m1']);
        // Should fall back to the only valid target (c1)
        expect(game.night.killTarget).toBe('c1');
    });
});

// ─── runAINightAction — detective ─────────────────────────────────────────────

describe('runAINightAction – detective', () => {
    it('sets investigateTarget to some alive player', async () => {
        const game = makeGame();
        mockGroqResponse('Alice');
        await runAINightAction(game, game.players['d1']);
        expect(game.night.investigateTarget).not.toBeNull();
    });

    it('adds "investigate" to actionsReceived', async () => {
        const game = makeGame();
        mockGroqResponse('Alice');
        await runAINightAction(game, game.players['d1']);
        expect(game.night.actionsReceived).toContain('investigate');
    });

    it('does not investigate a second time if already registered', async () => {
        const game = makeGame();
        game.night.actionsReceived.push('investigate');
        game.night.investigateTarget = 'c1';

        await runAINightAction(game, game.players['d1']);

        expect(mockGroqCreate).not.toHaveBeenCalled();
        expect(game.night.investigateTarget).toBe('c1');
    });

    it('logs the investigation result (found Mafia) to playerLogs, not gameLog', async () => {
        const game = makeGame();
        mockGroqResponse('Alice'); // Alice is mafia
        await runAINightAction(game, game.players['d1']);
        expect(game.playerLogs['d1']?.some(e => e.includes('MAFIA'))).toBe(true);
        expect(game.gameLog.some(e => e.includes('MAFIA'))).toBe(false);
    });

    it('logs the investigation result (innocent) to playerLogs, not gameLog', async () => {
        const game = makeGame();
        mockGroqResponse('Dave'); // Dave is civilian
        await runAINightAction(game, game.players['d1']);
        expect(game.playerLogs['d1']?.some(e => e.includes('not Mafia'))).toBe(true);
        expect(game.gameLog.some(e => e.includes('not Mafia'))).toBe(false);
    });

    it('does not investigate self', async () => {
        const game = makeGame();
        // Even if AI asks to investigate self, "d1" is not in candidates
        // The investigate candidates filter out self; if AI returns Bob (d1's name),
        // pickFromList will exclude self and fall back to first valid match or random
        // We just verify it completes without error and sets a target
        mockGroqResponse('Bob');
        await runAINightAction(game, game.players['d1']);
        expect(game.night.investigateTarget).not.toBe('d1');
    });
});

// ─── runAINightAction — doctor ────────────────────────────────────────────────

describe('runAINightAction – doctor', () => {
    it('sets protectTarget to some alive player', async () => {
        const game = makeGame();
        mockGroqResponse('Dave');
        await runAINightAction(game, game.players['doc1']);
        expect(game.night.protectTarget).not.toBeNull();
    });

    it('adds "protect" to actionsReceived', async () => {
        const game = makeGame();
        mockGroqResponse('Dave');
        await runAINightAction(game, game.players['doc1']);
        expect(game.night.actionsReceived).toContain('protect');
    });

    it('does not protect a second time if already registered', async () => {
        const game = makeGame();
        game.night.actionsReceived.push('protect');
        game.night.protectTarget = 'c1';

        await runAINightAction(game, game.players['doc1']);

        expect(mockGroqCreate).not.toHaveBeenCalled();
        expect(game.night.protectTarget).toBe('c1');
    });

    it('cannot protect the same player two rounds in a row', async () => {
        const game = makeGame({ round: 2 });
        // Set lastProtectedId to 'c1' (doctor protected c1 last round)
        game.players['doc1'].lastProtectedId = 'c1';

        mockGroqResponse('Dave'); // valid — c1 filtered out
        await runAINightAction(game, game.players['doc1']);

        expect(game.night.protectTarget).not.toBe('c1');
    });

    it('marks selfProtectUsed when doctor self-protects', async () => {
        const game = makeGame();
        // Guard: self-protect allowed on round 1
        mockGroqResponse('Carol'); // Carol is doc1
        await runAINightAction(game, game.players['doc1']);

        if (game.night.protectTarget === 'doc1') {
            expect(game.players['doc1'].selfProtectUsed).toBe(true);
        }
    });

    it('cannot self-protect if selfProtectUsed is true', async () => {
        const game = makeGame();
        game.players['doc1'].selfProtectUsed = true;
        // Only valid targets now are non-self players
        mockGroqResponse('Carol'); // Carol = doc1 = filtered out, fallback to others
        await runAINightAction(game, game.players['doc1']);
        expect(game.night.protectTarget).not.toBe('doc1');
    });

    it('logs a protect event to playerLogs, not gameLog', async () => {
        const game = makeGame();
        mockGroqResponse('Dave');
        await runAINightAction(game, game.players['doc1']);
        expect(game.playerLogs['doc1']?.some(e => e.toLowerCase().includes('protect'))).toBe(true);
        expect(game.gameLog.some(e => e.toLowerCase().includes('doctor'))).toBe(false);
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
        expect(mockGroqCreate).not.toHaveBeenCalled();
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
        expect(mockGroqCreate).not.toHaveBeenCalled();
    });
});

// ─── runAINightAction — AI errors ────────────────────────────────────────────

describe('runAINightAction – AI errors', () => {
    it('falls back to random target when AI API throws', async () => {
        const game = makeGame();
        mockGroqError('network timeout');
        // Despite the error, mafia should still get a kill target via random fallback
        await runAINightAction(game, game.players['m1']);
        // actionsReceived may or may not be updated depending on fallback path;
        // the key thing is no unhandled exception
        expect(game.night.killTarget).not.toBeNull();
    });
});

// ─── Retry / rate-limit logic ────────────────────────────────────────────────

/** Build a fake 429 error matching the Groq SDK's shape (retry-after header). */
function make429(retryAfterSecs = 10) {
    return Object.assign(new Error('rate limited'), {
        status: 429,
        headers: { 'retry-after': String(retryAfterSecs) },
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
        mockGroqCreate
            .mockRejectedValueOnce(make429(5))
            .mockResolvedValueOnce({ choices: [{ message: { content: 'Dave' } }] });

        const promise = runAINightAction(game, game.players['m1']);
        await vi.runAllTimersAsync();
        await promise;

        expect(game.night.killTarget).not.toBeNull();
        expect(game.night.actionsReceived).toContain('kill');
        expect(mockGroqCreate).toHaveBeenCalledTimes(2);
    });

    it('logs a warn (not error) on 429 retry', async () => {
        const game = makeGame();
        mockGroqCreate
            .mockRejectedValueOnce(make429(5))
            .mockResolvedValueOnce({ choices: [{ message: { content: 'Dave' } }] });

        const promise = runAINightAction(game, game.players['m1']);
        await vi.runAllTimersAsync();
        await promise;

        expect(vi.mocked(Logger.warn)).toHaveBeenCalledWith(
            expect.stringContaining('Groq rate-limited'),
            expect.anything()
        );
        expect(vi.mocked(Logger.error)).not.toHaveBeenCalled();
    });

    it('waits the retry delay from retry-after header', async () => {
        const game = makeGame();
        const advanceSpy = vi.spyOn(global, 'setTimeout');
        mockGroqCreate
            .mockRejectedValueOnce(make429(30))
            .mockResolvedValueOnce({ choices: [{ message: { content: 'Dave' } }] });

        const promise = runAINightAction(game, game.players['m1']);
        await vi.runAllTimersAsync();
        await promise;

        // At least one setTimeout call should have delay >= 30_000 ms
        const delays = advanceSpy.mock.calls.map(c => c[1] as number);
        expect(delays.some(d => d >= 30_000)).toBe(true);
    });

    it('parses retry delay from the error message as fallback', async () => {
        const game = makeGame();
        // Error with no retry-after header but message contains retry hint
        const err = Object.assign(new Error('Please retry in 20s.'), { status: 429 });
        mockGroqCreate
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce({ choices: [{ message: { content: 'Dave' } }] });

        const advanceSpy = vi.spyOn(global, 'setTimeout');
        const promise = runAINightAction(game, game.players['m1']);
        await vi.runAllTimersAsync();
        await promise;

        const delays = advanceSpy.mock.calls.map(c => c[1] as number);
        expect(delays.some(d => d >= 20_000)).toBe(true);
    });

    it('enforces a minimum 5 s delay when retry-after is "0" (quota exhausted)', async () => {
        const game = makeGame();
        const advanceSpy = vi.spyOn(global, 'setTimeout');
        mockGroqCreate
            .mockRejectedValueOnce(make429(0)) // API says "retry immediately" but quota is 0
            .mockResolvedValueOnce({ choices: [{ message: { content: 'Dave' } }] });

        const promise = runAINightAction(game, game.players['m1']);
        await vi.runAllTimersAsync();
        await promise;

        const delays = advanceSpy.mock.calls.map(c => c[1] as number);
        // Must wait at least 5 s even though retry-after said 0
        expect(delays.some(d => d >= 5_000)).toBe(true);
        // And it should have still retried successfully
        expect(game.night.killTarget).not.toBeNull();
    });

    it('exhausts all retries and falls back to empty / random', async () => {
        const game = makeGame();
        mockGroqCreate
            .mockRejectedValueOnce(make429(1))
            .mockRejectedValueOnce(make429(1))
            .mockRejectedValueOnce(make429(1));

        const promise = runAINightAction(game, game.players['m1']);
        await vi.runAllTimersAsync();
        await promise;

        // After 3 failures, ask() returns '' and pickFromList falls back to random
        expect(game.night.killTarget).not.toBeNull();
        expect(mockGroqCreate).toHaveBeenCalledTimes(3);
        // Final failure should be logged as error
        expect(vi.mocked(Logger.error)).toHaveBeenCalled();
    });

    it('does not retry on non-429 errors', async () => {
        const game = makeGame();
        const err = Object.assign(new Error('Internal server error'), { status: 500 });
        mockGroqCreate.mockRejectedValueOnce(err);

        const promise = runAINightAction(game, game.players['m1']);
        await vi.runAllTimersAsync();
        await promise;

        expect(mockGroqCreate).toHaveBeenCalledTimes(1);
        expect(vi.mocked(Logger.error)).toHaveBeenCalled();
    });

    it('generateDayMessage retries on 429 and returns the eventual text', async () => {
        const game = makeGame();
        mockGroqCreate
            .mockRejectedValueOnce(make429(2))
            .mockResolvedValueOnce({ choices: [{ message: { content: 'I suspect Alice.' } }] });

        const promise = generateDayMessage(game, game.players['c1']);
        await vi.runAllTimersAsync();
        const msg = await promise;

        expect(msg).toBe('I suspect Alice.');
        expect(mockGroqCreate).toHaveBeenCalledTimes(2);
    });

    it('pickVoteTarget retries on 429 and returns a valid target', async () => {
        const game = makeGame();
        mockGroqCreate
            .mockRejectedValueOnce(make429(2))
            .mockResolvedValueOnce({ choices: [{ message: { content: 'Alice' } }] });

        const promise = pickVoteTarget(game, game.players['c1']);
        await vi.runAllTimersAsync();
        const targetId = await promise;

        expect(targetId).toBe('m1'); // Alice = m1
        expect(mockGroqCreate).toHaveBeenCalledTimes(2);
    });
});

// ─── generateDayMessage ───────────────────────────────────────────────────────

describe('generateDayMessage', () => {
    it('returns the AI response text', async () => {
        const game = makeGame();
        mockGroqResponse('I think Alice is suspicious.');
        const msg = await generateDayMessage(game, game.players['c1']);
        expect(msg).toBe('I think Alice is suspicious.');
    });

    it('returns default message when AI returns empty string', async () => {
        const game = makeGame();
        mockGroqResponse('');
        const msg = await generateDayMessage(game, game.players['c1']);
        expect(msg).toBe('Not sure who to trust right now...');
    });

    it('returns default message when AI throws', async () => {
        const game = makeGame();
        mockGroqError('quota exceeded');
        const msg = await generateDayMessage(game, game.players['c1']);
        expect(msg).toBe('Not sure who to trust right now...');
    });

    it('strips <think> blocks and returns only final visible text', async () => {
        const game = makeGame();
        mockGroqResponse(
            `<tool_call>Internal chain of thought that should not be shown. thinking about responding with "I’m still trying to figure things out. Should we focus on players avoiding questions?"<tool_call>\n\n"I’m still trying to figure things out. Should we focus on players avoiding questions?"`
        );

        const msg = await generateDayMessage(game, game.players['c1']);

        expect(msg).toBe(
            'I’m still trying to figure things out. Should we focus on players avoiding questions?'
        );
    });

    it('returns a non-empty string for any role', async () => {
        const game = makeGame();
        for (const player of Object.values(game.players)) {
            mockGroqResponse('Something to say.');
            const msg = await generateDayMessage(game, player);
            expect(typeof msg).toBe('string');
            expect(msg.length).toBeGreaterThan(0);
        }
    });

    it('includes game context — calls AI exactly once per invocation', async () => {
        const game = makeGame({ gameLog: ['[Night 1] Mafia targeted someone'] });
        mockGroqResponse('Hm, I wonder who did it.');
        await generateDayMessage(game, game.players['c1']);
        expect(mockGroqCreate).toHaveBeenCalledTimes(1);
        const callArg = mockGroqCreate.mock.calls[0][0] as { messages: { content: string }[] };
        expect(callArg.messages[0].content).toContain('RECENT EVENTS');
    });

    it('includes phase and private notes in context prompt', async () => {
        const game = makeGame({
            phase: 'day',
            gameLog: ['[Night 1] Someone was saved by the doctor.'],
            playerLogs: {
                c1: ['[Night 1] You heard conflicting claims.'],
            },
        });
        mockGroqResponse('I need more evidence.');

        await generateDayMessage(game, game.players['c1']);

        const callArg = mockGroqCreate.mock.calls[0][0] as { messages: { content: string }[] };
        const prompt = callArg.messages[0].content;
        expect(prompt).toContain('CURRENT PHASE: DAY');
        expect(prompt).toContain('YOUR PRIVATE NOTES');
        expect(prompt).toContain('- [Night 1] You heard conflicting claims.');
        expect(prompt).toContain('PERSONALITY:');
        expect(prompt).toContain('KNOWLEDGE RULES:');
    });

    it('does not include hidden role data from raw game state in eliminated list', async () => {
        const game = makeGame({
            phase: 'day',
            players: {
                m1: makePlayer('m1', { name: 'Alice', role: 'mafia', alive: false }),
                d1: makePlayer('d1', { name: 'Bob', role: 'detective', alive: true }),
                c1: makePlayer('c1', { name: 'Dave', role: 'civilian', alive: true }),
            },
            gameLog: ['[Day 1] Alice was eliminated by vote (was Mafia)'],
        });

        mockGroqResponse('I am not sure yet.');
        await generateDayMessage(game, game.players['c1']);

        const callArg = mockGroqCreate.mock.calls[0][0] as { messages: { content: string }[] };
        const prompt = callArg.messages[0].content;
        expect(prompt).toContain('ELIMINATED: Alice');
        expect(prompt).not.toContain('ELIMINATED: Alice (was mafia)');
    });
});

// ─── human messages in AI context ────────────────────────────────────────────

describe('human messages in AI context (generateDayMessage)', () => {
    it('includes human day-phase messages from gameLog in the Groq prompt', async () => {
        const game = makeGame({
            phase: 'day',
            gameLog: [
                '[Day 1] Alice: "I think Dave did it."',
                '[Day 1] Bob: "Alice is acting really suspicious to me."',
            ],
        });
        mockGroqResponse('I agree, Alice has been odd.');

        await generateDayMessage(game, game.players['c1']);

        const prompt = (mockGroqCreate.mock.calls[0][0] as { messages: { content: string }[] })
            .messages[0].content;
        expect(prompt).toContain('[Day 1] Alice: "I think Dave did it."');
        expect(prompt).toContain('[Day 1] Bob: "Alice is acting really suspicious to me."');
    });

    it('includes all gameLog entries — not just the last 10', async () => {
        // Previously only slice(-10) was used; now the full log is included.
        const game = makeGame({ phase: 'day', gameLog: [] });
        for (let i = 1; i <= 15; i++) {
            logEvent(game, `[Day 1] Human${i}: "Message ${i}"`);
        }
        mockGroqResponse('Interesting...');

        await generateDayMessage(game, game.players['c1']);

        const prompt = (mockGroqCreate.mock.calls[0][0] as { messages: { content: string }[] })
            .messages[0].content;
        for (let i = 1; i <= 15; i++) {
            expect(prompt).toContain(`[Day 1] Human${i}: "Message ${i}"`);
        }
    });

    it('shows "Game just started." when no events have been logged yet', async () => {
        const game = makeGame({ phase: 'day', gameLog: [] });
        mockGroqResponse('Hard to say this early.');

        await generateDayMessage(game, game.players['c1']);

        const prompt = (mockGroqCreate.mock.calls[0][0] as { messages: { content: string }[] })
            .messages[0].content;
        expect(prompt).toContain('Game just started.');
    });

    it('keeps messages logged by logEvent in order in the prompt', async () => {
        const game = makeGame({ phase: 'day', gameLog: [] });
        logEvent(game, '[Day 1] Alice: "Who should we vote?"');
        logEvent(game, '[Day 1] Bob: "I suspect Dave."');
        logEvent(game, '[Day 1] Carol: "Bob is quiet, watch him."');
        mockGroqResponse('I am watching closely.');

        await generateDayMessage(game, game.players['c1']);

        const prompt = (mockGroqCreate.mock.calls[0][0] as { messages: { content: string }[] })
            .messages[0].content;
        const alicePos = prompt.indexOf('[Day 1] Alice');
        const bobPos = prompt.indexOf('[Day 1] Bob');
        const carolPos = prompt.indexOf('[Day 1] Carol');
        expect(alicePos).toBeGreaterThan(-1);
        expect(bobPos).toBeGreaterThan(alicePos);
        expect(carolPos).toBeGreaterThan(bobPos);
    });
});

// ─── pickVoteTarget ───────────────────────────────────────────────────────────

describe('pickVoteTarget', () => {
    it('returns an ID of an alive non-self player', async () => {
        const game = makeGame();
        mockGroqResponse('Alice'); // Alice = m1
        const targetId = await pickVoteTarget(game, game.players['c1']);
        expect(targetId).not.toBeNull();
        expect(targetId).not.toBe('c1');
        expect(game.players[targetId!]).toBeDefined();
        expect(game.players[targetId!].alive).toBe(true);
    });

    it('resolves by player name match', async () => {
        const game = makeGame();
        mockGroqResponse('Bob'); // Bob = d1
        const targetId = await pickVoteTarget(game, game.players['c1']);
        expect(targetId).toBe('d1');
    });

    it('falls back to random when name is unrecognised', async () => {
        const game = makeGame();
        mockGroqResponse('zzznope_xyz');
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
        expect(mockGroqCreate).not.toHaveBeenCalled();
    });

    it('does not vote for dead players', async () => {
        const game = makeGame();
        game.players['m1'].alive = false;
        game.players['d1'].alive = false;

        mockGroqResponse('Alice'); // Alice is dead — should fall back
        const targetId = await pickVoteTarget(game, game.players['c1']);
        // Result must be one of the still-alive, non-self players
        expect(targetId).not.toBeNull();
        expect(game.players[targetId!].alive).toBe(true);
    });

    it('returns an ID when AI throws (random fallback)', async () => {
        const game = makeGame();
        mockGroqError('timeout');
        const targetId = await pickVoteTarget(game, game.players['c1']);
        expect(targetId).not.toBeNull();
    });

    it('calls AI exactly once per invocation', async () => {
        const game = makeGame();
        mockGroqResponse('Dave');
        await pickVoteTarget(game, game.players['m1']);
        expect(mockGroqCreate).toHaveBeenCalledTimes(1);
    });
});

// ─── Integration: full night sequence ────────────────────────────────────────

describe('night sequence integration', () => {
    it('all three roles can act independently without interfering', async () => {
        const game = makeGame();
        // Mafia kills c1
        mockGroqResponse('Dave');
        await runAINightAction(game, game.players['m1']);
        // Detective investigates m1
        mockGroqResponse('Alice');
        await runAINightAction(game, game.players['d1']);
        // Doctor protects c1
        mockGroqResponse('Dave');
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

        mockGroqResponse('Dave');
        await runAINightAction(game, game.players['m1']);
        const killAfterFirst = game.night.killTarget;

        // Second mafia player acts — should be skipped
        await runAINightAction(game, game.players['m2']);
        expect(game.night.killTarget).toBe(killAfterFirst);
        expect(mockGroqCreate).toHaveBeenCalledTimes(1);
    });

    it('private role logs accumulate in playerLogs, not in shared gameLog', async () => {
        const game = makeGame();
        mockGroqResponse('Dave');
        await runAINightAction(game, game.players['m1']);
        mockGroqResponse('Alice');
        await runAINightAction(game, game.players['d1']);
        mockGroqResponse('Dave');
        await runAINightAction(game, game.players['doc1']);

        // Nothing leaks to the shared log during night
        expect(game.gameLog.length).toBe(0);
        // Each role's private info is visible only to them
        expect(game.playerLogs['d1']?.length).toBeGreaterThan(0);
        expect(game.playerLogs['doc1']?.length).toBeGreaterThan(0);
        // Mafia has no private log (their kill becomes public when night resolves)
        expect(game.playerLogs['m1']).toBeUndefined();
    });

    it('does not overwrite an already-submitted mafia kill after AI response returns', async () => {
        const game = makeGame();
        game.night.killTarget = 'c2';

        mockGroqCreate.mockImplementationOnce(async () => {
            game.night.actionsReceived.push('kill');
            return { choices: [{ message: { content: 'Dave' } }] };
        });

        await runAINightAction(game, game.players['m1']);

        expect(game.night.killTarget).toBe('c2');
        expect(game.night.actionsReceived.filter(action => action === 'kill')).toHaveLength(1);
    });
});
