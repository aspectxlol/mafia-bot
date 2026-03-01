import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetGame, mockLogEvent } = vi.hoisted(() => ({
    mockGetGame: vi.fn(),
    mockLogEvent: vi.fn(),
}));

vi.mock('../../src/game/gameState.js', () => ({
    getGame: mockGetGame,
}));

vi.mock('../../src/game/aiPlayer.js', () => ({
    logEvent: mockLogEvent,
}));

import { MessageHandler } from '../../src/events/message-handler.js';

function makeMessage(overrides: Record<string, unknown> = {}) {
    return {
        system: false,
        channelId: 'ch1',
        author: { id: 'u1', bot: false, displayName: 'User1' },
        client: { user: { id: 'bot1' } },
        content: 'I think Riley is suspicious.',
        embeds: [],
        attachments: { size: 0 },
        stickers: { size: 0 },
        ...overrides,
    };
}

describe('MessageHandler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('logs in-game human day messages into AI context', async () => {
        const game = {
            phase: 'day',
            round: 2,
            players: {
                u1: { id: 'u1', name: 'Alex', alive: true },
            },
        };
        mockGetGame.mockReturnValueOnce(game);

        const triggerHandler = { process: vi.fn().mockResolvedValue(undefined) };
        const handler = new MessageHandler(triggerHandler as any);

        await handler.process(makeMessage() as any);

        expect(mockLogEvent).toHaveBeenCalledWith(
            game,
            '[Day 2] Alex: "I think Riley is suspicious."'
        );
        expect(triggerHandler.process).toHaveBeenCalledTimes(1);
    });

    it('does not log messages from users not in the game', async () => {
        const game = {
            phase: 'day',
            round: 1,
            players: {
                u2: { id: 'u2', name: 'Other', alive: true },
            },
        };
        mockGetGame.mockReturnValueOnce(game);

        const triggerHandler = { process: vi.fn().mockResolvedValue(undefined) };
        const handler = new MessageHandler(triggerHandler as any);

        await handler.process(makeMessage({ author: { id: 'u1', bot: false } }) as any);

        expect(mockLogEvent).not.toHaveBeenCalled();
        expect(triggerHandler.process).toHaveBeenCalledTimes(1);
    });

    it('does not log dead player messages', async () => {
        const game = {
            phase: 'day',
            round: 1,
            players: {
                u1: { id: 'u1', name: 'Alex', alive: false },
            },
        };
        mockGetGame.mockReturnValueOnce(game);

        const triggerHandler = { process: vi.fn().mockResolvedValue(undefined) };
        const handler = new MessageHandler(triggerHandler as any);

        await handler.process(makeMessage() as any);

        expect(mockLogEvent).not.toHaveBeenCalled();
        expect(triggerHandler.process).toHaveBeenCalledTimes(1);
    });

    it('does not log non-day messages', async () => {
        const game = {
            phase: 'night',
            round: 1,
            players: {
                u1: { id: 'u1', name: 'Alex', alive: true },
            },
        };
        mockGetGame.mockReturnValueOnce(game);

        const triggerHandler = { process: vi.fn().mockResolvedValue(undefined) };
        const handler = new MessageHandler(triggerHandler as any);

        await handler.process(makeMessage() as any);

        expect(mockLogEvent).not.toHaveBeenCalled();
        expect(triggerHandler.process).toHaveBeenCalledTimes(1);
    });

    it('does not process system messages', async () => {
        const triggerHandler = { process: vi.fn().mockResolvedValue(undefined) };
        const handler = new MessageHandler(triggerHandler as any);

        await handler.process(makeMessage({ system: true }) as any);

        expect(mockLogEvent).not.toHaveBeenCalled();
        expect(triggerHandler.process).not.toHaveBeenCalled();
    });
});
