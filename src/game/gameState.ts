export type Role = 'mafia' | 'detective' | 'doctor' | 'civilian';
export type Phase = 'lobby' | 'night' | 'day' | 'vote' | 'ended';

export interface PlayerState {
    id: string;
    name: string;
    role: Role;
    alive: boolean;
    protectedLastNight: boolean;
    lastProtectedId: string | null; // id of player protected last night
    selfProtectUsed: boolean;
}

export interface NightState {
    killTarget: string | null;
    protectTarget: string | null;
    investigateTarget: string | null;
    actionsReceived: string[]; // 'kill' | 'protect' | 'investigate'
}

export interface VoteState {
    votes: Record<string, string>; // voterId -> targetId
    tally: Record<string, number>;
}

export interface GameState {
    phase: Phase;
    gameNumber: number;
    hostId: string;
    guildId: string;
    players: Record<string, PlayerState>;
    readyPlayers: Set<string>;
    night: NightState;
    vote: VoteState;
    mafiaChannelId: string | null;
    gameChannelId: string;
    round: number;
    phaseTimer: ReturnType<typeof setTimeout> | null;
    reminderTimer: ReturnType<typeof setTimeout> | null;
    readyTimerFired: boolean;
    readyMessageId: string | null;
    tallyMessageId: string | null;
    lastNightDeath: string | null; // userId of player killed last night
    lastNightSaved: boolean; // true if doctor prevented a kill
}

let gameCounter = 0;
const games = new Map<string, GameState>();

export function getNextGameNumber(): number {
    return ++gameCounter;
}

export function getGame(channelId: string): GameState | undefined {
    return games.get(channelId);
}

export function setGame(channelId: string, state: GameState): void {
    games.set(channelId, state);
}

export function deleteGame(channelId: string): void {
    games.delete(channelId);
}

export function getGameByMafiaChannel(mafiaChannelId: string): GameState | undefined {
    for (const game of games.values()) {
        if (game.mafiaChannelId === mafiaChannelId) return game;
    }
    return undefined;
}

export function getGameByUser(userId: string): GameState | undefined {
    for (const game of games.values()) {
        if (game.players[userId] && game.phase !== 'ended') return game;
    }
    return undefined;
}

export function getAllGames(): GameState[] {
    return [...games.values()];
}

export function createNightState(): NightState {
    return {
        killTarget: null,
        protectTarget: null,
        investigateTarget: null,
        actionsReceived: [],
    };
}

export function createVoteState(): VoteState {
    return { votes: {}, tally: {} };
}

export function clearTimers(game: GameState): void {
    if (game.phaseTimer) {
        clearTimeout(game.phaseTimer);
        game.phaseTimer = null;
    }
    if (game.reminderTimer) {
        clearTimeout(game.reminderTimer);
        game.reminderTimer = null;
    }
}
