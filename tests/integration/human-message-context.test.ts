/**
 * Integration test: Discord message → logEvent → AI prompt.
 *
 * No mocks on logEvent or generateDayMessage/buildContext.
 * The full chain is exercised:
 *   MessageHandler.process() → real logEvent() → game.gameLog
 *   → real generateDayMessage() → Groq prompt contains the human text.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Hoist shared mocks ───────────────────────────────────────────────────────

const { mockGroqCreate, mockGetGame } = vi.hoisted(() => ({
    mockGroqCreate: vi.fn(),
    mockGetGame: vi.fn(),
}));

// Mock Groq — no real HTTP calls
vi.mock('groq-sdk', () => ({
    default: vi.fn().mockImplementation(() => ({
        chat: { completions: { create: mockGroqCreate } },
    })),
}));

// Mock getGame so MessageHandler and generateDayMessage share our test GameState
vi.mock('../../src/game/gameState.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../../src/game/gameState.js')>();
    return { ...actual, getGame: mockGetGame };
});

// Mock handleDayPlayerMessage — it needs live Discord channels; not under test here
vi.mock('../../src/game/phases.js', () => ({
    handleDayPlayerMessage: vi.fn(),
}));

// Silence loggers
vi.mock('../../src/services/index.js', () => ({
    Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../../config/config.json', () => ({ default: { groqApiKey: 'test-key' } }));
vi.mock('../../config/debug.json', () => ({}));
vi.mock('../../lang/logs.json', () => ({}));

// ─── Real imports (after mocks) ───────────────────────────────────────────────

import { MessageHandler } from '../../src/events/message-handler.js';
import { generateDayMessage } from '../../src/game/aiPlayer.js';
import {
    createNightState,
    createVoteState,
    GameState,
    PlayerState,
} from '../../src/game/gameState.js';

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
        phase: 'day',
        gameNumber: 1,
        hostId: 'host',
        guildId: 'guild1',
        players: {
            u1: makePlayer('u1', { name: 'Jordan' }),
            u2: makePlayer('u2', { name: 'Riley' }),
            ai1: makePlayer('ai1', { name: 'Aria', isAI: true, role: 'civilian' }),
        },
        readyPlayers: new Set(),
        night: createNightState(),
        vote: createVoteState(),
        mafiaChannelId: null,
        gameChannelId: 'ch1',
        round: 2,
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
        ...overrides,
    };
}

function makeDiscordMessage(overrides: Record<string, unknown> = {}) {
    return {
        system: false,
        channelId: 'ch1',
        author: { id: 'u1', bot: false, username: 'jordan_user' },
        client: { user: { id: 'bot1' } },
        content: 'I think Riley is acting weird.',
        embeds: [],
        attachments: { size: 0 },
        stickers: { size: 0 },
        ...overrides,
    };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('human message → AI context (integration)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('MessageHandler appends the human message to game.gameLog', async () => {
        const game = makeGame();
        mockGetGame.mockReturnValue(game);

        const handler = new MessageHandler({
            process: vi.fn().mockResolvedValue(undefined),
        } as any);
        await handler.process(makeDiscordMessage() as any);

        expect(game.gameLog).toHaveLength(1);
        expect(game.gameLog[0]).toBe('[Day 2] Jordan: "I think Riley is acting weird."');
    });

    it('generateDayMessage includes the logged human message in the Groq prompt', async () => {
        const game = makeGame();
        mockGetGame.mockReturnValue(game);

        // Step 1: human sends a message → MessageHandler logs it
        const handler = new MessageHandler({
            process: vi.fn().mockResolvedValue(undefined),
        } as any);
        await handler.process(makeDiscordMessage() as any);

        // Step 2: AI generates a day message — Groq prompt must contain the human text
        mockGroqCreate.mockResolvedValueOnce({
            choices: [{ message: { content: 'Yeah, Riley does seem off.' } }],
        });
        await generateDayMessage(game, game.players['ai1']);

        const prompt = (mockGroqCreate.mock.calls[0][0] as { messages: { content: string }[] })
            .messages[0].content;

        expect(prompt).toContain('[Day 2] Jordan: "I think Riley is acting weird."');
    });

    it('multiple human messages all appear in the prompt', async () => {
        const game = makeGame();
        mockGetGame.mockReturnValue(game);

        const handler = new MessageHandler({
            process: vi.fn().mockResolvedValue(undefined),
        } as any);

        await handler.process(
            makeDiscordMessage({
                author: { id: 'u1', bot: false },
                content: 'Jordan speaks first.',
            }) as any
        );
        await handler.process(
            makeDiscordMessage({
                author: { id: 'u2', bot: false },
                content: 'Riley replies second.',
            }) as any
        );

        expect(game.gameLog).toHaveLength(2);

        mockGroqCreate.mockResolvedValueOnce({
            choices: [{ message: { content: 'Interesting...' } }],
        });
        await generateDayMessage(game, game.players['ai1']);

        const prompt = (mockGroqCreate.mock.calls[0][0] as { messages: { content: string }[] })
            .messages[0].content;

        expect(prompt).toContain('[Day 2] Jordan: "Jordan speaks first."');
        expect(prompt).toContain('[Day 2] Riley: "Riley replies second."');
    });

    it('bot messages are NOT logged', async () => {
        const game = makeGame();
        mockGetGame.mockReturnValue(game);

        const handler = new MessageHandler({
            process: vi.fn().mockResolvedValue(undefined),
        } as any);
        await handler.process(makeDiscordMessage({ author: { id: 'u1', bot: true } }) as any);

        expect(game.gameLog).toHaveLength(0);
    });

    it('messages outside the day phase are NOT logged', async () => {
        const game = makeGame({ phase: 'night' });
        mockGetGame.mockReturnValue(game);

        const handler = new MessageHandler({
            process: vi.fn().mockResolvedValue(undefined),
        } as any);
        await handler.process(makeDiscordMessage() as any);

        expect(game.gameLog).toHaveLength(0);
    });
});
