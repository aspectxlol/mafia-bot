/**
 * AI player support via Groq (multiple models for variety).
 *
 * Design: this module ONLY contains AI decision-making logic.
 * It never imports from phases.ts to avoid circular dependencies.
 * Scheduling, Discord sends, and vote resolution stay in phases.ts.
 */

import Groq from 'groq-sdk';
import { createRequire } from 'node:module';

import { GameState, PlayerState } from './gameState.js';
import { Logger } from '../services/index.js';

const require = createRequire(import.meta.url);

// ─── AI player identity ──────────────────────────────────────────────────────

export const AI_NAMES = [
    'Aria',
    'Morgan',
    'Riley',
    'Casey',
    'Drew',
    'Jamie',
    'Quinn',
    'Taylor',
    'Avery',
    'Jordan',
];

export function newAIId(gameNumber: number, index: number): string {
    return `ai:${gameNumber}:${index}`;
}

export function isAIId(id: string): boolean {
    return id.startsWith('ai:');
}

// ─── Game log (stored on GameState for AI context) ───────────────────────────

export function logEvent(game: GameState, event: string): void {
    game.gameLog.push(event);
    if (game.gameLog.length > 30) game.gameLog.splice(0, game.gameLog.length - 30);
}

// ─── Model rotation ──────────────────────────────────────────────────────────

const AI_MODELS = [
    'qwen/qwen3-32b',
    'moonshotai/kimi-k2-instruct',
    'meta-llama/llama-3.3-70b-versatile',
] as const;

/** Assign a consistent model to a player based on their ID. */
function pickModel(player: PlayerState): string {
    const hash = player.id.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    return AI_MODELS[hash % AI_MODELS.length];
}

// ─── Groq client ─────────────────────────────────────────────────────────────

let groqClient: Groq | null = null;

function getGroq(): Groq {
    if (!groqClient) {
        const config = require('../../config/config.json') as { groqApiKey?: string };
        if (!config.groqApiKey) throw new Error('groqApiKey not set in config/config.json');
        groqClient = new Groq({ apiKey: config.groqApiKey });
    }
    return groqClient;
}

// ─── Prompt helpers ──────────────────────────────────────────────────────────

function buildContext(game: GameState, player: PlayerState): string {
    const alive = Object.values(game.players).filter(p => p.alive);
    const dead = Object.values(game.players).filter(p => !p.alive);
    const mafiaTeamNames =
        player.role === 'mafia'
            ? Object.values(game.players)
                  .filter(p => p.role === 'mafia' && p.id !== player.id)
                  .map(p => p.name)
            : [];

    const lines = [
        `You are ${player.name}, playing Mafia (a social deduction game). Game round: ${game.round}.`,
        `YOUR ROLE: ${player.role.toUpperCase()}`,
        player.role === 'mafia'
            ? `Your mafia teammates: ${mafiaTeamNames.join(', ') || 'none (you are solo Mafia)'}`
            : '',
        `WIN CONDITION: ${player.role === 'mafia' ? 'Mafia equals or outnumbers Town' : 'Eliminate all Mafia members'}`,
        '',
        `ALIVE (${alive.length}): ${alive.map(p => p.name).join(', ')}`,
        dead.length > 0
            ? `ELIMINATED: ${dead.map(p => `${p.name} (was ${p.role})`).join(', ')}`
            : '',
        '',
        'RECENT EVENTS:',
        game.gameLog.slice(-12).join('\n') || 'Game just started.',
        ...(game.playerLogs[player.id]?.length
            ? ['', 'YOUR PRIVATE NOTES:', ...game.playerLogs[player.id].slice(-6)]
            : []),
    ];
    return lines.filter(l => l !== '').join('\n');
}

const MIN_RETRY_MS = 5_000; // never retry faster than 5 s
const MAX_RETRIES = 3;

/** Parse retry-after delay in ms from a Groq 429 error. */
function parseRetryDelay(err: unknown): number {
    if (err && typeof err === 'object') {
        const headers = (err as Record<string, unknown>).headers;
        if (headers && typeof headers === 'object') {
            const ra = (headers as Record<string, unknown>)['retry-after'];
            if (typeof ra === 'string') {
                const seconds = parseFloat(ra);
                if (!isNaN(seconds)) return Math.max(Math.ceil(seconds) * 1000, MIN_RETRY_MS);
            }
        }
        const msg = (err as Record<string, unknown>).message;
        if (typeof msg === 'string') {
            const m = msg.match(/retry.after (\d+)/i) || msg.match(/retry in ([\d.]+)s/i);
            if (m) return Math.max(Math.ceil(parseFloat(m[1])) * 1000, MIN_RETRY_MS);
        }
    }
    return 60_000;
}

async function ask(context: string, task: string, model: string): Promise<string> {
    const prompt = `${context}\n\nTASK: ${task}\n\nRespond with ONLY what is asked. No extra explanation.`;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const completion = await getGroq().chat.completions.create({
                model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 100,
                temperature: 0.8,
            });
            const raw = (completion.choices[0]?.message?.content ?? '')
                .replace(/<think>[\s\S]*?<\/think>/gi, '')
                .trim();
            return raw;
        } catch (err) {
            const status = (err as Record<string, unknown>).status;
            if (status === 429 && attempt < MAX_RETRIES) {
                const delay = parseRetryDelay(err);
                Logger.warn(
                    `Groq rate-limited (attempt ${attempt}/${MAX_RETRIES}). Retrying in ${delay / 1000}s…`,
                    err
                );
                await new Promise(res => setTimeout(res, delay));
                continue;
            }
            Logger.error('Groq error', err);
            return '';
        }
    }
    return '';
}

