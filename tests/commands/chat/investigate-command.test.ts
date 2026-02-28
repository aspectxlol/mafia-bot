import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/index.js', () => ({
    Lang: {
        getRef: vi.fn().mockReturnValue('investigate'),
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
import { InvestigateCommand } from '../../../src/commands/chat/investigate-command.js';
import { makeIntr } from '../helpers.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const GAME_CH = 'invGameCh';

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
        gameNumber: 2,
        hostId: 'm1',
        guildId: 'guild1',
        players: {
            m1: makePlayer('m1', 'mafia'),
            det: makePlayer('det', 'detective'),
            doc: makePlayer('doc', 'doctor'),
            c1: makePlayer('c1', 'civilian'),
        },
        readyPlayers: new Set(),
        night: createNightState(),
        vote: createVoteState(),
        mafiaChannelId: 'invMafiaCh',
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

describe('InvestigateCommand', () => {
    const cmd = new InvestigateCommand();

    it('rejects when used in a guild channel (not a DM)', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        // guild is set → reject
        const intr = makeIntr({ channelId: GAME_CH, user: { id: 'det' }, guild: { id: 'g1' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('DM with me'));
    });

    it('rejects when user is not in any active game', async () => {
        // no game set → getGameByUser returns undefined
        const intr = makeIntr({ channelId: 'dmch', user: { id: 'outsider' }, guild: null });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(
            expect.stringContaining('not in an active game')
        );
    });

    it('rejects when phase is not night', async () => {
        const game = makeGame({ phase: 'day' });
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: 'dmch', user: { id: 'det' }, guild: null });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('night phase'));
    });

    it('rejects when user is not the detective', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: 'dmch', user: { id: 'c1' }, guild: null });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('Detective'));
    });

    it('rejects when detective is dead', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                det: makePlayer('det', 'detective', false), // dead
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: 'dmch', user: { id: 'det' }, guild: null });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('Detective'));
    });

    it('rejects duplicate investigation in the same night', async () => {
        const game = makeGame({
            night: { ...createNightState(), actionsReceived: ['investigate'] },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: 'dmch', user: { id: 'det' }, guild: null });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('already submitted'));
    });

    it('rejects self-investigation', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: 'dmch',
            user: { id: 'det' },
            guild: null,
            targetUser: { id: 'det' }, // same as self
        });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(
            expect.stringContaining('cannot investigate yourself')
        );
    });

    it('rejects when target is not in the game', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: 'dmch',
            user: { id: 'det' },
            guild: null,
            targetUser: { id: 'stranger99' },
        });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('not in this game'));
    });

    it('rejects when target is dead', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia', false), // dead
                det: makePlayer('det', 'detective'),
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: 'dmch',
            user: { id: 'det' },
            guild: null,
            targetUser: { id: 'm1' }, // dead target
        });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('already dead'));
    });

    it('records investigateTarget and replies with success message', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                det: makePlayer('det', 'detective'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
            },
            night: { ...createNightState(), killTarget: 'c1', actionsReceived: ['kill'] },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: 'dmch',
            user: { id: 'det' },
            guild: null,
            targetUser: { id: 'm1' },
        });
        await cmd.execute(intr as any, null as any);
        expect(game.night.investigateTarget).toBe('m1');
        expect(game.night.actionsReceived).toContain('investigate');
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('investigate'));
    });

    it('triggers early night resolution when all actions are in', async () => {
        // mafia already acted, no doctor → only needing investigate
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                det: makePlayer('det', 'detective'),
                c1: makePlayer('c1', 'civilian'),
            },
            night: { ...createNightState(), killTarget: 'c1', actionsReceived: ['kill'] },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: 'dmch',
            user: { id: 'det' },
            guild: null,
            targetUser: { id: 'm1' },
        });
        await cmd.execute(intr as any, null as any);
        expect(resolveNight).toHaveBeenCalledWith(game, intr.client);
    });

    it('does not trigger early resolution when doctor still needs to act', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                det: makePlayer('det', 'detective'),
                doc: makePlayer('doc', 'doctor'),
                c1: makePlayer('c1', 'civilian'),
            },
            night: { ...createNightState(), killTarget: 'c1', actionsReceived: ['kill'] },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: 'dmch',
            user: { id: 'det' },
            guild: null,
            targetUser: { id: 'm1' },
        });
        await cmd.execute(intr as any, null as any);
        expect(resolveNight).not.toHaveBeenCalled();
    });
});
