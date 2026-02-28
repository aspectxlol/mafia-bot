import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Logger before any imports that use it
vi.mock('../../src/services/index.js', () => ({
    Logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
    },
}));

// Mock config files
vi.mock('../../config/config.json', () => ({}));
vi.mock('../../config/debug.json', () => ({}));
vi.mock('../../lang/logs.json', () => ({}));

import {
    createNightState,
    createVoteState,
    deleteGame,
    GameState,
    getGame,
    PlayerState,
    setGame,
} from '../../src/game/gameState.js';
import { endGame, resolveNight, resolveVote } from '../../src/game/phases.js';

// ── Shared Discord mock helpers ────────────────────────────────────────────────

function makeMockMessage(id = 'msg1') {
    return {
        id,
        edit: vi.fn().mockResolvedValue(undefined),
    };
}

function makeMockChannel(
    id = 'ch1',
    messages?: Record<string, ReturnType<typeof makeMockMessage>>
) {
    const msgMap = messages ?? {};
    return {
        id,
        guild: {
            roles: { everyone: { id: 'everyoneRole' } },
            id: 'guild1',
        },
        send: vi.fn().mockResolvedValue(makeMockMessage()),
        messages: {
            fetch: vi
                .fn()
                .mockImplementation((msgId: string) => Promise.resolve(msgMap[msgId] ?? null)),
        },
        permissionOverwrites: {
            set: vi.fn().mockResolvedValue(undefined),
        },
        setTopic: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
    };
}

function makeMockClient(channelMap: Record<string, ReturnType<typeof makeMockChannel>> = {}) {
    return {
        user: { id: 'botUser' },
        channels: {
            fetch: vi
                .fn()
                .mockImplementation((id: string) => Promise.resolve(channelMap[id] ?? null)),
        },
        guilds: {
            fetch: vi.fn().mockRejectedValue(new Error('no guild in tests')),
        },
        users: {
            fetch: vi.fn().mockResolvedValue({
                send: vi.fn().mockResolvedValue(undefined),
            }),
        },
    };
}

// ── Player / GameState helpers ────────────────────────────────────────────────

function makePlayer(id: string, role: PlayerState['role'], alive = true): PlayerState {
    return {
        id,
        name: `Player_${id}`,
        role,
        alive,
        protectedLastNight: false,
        lastProtectedId: null,
        selfProtectUsed: false,
    };
}

const GAME_CH = 'gameChannel';
const MAFIA_CH = 'mafiaChannel';

function makeGame(overrides: Partial<GameState> = {}): GameState {
    return {
        phase: 'night',
        gameNumber: 1,
        hostId: 'm1',
        guildId: 'guild1',
        players: {},
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
        ...overrides,
    };
}

// ── resolveNight ──────────────────────────────────────────────────────────────

