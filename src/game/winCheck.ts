import { GameState } from './gameState.js';

export type WinResult = 'town' | 'mafia' | null;

export function checkWin(game: GameState): WinResult {
    const alive = Object.values(game.players).filter(p => p.alive);
    const aliveMafia = alive.filter(p => p.role === 'mafia');
    const aliveTown = alive.filter(p => p.role !== 'mafia');

    if (aliveMafia.length === 0) return 'town';
    if (aliveMafia.length >= aliveTown.length) return 'mafia';
    return null;
}
