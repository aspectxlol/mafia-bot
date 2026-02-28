import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/index.js', () => ({
    Lang: {
        getRef: vi.fn().mockReturnValue('vote'),
        getRefLocalizationMap: vi.fn().mockReturnValue({}),
    },
    Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../../src/game/phases.js', () => ({
    resolveVote: vi.fn().mockResolvedValue(undefined),
    updateVoteTally: vi.fn().mockResolvedValue(undefined),
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
import { resolveVote, updateVoteTally } from '../../../src/game/phases.js';
import { VoteCommand } from '../../../src/commands/chat/vote-command.js';
import { makeIntr } from '../helpers.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const GAME_CH = 'voteCmdCh';

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
        phase: 'vote',
        gameNumber: 4,
        hostId: 'm1',
        guildId: 'guild1',
        players: {
            m1: makePlayer('m1', 'mafia'),
            c1: makePlayer('c1', 'civilian'),
            c2: makePlayer('c2', 'civilian'),
        },
        readyPlayers: new Set(),
        night: createNightState(),
        vote: createVoteState(),
        mafiaChannelId: 'voteMafiaCh',
        gameChannelId: GAME_CH,
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
        ...overrides,
    };
}

afterEach(() => {
    deleteGame(GAME_CH);
    vi.clearAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('VoteCommand', () => {
    const cmd = new VoteCommand();

    it('rejects when used outside a guild', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' }, guild: null });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('game channel'));
    });

    it('rejects when there is no active game in the channel', async () => {
        const intr = makeIntr({ channelId: 'noSuchChannel', user: { id: 'c1' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('No active game'));
    });

    it('rejects when phase is not vote', async () => {
        const game = makeGame({ phase: 'day' });
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('not currently open'));
    });

    it('rejects when voter is not in the game', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'outsider' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('alive players'));
    });

    it('rejects when voter is dead', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian', false), // dead
                c2: makePlayer('c2', 'civilian'),
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('alive players'));
    });

    it('rejects when target is not in the game', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: GAME_CH,
            user: { id: 'c1' },
            targetUser: { id: 'stranger' },
        });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('not in this game'));
    });

    it('rejects when target is already dead', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia', false), // dead
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' }, targetUser: { id: 'm1' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('already dead'));
    });

    it('rejects self-voting', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' }, targetUser: { id: 'c1' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(
            expect.stringContaining('cannot vote for yourself')
        );
    });

    it('records the vote and confirms with success message', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' }, targetUser: { id: 'm1' } });
        await cmd.execute(intr as any, null as any);
        expect(game.vote.votes['c1']).toBe('m1');
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('voted'));
    });

    it('calls updateVoteTally after recording', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' }, targetUser: { id: 'm1' } });
        await cmd.execute(intr as any, null as any);
        expect(updateVoteTally).toHaveBeenCalledWith(game, intr.client);
    });

    it('mentions previous vote when changing to a different target', async () => {
        const game = makeGame({
            vote: { votes: { c1: 'c2' }, tally: {} }, // c1 previously voted for c2
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' }, targetUser: { id: 'm1' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('changed'));
    });

    it('does not trigger early resolution until all alive players have voted', async () => {
        // 3 alive players, only 1 voted so far
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' }, targetUser: { id: 'm1' } });
        await cmd.execute(intr as any, null as any);
        expect(resolveVote).not.toHaveBeenCalled();
    });

    it('triggers early resolution when all alive players have voted', async () => {
        // 2 alive players: c1 will vote for m1, m1 already voted
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
            },
            vote: { votes: { m1: 'c1' }, tally: { c1: 1 } }, // m1 already voted
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' }, targetUser: { id: 'm1' } });
        await cmd.execute(intr as any, null as any);
        // Both alive players have voted
        expect(resolveVote).toHaveBeenCalledWith(game, intr.client);
    });

    it('rejects when neither target nor name option is provided', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        // Override options directly to return null for both
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' } });
        (intr.options.getUser as any).mockReturnValue(null);
        (intr.options.getString as any).mockReturnValue(null);
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('specify a player'));
    });

    it('allows voting for an AI player by name', async () => {
        const aiPlayer: PlayerState = {
            id: 'ai:1:1',
            name: 'Alice',
            role: 'civilian',
            alive: true,
            isAI: true,
            protectedLastNight: false,
            lastProtectedId: null,
            selfProtectUsed: false,
        };
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
                'ai:1:1': aiPlayer,
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' }, targetName: 'Alice' });
        await cmd.execute(intr as any, null as any);
        expect(game.vote.votes['c1']).toBe('ai:1:1');
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('Alice'));
    });

    it('rejects vote by name when no player has that name', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' }, targetName: 'Nobody' });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('Nobody'));
    });

    it('is case-insensitive when matching player name', async () => {
        const aiPlayer: PlayerState = {
            id: 'ai:1:2',
            name: 'Bob',
            role: 'mafia',
            alive: true,
            isAI: true,
            protectedLastNight: false,
            lastProtectedId: null,
            selfProtectUsed: false,
        };
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
                'ai:1:2': aiPlayer,
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'c1' }, targetName: 'BOB' });
        await cmd.execute(intr as any, null as any);
        expect(game.vote.votes['c1']).toBe('ai:1:2');
    });
});
