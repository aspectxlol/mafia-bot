/**
 * AI player support via Google Gemini and Groq (llama).
 *
 * Design: this module ONLY contains AI decision-making logic.
 * It never imports from phases.ts to avoid circular dependencies.
 * Scheduling, Discord sends, and vote resolution stay in phases.ts.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import { createRequire } from 'node:module';

import { AIProvider, GameState, PlayerState } from './gameState.js';
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

// ─── API clients ─────────────────────────────────────────────────────────────

let geminiClient: GoogleGenerativeAI | null = null;
let groqClient: Groq | null = null;

function getGemini(): GoogleGenerativeAI {
    if (!geminiClient) {
        const config = require('../../config/config.json') as { geminiApiKey?: string };
        if (!config.geminiApiKey) throw new Error('geminiApiKey not set in config/config.json');
        geminiClient = new GoogleGenerativeAI(config.geminiApiKey);
    }
    return geminiClient;
}

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
    ];
    return lines.filter(l => l !== '').join('\n');
}

const MIN_RETRY_MS = 5_000; // never retry faster than 5 s
const MAX_RETRIES = 3;

/** Parse retry-after delay in ms from a Gemini 429 error. */
function parseGeminiRetryDelay(err: unknown): number {
    if (err && typeof err === 'object') {
        const details = (err as Record<string, unknown>).errorDetails;
        if (Array.isArray(details)) {
            for (const detail of details) {
                if (
                    detail &&
                    typeof detail === 'object' &&
                    (detail as Record<string, unknown>)['@type'] ===
                        'type.googleapis.com/google.rpc.RetryInfo'
                ) {
                    const raw = (detail as Record<string, unknown>).retryDelay;
                    if (typeof raw === 'string') {
                        const seconds = parseFloat(raw);
                        if (!isNaN(seconds))
                            return Math.max(Math.ceil(seconds) * 1000, MIN_RETRY_MS);
                    }
                }
            }
        }
        const msg = (err as Record<string, unknown>).message;
        if (typeof msg === 'string') {
            const m = msg.match(/retry in ([\d.]+)s/i);
            if (m) return Math.max(Math.ceil(parseFloat(m[1])) * 1000, MIN_RETRY_MS);
        }
    }
    return 60_000;
}

/** Parse retry-after delay in ms from a Groq 429 error. */
function parseGroqRetryDelay(err: unknown): number {
    if (err && typeof err === 'object') {
        // Groq SDK attaches response headers; retry-after is in seconds
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

async function askGemini(prompt: string): Promise<string> {
    const model = getGemini().getGenerativeModel({ model: 'gemini-2.0-flash-lite' });
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const result = await model.generateContent(prompt);
            return result.response.text().trim();
        } catch (err) {
            const status = (err as Record<string, unknown>).status;
            if (status === 429 && attempt < MAX_RETRIES) {
                const delay = parseGeminiRetryDelay(err);
                Logger.warn(
                    `Gemini rate-limited (attempt ${attempt}/${MAX_RETRIES}). Retrying in ${delay / 1000}s…`,
                    err
                );
                await new Promise(res => setTimeout(res, delay));
                continue;
            }
            Logger.error('Gemini error', err);
            return '';
        }
    }
    return '';
}

async function askGroq(prompt: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const completion = await getGroq().chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 100,
                temperature: 0.8,
            });
            return completion.choices[0]?.message?.content?.trim() ?? '';
        } catch (err) {
            const status = (err as Record<string, unknown>).status;
            if (status === 429 && attempt < MAX_RETRIES) {
                const delay = parseGroqRetryDelay(err);
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

async function ask(
    context: string,
    task: string,
    provider: AIProvider = 'gemini'
): Promise<string> {
    const prompt = `${context}\n\nTASK: ${task}\n\nRespond with ONLY what is asked. No extra explanation.`;
    return provider === 'groq' ? askGroq(prompt) : askGemini(prompt);
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

    const prov = player.aiProvider ?? 'gemini';

    if (player.role === 'mafia') {
        if (game.night.actionsReceived.includes('kill')) return; // another mafia already acted
        const targets = alive.filter(p => p.role !== 'mafia' && p.id !== player.id);
        if (targets.length === 0) return;
        const raw = await ask(
            ctx,
            `It is night. Choose one Town player to eliminate. Options: ${targets.map(p => p.name).join(', ')}. Reply with only the player's exact name.`,
            prov
        );
        const target = pickFromList(raw, targets);
        game.night.killTarget = target.id;
        game.night.actionsReceived.push('kill');
        logEvent(game, `[Night ${game.round}] Mafia targeted someone for elimination`);
    } else if (player.role === 'detective') {
        if (game.night.actionsReceived.includes('investigate')) return;
        const targets = alive.filter(p => p.id !== player.id);
        if (targets.length === 0) return;
        const raw = await ask(
            ctx,
            `It is night. Choose one player to investigate. Options: ${targets.map(p => p.name).join(', ')}. Reply with only the player's exact name.`,
            prov
        );
        const target = pickFromList(raw, targets);
        game.night.investigateTarget = target.id;
        game.night.actionsReceived.push('investigate');
        const isMafia = target.role === 'mafia';
        logEvent(
            game,
            `[Night ${game.round}] Detective investigated ${target.name}: ${isMafia ? 'MAFIA' : 'not Mafia'}`
        );
    } else if (player.role === 'doctor') {
        if (game.night.actionsReceived.includes('protect')) return;
        const targets = alive.filter(p => {
            if (p.id === player.lastProtectedId && game.round > 1) return false;
            if (p.id === player.id && player.selfProtectUsed) return false;
            return true;
        });
        if (targets.length === 0) return;
        const raw = await ask(
            ctx,
            `It is night. Choose one player to protect from a Mafia kill. Options: ${targets.map(p => p.name).join(', ')}. Reply with only the player's exact name.`,
            prov
        );
        const target = pickFromList(raw, targets);
        game.night.protectTarget = target.id;
        game.night.actionsReceived.push('protect');
        if (target.id === player.id) player.selfProtectUsed = true;
        logEvent(game, `[Night ${game.round}] Doctor chose to protect someone`);
    }
}

// ─── Day message ─────────────────────────────────────────────────────────────

/** Returns a short discussion message the AI player would say during the day. */
export async function generateDayMessage(game: GameState, player: PlayerState): Promise<string> {
    const ctx = buildContext(game, player);
    const text = await ask(
        ctx,
        `It is the day discussion phase. Write ONE short message (1–2 sentences) as a player trying to figure out who the Mafia is. Be natural and conversational. Never break the fourth wall or reveal your role directly.`,
        player.aiProvider ?? 'gemini'
    );
    return text || 'Not sure who to trust right now...';
}

// ─── Vote target ─────────────────────────────────────────────────────────────

/** Returns the ID of the player the AI wants to vote for. */
export async function pickVoteTarget(game: GameState, player: PlayerState): Promise<string | null> {
    const alive = Object.values(game.players).filter(p => p.alive && p.id !== player.id);
    if (alive.length === 0) return null;
    const ctx = buildContext(game, player);
    const raw = await ask(
        ctx,
        `It is the voting phase. Vote to eliminate one player. Options: ${alive.map(p => p.name).join(', ')}. Reply with only the player's exact name.`,
        player.aiProvider ?? 'gemini'
    );
    return pickFromList(raw, alive).id;
}
