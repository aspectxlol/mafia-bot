import { afterEach, describe, expect, it, vi } from 'vitest';

// --- Mocks (hoist before imports) ---
vi.mock('../../../src/services/index.js', () => ({
    Lang: {
        getRef: vi.fn().mockReturnValue('kill'),
        getRefLocalizationMap: vi.fn().mockReturnValue({}),
    },
    Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    InteractionUtils: { send: vi.fn().mockResolvedValue(undefined) },
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
    getGameByMafiaChannel,
    PlayerState,
    setGame,
} from '../../../src/game/gameState.js';
import { resolveNight } from '../../../src/game/phases.js';
import { KillCommand } from '../../../src/commands/chat/kill-command.js';
import { makeIntr } from '../helpers.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const MAFIA_CH = 'mafiaChannel';
const GAME_CH = 'gameChannel';

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
        gameNumber: 1,
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
        mafiaChannelId: MAFIA_CH,
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
        playerLogs: {},
        aiTimers: [],
        ...overrides,
    };
}

afterEach(() => {
    deleteGame(GAME_CH);
    vi.clearAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('KillCommand', () => {
    const cmd = new KillCommand();

    it('rejects when not in a mafia secret channel', async () => {
        // No game mapped to this channel
        const intr = makeIntr({ channelId: 'randomChannel' });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(
            expect.stringContaining('mafia secret channel')
        );
    });

    it('rejects when game phase is not night', async () => {
        const game = makeGame({ phase: 'day' });
        setGame(GAME_CH, game);
        // make channelId = MAFIA_CH so getGameByMafiaChannel returns it
        // We'll set mafiaChannelId to MAFIA_CH and look up by MAFIA_CH
        const intr = makeIntr({ channelId: MAFIA_CH, user: { id: 'm1' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('night phase'));
    });

    it('rejects when user is not a mafia member', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: MAFIA_CH,
            user: { id: 'c1' }, // civilian
        });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('Mafia members'));
    });

    it('rejects when mafia is dead', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia', false), // dead
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: MAFIA_CH, user: { id: 'm1' } });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('Mafia members'));
    });

    it('rejects when target is not in the game', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: MAFIA_CH,
            user: { id: 'm1' },
            targetUser: { id: 'outsider99' },
        });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('not in this game'));
    });

    it('rejects when target is already dead', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian', false), // dead
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: MAFIA_CH,
            user: { id: 'm1' },
            targetUser: { id: 'c1' },
        });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('already dead'));
    });

    it('rejects self-targeting', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: MAFIA_CH,
            user: { id: 'm1' },
            targetUser: { id: 'm1' }, // same as user
        });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(
            expect.stringContaining('cannot target yourself')
        );
    });

    it('sets kill target and confirms with success message', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                det: makePlayer('det', 'detective'),
                doc: makePlayer('doc', 'doctor'),
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: MAFIA_CH,
            user: { id: 'm1' },
            targetUser: { id: 'c1' },
        });
        await cmd.execute(intr as any, null as any);
        expect(game.night.killTarget).toBe('c1');
        expect(game.night.actionsReceived).toContain('kill');
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('Kill target set'));
    });

    it('resolves night early when all actions are in', async () => {
        // Game with only mafia (no detective or doctor) — kill is the only needed action
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: MAFIA_CH,
            user: { id: 'm1' },
            targetUser: { id: 'c1' },
        });
        await cmd.execute(intr as any, null as any);
        expect(resolveNight).toHaveBeenCalledWith(game, intr.client);
    });

    it('does not resolve early when detective still needs to act', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                det: makePlayer('det', 'detective'),
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: MAFIA_CH,
            user: { id: 'm1' },
            targetUser: { id: 'c1' },
        });
        await cmd.execute(intr as any, null as any);
        expect(resolveNight).not.toHaveBeenCalled();
    });

    it('overrides a previous kill target', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
            },
            night: { ...createNightState(), killTarget: 'c2', actionsReceived: ['kill'] },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: MAFIA_CH,
            user: { id: 'm1' },
            targetUser: { id: 'c1' },
        });
        await cmd.execute(intr as any, null as any);
        expect(game.night.killTarget).toBe('c1');
        // actionsReceived should not have duplicate 'kill'
        expect(game.night.actionsReceived.filter(a => a === 'kill')).toHaveLength(1);
    });

    it('rejects when neither target user nor name is provided', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({ channelId: MAFIA_CH, user: { id: 'm1' }, noTarget: true });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('specify a target'));
    });

    it('accepts targeting an AI player by name', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                'ai:1:1': { ...makePlayer('ai:1:1', 'civilian'), name: 'Aria', isAI: true },
            },
        });
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: MAFIA_CH,
            user: { id: 'm1' },
            targetName: 'Aria',
        });
        await cmd.execute(intr as any, null as any);
        expect(game.night.killTarget).toBe('ai:1:1');
        expect(game.night.actionsReceived).toContain('kill');
    });

    it('rejects unknown name for AI targeting', async () => {
        const game = makeGame();
        setGame(GAME_CH, game);
        const intr = makeIntr({
            channelId: MAFIA_CH,
            user: { id: 'm1' },
            targetName: 'NoSuchPlayer',
        });
        await cmd.execute(intr as any, null as any);
        expect(intr.editReply).toHaveBeenCalledWith(expect.stringContaining('No player named'));
    });
});
