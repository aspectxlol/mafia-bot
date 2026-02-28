import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/game/phases.js', () => ({
    launchGame: vi.fn().mockResolvedValue(undefined),
    sendDM: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/services/index.js', () => ({
    Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
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
import { launchGame } from '../../src/game/phases.js';
import { ReadyButton } from '../../src/buttons/ready-button.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const GAME_CH = 'readyBtnCh';

function makePlayer(id: string): PlayerState {
    return {
        id,
        name: `P_${id}`,
        role: 'civilian',
        alive: true,
        isAI: false,
        protectedLastNight: false,
        lastProtectedId: null,
        selfProtectUsed: false,
    };
}

function makeGame(playerIds: string[], overrides: Partial<GameState> = {}): GameState {
    const players: Record<string, PlayerState> = {};
    for (const id of playerIds) players[id] = makePlayer(id);
    return {
        phase: 'lobby',
        gameNumber: 7,
        hostId: playerIds[0],
        guildId: 'guild1',
        players,
        readyPlayers: new Set(),
        night: createNightState(),
        vote: createVoteState(),
        mafiaChannelId: null,
        gameChannelId: GAME_CH,
        round: 0,
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

function makeButtonIntr(customId: string, userId: string, overrides: Record<string, unknown> = {}) {
    return {
        customId,
        user: { id: userId },
        reply: vi.fn().mockResolvedValue(undefined),
        client: {
            user: { id: 'botUser' },
            channels: { fetch: vi.fn().mockResolvedValue(null) },
        },
        channel: {
            messages: {
                fetch: vi.fn().mockResolvedValue(new Map()),
            },
            permissionOverwrites: {
                delete: vi.fn().mockResolvedValue(undefined),
            },
        },
        ...overrides,
    };
}

afterEach(() => {
    deleteGame(GAME_CH);
    vi.clearAllMocks();
});

// ── ReadyButton ───────────────────────────────────────────────────────────────

describe('ReadyButton – ready action', () => {
    const btn = new ReadyButton();

    it('has ids ["ready", "forcestart"]', () => {
        expect(btn.ids).toContain('ready');
        expect(btn.ids).toContain('forcestart');
    });

    it('rejects when no game is active', async () => {
        const intr = makeButtonIntr(`ready:${GAME_CH}`, 'p1');
        await btn.execute(intr as any, null as any);
        expect(intr.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('No active lobby') })
        );
    });

    it('rejects when game is not in lobby phase', async () => {
        const game = makeGame(['p1', 'p2', 'p3', 'p4', 'p5'], { phase: 'night' });
        setGame(GAME_CH, game);
        const intr = makeButtonIntr(`ready:${GAME_CH}`, 'p1');
        await btn.execute(intr as any, null as any);
        expect(intr.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('No active lobby') })
        );
    });

    it('rejects when user is not in the game', async () => {
        const game = makeGame(['p1', 'p2', 'p3', 'p4', 'p5']);
        setGame(GAME_CH, game);
        const intr = makeButtonIntr(`ready:${GAME_CH}`, 'outsider99');
        await btn.execute(intr as any, null as any);
        expect(intr.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('not in this game') })
        );
    });

    it('adds the player to readyPlayers when they click ready', async () => {
        const game = makeGame(['p1', 'p2', 'p3', 'p4', 'p5']);
        setGame(GAME_CH, game);
        const intr = makeButtonIntr(`ready:${GAME_CH}`, 'p1');
        await btn.execute(intr as any, null as any);
        expect(game.readyPlayers.has('p1')).toBe(true);
    });

    it('replies with ready count after clicking ready', async () => {
        const game = makeGame(['p1', 'p2', 'p3', 'p4', 'p5']);
        setGame(GAME_CH, game);
        const intr = makeButtonIntr(`ready:${GAME_CH}`, 'p1');
        await btn.execute(intr as any, null as any);
        expect(intr.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('1/5') })
        );
    });

    it('does not launch game until all players are ready', async () => {
        const game = makeGame(['p1', 'p2', 'p3', 'p4', 'p5']);
        setGame(GAME_CH, game);
        const intr = makeButtonIntr(`ready:${GAME_CH}`, 'p1');
        await btn.execute(intr as any, null as any);
        expect(launchGame).not.toHaveBeenCalled();
    });

    it('launches the game when all 5 players are ready', async () => {
        const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
        const game = makeGame(ids);
        // Pre-ready 4 players
        for (const id of ids.slice(0, 4)) game.readyPlayers.add(id);
        setGame(GAME_CH, game);

        const intr = makeButtonIntr(`ready:${GAME_CH}`, 'p5');
        await btn.execute(intr as any, null as any);
        expect(game.readyPlayers.size).toBe(5);
        expect(launchGame).toHaveBeenCalledWith(game, intr.client);
    });

    it('second ready click from same player is idempotent (Set)', async () => {
        const game = makeGame(['p1', 'p2', 'p3', 'p4', 'p5']);
        setGame(GAME_CH, game);
        const intr1 = makeButtonIntr(`ready:${GAME_CH}`, 'p1');
        const intr2 = makeButtonIntr(`ready:${GAME_CH}`, 'p1');
        await btn.execute(intr1 as any, null as any);
        await btn.execute(intr2 as any, null as any);
        expect(game.readyPlayers.size).toBe(1); // Set deduplication
    });
});