describe('resolveNight', () => {
    let channel: ReturnType<typeof makeMockChannel>;
    let client: ReturnType<typeof makeMockClient>;

    beforeEach(() => {
        channel = makeMockChannel(GAME_CH);
        client = makeMockClient({ [GAME_CH]: channel });
    });

    afterEach(() => {
        deleteGame(GAME_CH);
        vi.clearAllMocks();
    });

    it('kills the kill target when not protected', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
            },
            night: { ...createNightState(), killTarget: 'c1', actionsReceived: ['kill'] },
        });
        setGame(GAME_CH, game);

        await resolveNight(game, client as any);

        expect(game.players['c1'].alive).toBe(false);
        expect(game.lastNightDeath).toBe('c1');
        expect(game.lastNightSaved).toBe(false);
    });

    it('saves the kill target when protected by doctor', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                doc: makePlayer('doc', 'doctor'),
                c1: makePlayer('c1', 'civilian'),
            },
            night: {
                ...createNightState(),
                killTarget: 'c1',
                protectTarget: 'c1',
                actionsReceived: ['kill', 'protect'],
            },
        });
        setGame(GAME_CH, game);

        await resolveNight(game, client as any);

        expect(game.players['c1'].alive).toBe(true);
        expect(game.lastNightSaved).toBe(true);
        expect(game.lastNightDeath).toBeNull();
    });

    it('does not kill anyone when no kill target is set', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
            },
            night: { ...createNightState(), actionsReceived: [] },
        });
        setGame(GAME_CH, game);

        await resolveNight(game, client as any);

        expect(game.players['c1'].alive).toBe(true);
        expect(game.players['c2'].alive).toBe(true);
        expect(game.lastNightDeath).toBeNull();
        expect(game.lastNightSaved).toBe(false);
    });

    it('kills the target even if doctor chose a different target', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                doc: makePlayer('doc', 'doctor'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
            },
            night: {
                ...createNightState(),
                killTarget: 'c1',
                protectTarget: 'c2', // protected wrong person
                actionsReceived: ['kill', 'protect'],
            },
        });
        setGame(GAME_CH, game);

        await resolveNight(game, client as any);

        expect(game.players['c1'].alive).toBe(false);
        expect(game.players['c2'].alive).toBe(true);
        expect(game.lastNightDeath).toBe('c1');
        expect(game.lastNightSaved).toBe(false);
    });

    it('updates the doctor lastProtectedId after resolution', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                doc: makePlayer('doc', 'doctor'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
            },
            night: {
                ...createNightState(),
                killTarget: 'c1',
                protectTarget: 'c2',
                actionsReceived: ['kill', 'protect'],
            },
        });
        setGame(GAME_CH, game);

        await resolveNight(game, client as any);

        expect(game.players['doc'].lastProtectedId).toBe('c2');
        expect(game.players['doc'].protectedLastNight).toBe(true);
    });

    it('sets protectedLastNight to false when no protect action', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                doc: makePlayer('doc', 'doctor'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
            },
            night: {
                ...createNightState(),
                killTarget: 'c1',
                protectTarget: null,
                actionsReceived: ['kill'],
            },
        });
        setGame(GAME_CH, game);

        await resolveNight(game, client as any);

        expect(game.players['doc'].protectedLastNight).toBe(false);
        expect(game.players['doc'].lastProtectedId).toBeNull();
    });

    it('sends a DM to the detective with investigation result (mafia)', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                det: makePlayer('det', 'detective'),
                c1: makePlayer('c1', 'civilian'),
            },
            night: {
                ...createNightState(),
                investigateTarget: 'm1',
                actionsReceived: ['investigate'],
            },
        });
        setGame(GAME_CH, game);

        await resolveNight(game, client as any);

        expect(client.users.fetch).toHaveBeenCalledWith('det');
    });

    it('ends the game if the last mafia was saved (still win for mafia)', async () => {
        // 1 mafia, 1 civilian — after kill attempt on civilian, if not protected, mafia wins
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
            },
            night: {
                ...createNightState(),
                killTarget: 'c1',
                actionsReceived: ['kill'],
            },
        });
        setGame(GAME_CH, game);

        await resolveNight(game, client as any);

        // c1 is now dead; 1 mafia vs 0 town → mafia wins → game.phase = 'ended'
        expect(game.phase).toBe('ended');
    });

    it('proceeds to day when game still continues after night', async () => {
        // 1 mafia, 3 civilians — after kill, 1 mafia vs 2 civilians → game continues
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
                c3: makePlayer('c3', 'civilian'),
            },
            night: {
                ...createNightState(),
                killTarget: 'c1',
                actionsReceived: ['kill'],
            },
        });
        setGame(GAME_CH, game);

        await resolveNight(game, client as any);

        expect(game.phase).toBe('day');
    });
});

// ── resolveVote ───────────────────────────────────────────────────────────────