function pickFromList<T extends { name: string }>(raw: string, candidates: T[]): T {
    const lower = raw.toLowerCase();
    return (
        candidates.find(
            p => p.name.toLowerCase() === lower || lower.includes(p.name.toLowerCase())
        ) ?? candidates[Math.floor(Math.random() * candidates.length)]
    );
}

// ─── Night action ────────────────────────────────────────────────────────────

/**
 * Fills in game.night.* for a single AI player's role.
 * Safe to call concurrently for multiple AI players (guards against double-acting).
 */
export async function runAINightAction(game: GameState, player: PlayerState): Promise<void> {
    const alive = Object.values(game.players).filter(p => p.alive);
    const ctx = buildContext(game, player);

    const model = pickModel(player);

    if (player.role === 'mafia') {
        if (game.night.actionsReceived.includes('kill')) return;
        const targets = alive.filter(p => p.role !== 'mafia' && p.id !== player.id);
        if (targets.length === 0) return;
        console.log(
            `[AI] ${player.name} (mafia, ${model}) choosing kill target from: ${targets.map(p => p.name).join(', ')}`
        );
        const raw = await ask(
            ctx,
            `It is night. Choose one Town player to eliminate. Options: ${targets.map(p => p.name).join(', ')}. Reply with only the player's exact name.`,
            model
        );
        const target = pickFromList(raw, targets);
        console.log(`[AI] ${player.name} chose to eliminate ${target.name}`);
        game.night.killTarget = target.id;
        game.night.actionsReceived.push('kill');
    } else if (player.role === 'detective') {
        if (game.night.actionsReceived.includes('investigate')) return;
        const targets = alive.filter(p => p.id !== player.id);
        if (targets.length === 0) return;
        console.log(
            `[AI] ${player.name} (detective, ${model}) choosing investigate target from: ${targets.map(p => p.name).join(', ')}`
        );
        const raw = await ask(
            ctx,
            `It is night. Choose one player to investigate. Options: ${targets.map(p => p.name).join(', ')}. Reply with only the player's exact name.`,
            model
        );
        const target = pickFromList(raw, targets);
        const isMafia = target.role === 'mafia';
        console.log(
            `[AI] ${player.name} investigated ${target.name} → ${isMafia ? 'MAFIA' : 'innocent'}`
        );
        game.night.investigateTarget = target.id;
        game.night.actionsReceived.push('investigate');
        (game.playerLogs[player.id] ??= []).push(
            `[Night ${game.round}] You investigated ${target.name}: ${isMafia ? 'MAFIA' : 'not Mafia'}`
        );
    } else if (player.role === 'doctor') {
        if (game.night.actionsReceived.includes('protect')) return;
        const targets = alive.filter(p => {
            if (p.id === player.lastProtectedId && game.round > 1) return false;
            if (p.id === player.id && player.selfProtectUsed) return false;
            return true;
        });
        if (targets.length === 0) return;
        console.log(
            `[AI] ${player.name} (doctor, ${model}) choosing protect target from: ${targets.map(p => p.name).join(', ')}`
        );
        const raw = await ask(
            ctx,
            `It is night. Choose one player to protect from a Mafia kill. Options: ${targets.map(p => p.name).join(', ')}. Reply with only the player's exact name.`,
            model
        );
        const target = pickFromList(raw, targets);
        console.log(`[AI] ${player.name} chose to protect ${target.name}`);
        game.night.protectTarget = target.id;
        game.night.actionsReceived.push('protect');
        if (target.id === player.id) player.selfProtectUsed = true;
    }
}

// ─── Day message ─────────────────────────────────────────────────────────────

/** Returns a short discussion message the AI player would say during the day. */
export async function generateDayMessage(game: GameState, player: PlayerState): Promise<string> {
    const model = pickModel(player);
    const ctx = buildContext(game, player);
    console.log(`[AI] ${player.name} (${player.role}, ${model}) generating day message`);
    const text = await ask(
        ctx,
        `It is the day discussion phase. Write ONE short message (1–2 sentences) as a player trying to figure out who the Mafia is. Be natural and conversational. Never break the fourth wall or reveal your role directly.`,
        model
    );
    console.log(`[AI] ${player.name} says: "${text || '(empty, using fallback)'}"`);
    return text || 'Not sure who to trust right now...';
}

// ─── Vote target ─────────────────────────────────────────────────────────────

/** Returns the ID of the player the AI wants to vote for. */
export async function pickVoteTarget(game: GameState, player: PlayerState): Promise<string | null> {
    const alive = Object.values(game.players).filter(p => p.alive && p.id !== player.id);
    if (alive.length === 0) return null;
    const model = pickModel(player);
    const ctx = buildContext(game, player);
    console.log(
        `[AI] ${player.name} (${player.role}, ${model}) voting from: ${alive.map(p => p.name).join(', ')}`
    );
    const raw = await ask(
        ctx,
        `It is the voting phase. Vote to eliminate one player. Options: ${alive.map(p => p.name).join(', ')}. Reply with only the player's exact name.`,
        model
    );
    const target = pickFromList(raw, alive);
    console.log(`[AI] ${player.name} votes to eliminate ${target.name}`);
    return target.id;
}
