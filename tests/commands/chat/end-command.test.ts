import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/index.js', () => ({
    Lang: {
        getRef: vi.fn().mockReturnValue('end'),
        getRefLocalizationMap: vi.fn().mockReturnValue({}),
    },
    Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../../src/utils/index.js', () => ({
    InteractionUtils: { send: vi.fn().mockResolvedValue(undefined) },
    FormatUtils: {},
    CommandUtils: {},
}));
vi.mock('../../../config/config.json', () => ({}));
vi.mock('../../../config/debug.json', () => ({}));
vi.mock('../../../lang/logs.json', () => ({}));

import {
    createNightState,
    createVoteState,
    deleteGame,
    GameState,
    getGame,
    PlayerState,
    setGame,
} from '../../../src/game/gameState.js';
import { InteractionUtils } from '../../../src/utils/index.js';
import { EndCommand } from '../../../src/commands/chat/end-command.js';
import { makeIntr } from '../helpers.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const GAME_CH = 'endCmdCh';

function makePlayer(id: string, role: PlayerState['role'], alive = true): PlayerState {
    return {
        id,
        name: `P_${id}`,
        role,
        alive,
        isAI: false,
        protectedLastNight: false,
        lastProtectedId: null,
        selfProtectUsed: false,
    };
}

function makeGame(overrides: Partial<GameState> = {}): GameState {
    return {
        phase: 'night',
        gameNumber: 9,
        hostId: 'host1',
        guildId: 'guild1',
        players: {
            host1: makePlayer('host1', 'civilian'),
            m1: makePlayer('m1', 'mafia'),
        },
        readyPlayers: new Set(),
        night: createNightState(),
        vote: createVoteState(),
        mafiaChannelId: 'endMafiaCh',
        gameChannelId: GAME_CH,
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

afterEach(() => {
    deleteGame(GAME_CH);
    vi.clearAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('EndCommand', () => {
    const cmd = new EndCommand();

    it('replies with error when no game is found', async () => {
        const intr = makeIntr({
            channelId: 'noSuchChannel',
            user: { id: 'randomer' },
            guild: null,
        });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('No active game'));
    });

    it('rejects when the user is not the host', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'm1' } }); // m1 is not host
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('host'));
    });

    it('sets game phase to "ended" when host force-ends the game', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'host1' } });
        await cmd.execute(intr as any, null as any);
        expect(game.phase).toBe('ended');
    });

    it('removes the game from the store', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'host1' } });
        await cmd.execute(intr as any, null as any);
        expect(getGame(GAME_CH)).toBeUndefined();
    });

    it('clears timers when ending the game', async () => {
        const phaseTimer = setTimeout(() => {}, 99999);
        const reminderTimer = setTimeout(() => {}, 99999);
        const game = makeGame({ phaseTimer, reminderTimer });
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'host1' } });
        await cmd.execute(intr as any, null as any);
        expect(game.phaseTimer).toBeNull();
        expect(game.reminderTimer).toBeNull();
    });

    it('sends end message to game channel', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const mockChannel = {
            send: vi.fn().mockResolvedValue(undefined),
            messages: { fetch: vi.fn().mockResolvedValue(null) },
        };
        const mockMafiaChannel = {
            delete: vi.fn().mockResolvedValue(undefined),
        };
        const intr = makeIntr({
            channelId: GAME_CH,
            user: { id: 'host1' },
            client: {
                channels: {
                    fetch: vi.fn().mockImplementation((id: string) => {
                        if (id === GAME_CH) return Promise.resolve(mockChannel);
                        if (id === 'endMafiaCh') return Promise.resolve(mockMafiaChannel);
                        return Promise.resolve(null);
                    }),
                },
                user: { id: 'botUser' },
            },
        });
        await cmd.execute(intr as any, null as any);
        expect(mockChannel.send).toHaveBeenCalledWith(
            expect.objectContaining({
                embeds: expect.arrayContaining([
                    expect.objectContaining({
                        data: expect.objectContaining({
                            title: expect.stringMatching(/force-ended/i),
                        }),
                    }),
                ]),
            })
        );
    });

    it('deletes the mafia channel on force-end', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const mockChannel = { send: vi.fn().mockResolvedValue(undefined) };
        const mockMafiaChannel = { delete: vi.fn().mockResolvedValue(undefined) };
        const intr = makeIntr({
            channelId: GAME_CH,
            user: { id: 'host1' },
            client: {
                channels: {
                    fetch: vi.fn().mockImplementation((id: string) => {
                        if (id === GAME_CH) return Promise.resolve(mockChannel);
                        if (id === 'endMafiaCh') return Promise.resolve(mockMafiaChannel);
                        return Promise.resolve(null);
                    }),
                },
                user: { id: 'botUser' },
            },
        });
        await cmd.execute(intr as any, null as any);
        expect(mockMafiaChannel.delete).toHaveBeenCalled();
    });

    it('sends success confirmation via InteractionUtils', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'host1' } });
        await cmd.execute(intr as any, null as any);
        expect(InteractionUtils.send).toHaveBeenCalledWith(
            intr,
            expect.stringContaining('ended'),
            true
        );
    });

    it('finds the game by user id when not in the game channel', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: 'someOtherChannel',
            user: { id: 'host1' },
            guild: null,
        });
        await cmd.execute(intr as any, null as any);
        // Should still find the game and set phase to ended
        expect(game.phase).toBe('ended');
    });
});