describe('resolveVote', () => {
    let channel: ReturnType<typeof makeMockChannel>;
    let client: ReturnType<typeof makeMockClient>;

    beforeEach(() => {
        channel = makeMockChannel(GAME_CH);
        client = makeMockClient({ [GAME_CH]: channel });
    });

    afterEach(() => {
        deleteGame(GAME_CH);
        vi.clearAllMocks();
    });

    it('eliminates the player with the most votes', async () => {
        const game = makeGame({
            phase: 'vote',
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
                c3: makePlayer('c3', 'civilian'),
            },
            vote: {
                votes: { c1: 'm1', c2: 'm1', c3: 'c2' }, // m1 gets 2 votes
                tally: { m1: 2, c2: 1 },
            },
        });
        setGame(GAME_CH, game);

        await resolveVote(game, client as any);

        expect(game.players['m1'].alive).toBe(false);
    });

    it('eliminates the correct player when one has most votes', async () => {
        const game = makeGame({
            phase: 'vote',
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
            },
            vote: {
                votes: { c1: 'c2', m1: 'c2' }, // c2 gets 2 votes
                tally: { c2: 2 },
            },
        });
        setGame(GAME_CH, game);

        await resolveVote(game, client as any);

        expect(game.players['c2'].alive).toBe(false);
        expect(game.players['m1'].alive).toBe(true);
        expect(game.players['c1'].alive).toBe(true);
    });

    it('eliminates no one when there are no votes', async () => {
        const game = makeGame({
            phase: 'vote',
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
            },
            vote: { votes: {}, tally: {} },
        });
        setGame(GAME_CH, game);

        await resolveVote(game, client as any);

        // Everyone still alive
        expect(game.players['m1'].alive).toBe(true);
        expect(game.players['c1'].alive).toBe(true);
        expect(game.players['c2'].alive).toBe(true);
    });

    it('does not eliminate anyone on a tie', async () => {
        const game = makeGame({
            phase: 'vote',
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
                c3: makePlayer('c3', 'civilian'),
            },
            vote: {
                votes: { c1: 'm1', c2: 'c3' }, // tie: m1 and c3 each get 1 vote
                tally: { m1: 1, c3: 1 },
            },
        });
        setGame(GAME_CH, game);

        await resolveVote(game, client as any);

        expect(game.players['m1'].alive).toBe(true);
        expect(game.players['c3'].alive).toBe(true);
    });

    it('ends the game when elimination triggers win condition (town wins)', async () => {
        // Only mafia left after eliminating last civilian — wait, that's mafia win.
        // Town wins: last mafia eliminated by vote
        const game = makeGame({
            phase: 'vote',
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
            },
            vote: {
                votes: { c1: 'm1', c2: 'm1' }, // m1 gets 2 votes
                tally: { m1: 2 },
            },
        });
        setGame(GAME_CH, game);

        await resolveVote(game, client as any);

        expect(game.players['m1'].alive).toBe(false);
        expect(game.phase).toBe('ended');
    });

    it('proceeds to night phase when game continues after vote', async () => {
        const game = makeGame({
            phase: 'vote',
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
                c3: makePlayer('c3', 'civilian'),
            },
            vote: {
                votes: { c1: 'c3', c2: 'c3' }, // c3 eliminated
                tally: { c3: 2 },
            },
        });
        setGame(GAME_CH, game);

        await resolveVote(game, client as any);

        // c3 dead, 1 mafia vs 2 civilians → continue
        expect(game.players['c3'].alive).toBe(false);
        expect(game.phase).toBe('night');
    });

    it('increments the round number when proceeding to next night', async () => {
        const game = makeGame({
            phase: 'vote',
            round: 1,
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
                c3: makePlayer('c3', 'civilian'),
            },
            vote: {
                votes: { c1: 'c3', c2: 'c3' },
                tally: { c3: 2 },
            },
        });
        setGame(GAME_CH, game);

        await resolveVote(game, client as any);

        expect(game.round).toBe(2);
    });

    it('sends a tie message when tied', async () => {
        const game = makeGame({
            phase: 'vote',
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
                c2: makePlayer('c2', 'civilian'),
            },
            vote: {
                votes: { m1: 'c1', c2: 'm1' },
                tally: { c1: 1, m1: 1 },
            },
        });
        setGame(GAME_CH, game);

        await resolveVote(game, client as any);

        expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('tie'));
    });
});

// ── endGame ───────────────────────────────────────────────────────────────────

describe('endGame', () => {
    let channel: ReturnType<typeof makeMockChannel>;
    let mafiaChannel: ReturnType<typeof makeMockChannel>;
    let client: ReturnType<typeof makeMockClient>;

    beforeEach(() => {
        channel = makeMockChannel(GAME_CH);
        mafiaChannel = makeMockChannel(MAFIA_CH);
        client = makeMockClient({ [GAME_CH]: channel, [MAFIA_CH]: mafiaChannel });
    });

    afterEach(() => {
        deleteGame(GAME_CH);
        vi.clearAllMocks();
    });

    it('sets game.phase to "ended"', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);

        await endGame(game, client as any, 'town');

        expect(game.phase).toBe('ended');
    });

    it('removes the game from the store', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);

        await endGame(game, client as any, 'mafia');

        expect(getGame(GAME_CH)).toBeUndefined();
    });

    it('sends an embed to the game channel', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);

        await endGame(game, client as any, 'town');

        expect(channel.send).toHaveBeenCalled();
    });

    it('deletes the mafia channel when it exists', async () => {
        const game = makeGame({
            mafiaChannelId: MAFIA_CH,
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);

        await endGame(game, client as any, 'town');

        expect(mafiaChannel.delete).toHaveBeenCalled();
    });

    it('does not throw when there is no mafia channel', async () => {
        const game = makeGame({
            mafiaChannelId: null,
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);

        await expect(endGame(game, client as any, 'town')).resolves.not.toThrow();
    });

    it('clears all timers on end', async () => {
        const phaseTimer = setTimeout(() => {}, 99999);
        const reminderTimer = setTimeout(() => {}, 99999);
        const game = makeGame({
            phaseTimer,
            reminderTimer,
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian'),
            },
        });
        setGame(GAME_CH, game);

        await endGame(game, client as any, 'town');

        expect(game.phaseTimer).toBeNull();
        expect(game.reminderTimer).toBeNull();
    });

    it('handles a "mafia" winner correctly (sends embed)', async () => {
        const game = makeGame({
            players: {
                m1: makePlayer('m1', 'mafia'),
                c1: makePlayer('c1', 'civilian', false),
            },
        });
        setGame(GAME_CH, game);

        await endGame(game, client as any, 'mafia');

        expect(game.phase).toBe('ended');
        expect(channel.send).toHaveBeenCalled();
    });
});
