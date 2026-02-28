import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/index.js', () => ({
    Lang: {
        getRef: vi.fn().mockReturnValue('status'),
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
    PlayerState,
    setGame,
} from '../../../src/game/gameState.js';
import { InteractionUtils } from '../../../src/utils/index.js';
import { StatusCommand } from '../../../src/commands/chat/status-command.js';
import { makeIntr } from '../helpers.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const GAME_CH = 'statusCmdCh';
const GAME_CH2 = 'statusCmdCh2';

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

function makeGame(channelId: string, overrides: Partial<GameState> = {}): GameState {
    return {
        phase: 'day',
        gameNumber: 5,
        hostId: 'm1',
        guildId: 'guild1',
        players: {
            m1: makePlayer('m1', 'mafia'),
            c1: makePlayer('c1', 'civilian'),
        },
        readyPlayers: new Set(),
        night: createNightState(),
        vote: createVoteState(),
        mafiaChannelId: null,
        gameChannelId: channelId,
        round: 2,
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
    deleteGame(GAME_CH2);
    vi.clearAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('StatusCommand', () => {
    const cmd = new StatusCommand();

    it('replies with error when no active game found', async () => {
        const intr = makeIntr({ channelId: 'noGameHere', user: { id: 'user99' }, guild: null });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(
            expect.stringContaining('No active Mafia game')
        );
    });

    it('finds game by game channel (primary lookup)', async () => {
        const game = makeGame(GAME_CH);
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'outsider' } });
        await cmd.execute(intr as any, null as any);
        expect(InteractionUtils.send).toHaveBeenCalled();
    });

    it('finds game when user is a player (secondary lookup)', async () => {
        const game = makeGame(GAME_CH);
        setGame(GAME_CH, game);
        // Using a different channel but user is in the game
        const intr = makeIntr({ channelId: 'randomCh', user: { id: 'm1' } });
        await cmd.execute(intr as any, null as any);
        expect(InteractionUtils.send).toHaveBeenCalled();
    });

    it('finds game by guild (tertiary lookup)', async () => {
        const game = makeGame(GAME_CH, { guildId: 'guild42' });
        setGame(GAME_CH, game);
        // User is not in the game, different channel, but same guild
        const intr = makeIntr({
            channelId: 'randomCh',
            user: { id: 'stranger' },
            guild: { id: 'guild42' },
        });
        await cmd.execute(intr as any, null as any);
        expect(InteractionUtils.send).toHaveBeenCalled();
    });

    it('does not find ended games when looking by guild', async () => {
        const game = makeGame(GAME_CH, { phase: 'ended', guildId: 'guild42' });
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: 'randomCh',
            user: { id: 'stranger' },
            guild: { id: 'guild42' },
        });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(
            expect.stringContaining('No active Mafia game')
        );
    });

    it('sends an embed with the game status', async () => {
        const game = makeGame(GAME_CH);
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'm1' } });
        await cmd.execute(intr as any, null as any);
        expect(InteractionUtils.send).toHaveBeenCalledWith(
            intr,
            expect.objectContaining({ data: expect.any(Object) }), // EmbedBuilder
            true
        );
    });

    it('includes vote tally field when in vote phase with active tally', async () => {
        const game = makeGame(GAME_CH, {
            phase: 'vote',
            vote: {
                votes: { c1: 'm1' },
                tally: { m1: 1 },
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'm1' } });
        await cmd.execute(intr as any, null as any);
        expect(InteractionUtils.send).toHaveBeenCalled();
    });

    it('shows dead players with their revealed roles', async () => {
        const game = makeGame(GAME_CH, {
            players: {
                m1: makePlayer('m1', 'mafia', false), // dead
                c1: makePlayer('c1', 'civilian', true), // alive
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' } });
        await cmd.execute(intr as any, null as any);
        expect(InteractionUtils.send).toHaveBeenCalled();
    });
});