describe('ReadyButton – forcestart action', () => {
    const btn = new ReadyButton();

    it('rejects when non-host tries to force start', async () => {
        const game = makeGame(['host', 'p2', 'p3', 'p4', 'p5']);
        setGame(GAME_CH, game);
        const intr = makeButtonIntr(`forcestart:${GAME_CH}`, 'p2'); // p2 is not host
        await btn.execute(intr as any, null as any);
        expect(intr.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('host') })
        );
    });

    it('cancels game when after removing unready players fewer than 5 remain', async () => {
        const ids = ['host', 'p2', 'p3', 'p4', 'p5'];
        const game = makeGame(ids);
        // Only host is ready; unready: p2, p3, p4, p5 → remove them → 1 player left
        game.readyPlayers.add('host');
        setGame(GAME_CH, game);
        const intr = makeButtonIntr(`forcestart:${GAME_CH}`, 'host');
        await btn.execute(intr as any, null as any);
        expect(intr.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('minimum 5') })
        );
        expect(getGame(GAME_CH)).toBeUndefined(); // Game cancelled
    });

    it('removes unready players from game.players', async () => {
        const ids = ['host', 'p2', 'p3', 'p4', 'p5', 'p6'];
        const game = makeGame(ids);
        // Ready: host, p2, p3, p4, p5 (5 players); unready: p6
        for (const id of ids.slice(0, 5)) game.readyPlayers.add(id);
        setGame(GAME_CH, game);
        const intr = makeButtonIntr(`forcestart:${GAME_CH}`, 'host');
        await btn.execute(intr as any, null as any);
        expect(game.players['p6']).toBeUndefined();
    });

    it('launches the game with ready players when minimum met', async () => {
        const ids = ['host', 'p2', 'p3', 'p4', 'p5', 'p6'];
        const game = makeGame(ids);
        // 5 ready, 1 unready
        for (const id of ids.slice(0, 5)) game.readyPlayers.add(id);
        setGame(GAME_CH, game);
        const intr = makeButtonIntr(`forcestart:${GAME_CH}`, 'host');
        await btn.execute(intr as any, null as any);
        expect(launchGame).toHaveBeenCalledWith(game, intr.client);
    });

    it('replies with force start message before launching', async () => {
        const ids = ['host', 'p2', 'p3', 'p4', 'p5'];
        const game = makeGame(ids);
        for (const id of ids) game.readyPlayers.add(id);
        setGame(GAME_CH, game);
        const intr = makeButtonIntr(`forcestart:${GAME_CH}`, 'host');
        await btn.execute(intr as any, null as any);
        expect(intr.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining('Force starting') })
        );
    });
});
