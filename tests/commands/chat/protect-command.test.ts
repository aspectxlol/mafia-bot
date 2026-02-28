import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/index.js', () => ({
    Lang: {
        getRef: vi.fn().mockReturnValue('protect'),
        getRefLocalizationMap: vi.fn().mockReturnValue({}),
    },
    Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../../src/game/phases.js', () => ({
    resolveNight: vi.fn().mockResolvedValue(undefined),
    sendDM: vi.fn().mockResolvedValue(undefined),
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
import { resolveNight } from '../../../src/game/phases.js';
import { ProtectCommand } from '../../../src/commands/chat/protect-command.js';
import { makeIntr } from '../helpers.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const GAME_CH = 'protGameCh';

function makePlayer(id: string, role: PlayerState['role'], alive = true): PlayerState {
    return {
        id,
        name: `P_${id}`,
        role,
        alive,
        protectedLastNight: false,
        lastProtectedId: null,
        selfProtectUsed: false,
    };
}

function makeGame(overrides: Partial<GameState> = {}): GameState {
    return {
        phase: 'night',
        gameNumber: 3,
        hostId: 'm1',
        guildId: 'guild1',
        players: {
            m1: makePlayer('m1', 'mafia'),
            doc: makePlayer('doc', 'doctor'),
            c1: makePlayer('c1', 'civilian'),
            c2: makePlayer('c2', 'civilian'),
        },
        readyPlayers: new Set(),
        night: createNightState(),
        vote: createVoteState(),
        mafiaChannelId: 'protMafiaCh',
        gameChannelId: GAME_CH,
        round: 1,
        phaseTimer: null,
        reminderTimer: null,
        readyTimerFired: false,
        readyMessageId: null,
        tallyMessageId: null,
        lastNightDeath: null,
        lastNightSaved: false,
        ...overrides,
    };
}

afterEach(() => {
    deleteGame(GAME_CH);
    vi.clearAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ProtectCommand', () => {
    const cmd = new ProtectCommand();

    it('rejects when used in a guild channel', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ user: { id: 'doc' }, guild: { id: 'g1' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('DM with me'));
    });

    it('rejects when user is not in any active game', async () => {
        const intr = makeIntr({ user: { id: 'nobody' }, guild: null });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(
            expect.stringContaining('not in an active game')
        );
    });

    it('rejects when phase is not night', async () => {
        const game = makeGame({ phase: 'day' });
        setGame(GAME_CH, game);
        const intr = makeIntr({ user: { id: 'doc' }, guild: null });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('night phase'));
    });

    it('rejects when user is not the doctor', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ user: { id: 'c1' }, guild: null });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('Doctor'));
    });

    it('rejects when doctor is dead', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                doc: makePlayer('doc', 'doctor', false), // dead
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ user: { id: 'doc' }, guild: null });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('Doctor'));
    });

    it('rejects duplicate protect submission in the same night', async () => {
        const game = makeGame({
            night: { ...createNightState(), actionsReceived: ['protect'] },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ user: { id: 'doc' }, guild: null });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('already submitted'));
    });

    it('rejects when target is not in the game', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ user: { id: 'doc' }, guild: null, targetUser: { id: 'nobody' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('not in this game'));
    });

    it('rejects when target is already dead', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                doc: makePlayer('doc', 'doctor'),
                c1: makePlayer('c1', 'civilian', false), // dead
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ user: { id: 'doc' }, guild: null, targetUser: { id: 'c1' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('already dead'));
    });

    it('rejects when trying to protect same person as last night', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                doc: { ...makePlayer('doc', 'doctor'), lastProtectedId: 'c1' },
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ user: { id: 'doc' }, guild: null, targetUser: { id: 'c1' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('two nights in a row'));
    });

    it('rejects self-protect when already used', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                doc: { ...makePlayer('doc', 'doctor'), selfProtectUsed: true },
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ user: { id: 'doc' }, guild: null, targetUser: { id: 'doc' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('self-protect'));
    });

    it('records protect action for a valid target', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                doc: makePlayer('doc', 'doctor'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
            },
            night: {
                ...createNightState(),
                killTarget: 'm1',
                actionsReceived: ['kill', 'investigate'],
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ user: { id: 'doc' }, guild: null, targetUser: { id: 'c1' } });
        await cmd.execute(intr as any, null as any);
        expect(game.night.protectTarget).toBe('c1');
        expect(game.night.actionsReceived).toContain('protect');
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('protect'));
    });

    it('marks selfProtectUsed when doctor self-protects for the first time', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                doc: makePlayer('doc', 'doctor'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
            },
            night: {
                ...createNightState(),
                killTarget: 'm1',
                actionsReceived: ['kill', 'investigate'],
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ user: { id: 'doc' }, guild: null, targetUser: { id: 'doc' } });
        await cmd.execute(intr as any, null as any);
        expect(game.players['doc'].selfProtectUsed).toBe(true);
    });

    it('triggers early night resolution when all actions are received', async () => {
        // All 3 actions already in except protect
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                doc: makePlayer('doc', 'doctor'),
                c1: makePlayer('c1', 'civilian'),
            },
            night: { ...createNightState(), killTarget: 'c1', actionsReceived: ['kill'] },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ user: { id: 'doc' }, guild: null, targetUser: { id: 'c1' } });
        await cmd.execute(intr as any, null as any);
        expect(resolveNight).toHaveBeenCalledWith(game, intr.client);
    });
});
