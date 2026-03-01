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
    'moonshotai/kimi-k2-instruct-0905',
    'llama-3.3-70b-versatile',
] as const;

type AIPersonality = {
    name: string;
    style: string;
    voting: string;
    strategy: string;
};

const AI_PERSONALITIES: readonly AIPersonality[] = [
    {
        name: 'Shy',
        style: 'Quiet, cautious, and concise. Avoids strong accusations unless evidence is clear.',
        voting: 'Prefers safer, consensus-aligned votes unless strongly convinced.',
        strategy: 'Plays low-risk and avoids attracting attention.',
    },
    {
        name: 'Interrogative',
        style: 'Asks probing questions and challenges contradictions directly.',
        voting: 'Votes based on suspicious inconsistencies and weak explanations.',
        strategy: 'Pressures others to reveal information through questioning.',
    },
    {
        name: 'Bad Liar',
        style: 'Can bluff, but bluffs are awkward and sometimes over-explained.',
        voting: 'May make slightly inconsistent choices under pressure.',
        strategy: 'Attempts deception but struggles to maintain perfect consistency.',
    },
    {
        name: 'Analytical',
        style: 'Structured and logical; references patterns and process of elimination.',
        voting: 'Prioritizes probability and prior behavior over emotion.',
        strategy: 'Builds incremental cases from known public facts.',
    },
    {
        name: 'Impulsive',
        style: 'Quick to react, emotional tone, sometimes jumps to conclusions.',
        voting: 'Can pivot votes rapidly when new claims appear.',
        strategy: 'High-variance choices that can create chaos.',
    },
    {
        name: 'Diplomatic',
        style: 'Calm and cooperative; de-escalates conflict and avoids hard pushes.',
        voting: 'Looks for compromise targets to keep town aligned.',
        strategy: 'Focuses on group cohesion and gradual trust building.',
    },
];

// ─── AI color helpers ──────────────────────────────────────────────────────
const AI_COLORS = [
    '\x1b[36m', // cyan
    '\x1b[35m', // magenta
    '\x1b[33m', // yellow
    '\x1b[32m', // green
    '\x1b[34m', // blue
    '\x1b[31m', // red
    '\x1b[37m', // white
    '\x1b[90m', // gray
    '\x1b[96m', // bright cyan
    '\x1b[95m', // bright magenta
];
/** Assign a consistent model to a player based on their ID. */
function aiColor(name: string): string {
    const idx = AI_NAMES.indexOf(name);
    return AI_COLORS[idx % AI_COLORS.length] || '\x1b[36m';
}
const RESET = '\x1b[0m';
const AI_BORDER = '──────────────────────────────────────────────────────────────';

function colorForPlayer(player: PlayerState): string {
    return aiColor(player.name);
}

function summarizeContext(context: string, maxLines = 8): string {
    const lines = context
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    if (lines.length <= maxLines) return lines.join('\n');
    const shown = lines.slice(0, maxLines).join('\n');
    return `${shown}\n… (${lines.length - maxLines} more lines)`;
}

function logAIStart(game: GameState, player: PlayerState, model: string, action: string): void {
    const color = colorForPlayer(player);
    const personality = getPersonality(player);
    console.log(`\n${color}${AI_BORDER}${RESET}`);
    console.log(
        `${color}[AI] ${player.name}${RESET} • role=${player.role} • personality=${personality.name} • model=${model}`
    );
    console.log(
        `${color}[AI] action=${action} • round=${game.round} • phase=${game.phase}${RESET}`
    );
}

function logAIContext(player: PlayerState, context: string): void {
    const color = colorForPlayer(player);
    console.log(`${color}[AI] context preview:${RESET}`);
    console.log(`${color}${summarizeContext(context)}${RESET}`);
}

function logAIChoice(player: PlayerState, label: string, value: string): void {
    const color = colorForPlayer(player);
    console.log(`${color}[AI] ${player.name} ${label}: ${value}${RESET}`);
}

function logAICandidates(player: PlayerState, label: string, names: string[]): void {
    const color = colorForPlayer(player);
    console.log(`${color}[AI] ${label}: ${names.join(', ')}${RESET}`);
}

function pickModel(player: PlayerState): string {
    const hash = player.id.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    return AI_MODELS[hash % AI_MODELS.length];
}

function stableHash(input: string): number {
    return input.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
}

function getPersonality(player: PlayerState): AIPersonality {
    return AI_PERSONALITIES[stableHash(player.id) % AI_PERSONALITIES.length];
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
    const personality = getPersonality(player);
    const mafiaTeamNames =
        player.role === 'mafia'
            ? Object.values(game.players)
                  .filter(p => p.role === 'mafia' && p.id !== player.id)
                  .map(p => p.name)
            : [];

    const clip = (value: string, max = 200): string => {
        const normalized = value.replace(/\s+/g, ' ').trim();
        if (normalized.length <= max) return normalized;
        return `${normalized.slice(0, Math.max(0, max - 1))}…`;
    };

    const recentEvents = game.gameLog.length > 0 ? game.gameLog.slice(-10) : ['Game just started.'];
    const privateNotes = game.playerLogs[player.id]?.slice(-6) ?? [];

    const lines = [
        `You are ${player.name}, playing Mafia (a social deduction game). Game round: ${game.round}.`,
        `CURRENT PHASE: ${game.phase.toUpperCase()}`,
        `STATUS: ${player.alive ? 'ALIVE' : 'ELIMINATED'}`,
        `YOUR ROLE: ${player.role.toUpperCase()}`,
        `PERSONALITY: ${personality.name} — ${personality.style}`,
        player.role === 'mafia'
            ? `Your mafia teammates: ${mafiaTeamNames.join(', ') || 'none (you are solo Mafia)'}`
            : '',
        `WIN CONDITION: ${player.role === 'mafia' ? 'Mafia equals or outnumbers Town' : 'Eliminate all Mafia members'}`,
        'KNOWLEDGE RULES: Only use your own role, your private notes, and public events. Do not assume hidden roles of living players.',
        '',
        `ALIVE (${alive.length}): ${alive.map(p => clip(p.name, 32)).join(', ')}`,
        dead.length > 0 ? `ELIMINATED: ${dead.map(p => clip(p.name, 32)).join(', ')}` : '',
        '',
        'RECENT EVENTS:',
        ...recentEvents.map(event => `- ${clip(event)}`),
        ...(privateNotes.length
            ? ['', 'YOUR PRIVATE NOTES:', ...privateNotes.map(note => `- ${clip(note)}`)]
            : []),
    ];
    return lines.filter(l => l !== '').join('\n');
}

const MIN_RETRY_MS = 5_000; // never retry faster than 5 s
const MAX_RETRIES = 3;
const MAX_PARALLEL_AI_REQUESTS = 4;
const IS_TEST_ENV =
    process.env.NODE_ENV === 'test' ||
    Boolean(process.env.VITEST) ||
    Boolean(process.env.VITEST_WORKER_ID) ||
    process.argv.some(arg => arg.toLowerCase().includes('vitest')) ||
    process.env.npm_lifecycle_event === 'test' ||
    process.env.npm_lifecycle_script?.toLowerCase().includes('vitest') === true;
const QUEUE_ACTION_DELAY_MS = IS_TEST_ENV ? 0 : 10_000;

type RequestTask<T> = {
    run: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
};

const requestQueue: RequestTask<unknown>[] = [];
let activeRequestCount = 0;
let nextQueueStartAt = 0;

/**
 * Per-game guard: tracks games where a mafia kill AI query is already in-flight.
 * Prevents the second mafia member from making a redundant Groq API call.
 */
const mafiaKillQuerying = new Set<string>();

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function pumpRequestQueue(): void {
    while (activeRequestCount < MAX_PARALLEL_AI_REQUESTS && requestQueue.length > 0) {
        const task = requestQueue.shift();
        if (!task) return;

        let waitMs = 0;
        if (QUEUE_ACTION_DELAY_MS > 0) {
            const now = Date.now();
            waitMs = Math.max(0, nextQueueStartAt - now);
            nextQueueStartAt = now + waitMs + QUEUE_ACTION_DELAY_MS;
        }

        activeRequestCount++;
        Promise.resolve()
            .then(async () => {
                if (waitMs > 0) {
                    await sleep(waitMs);
                }
                return task.run();
            })
            .then(task.resolve)
            .catch(task.reject)
            .finally(() => {
                activeRequestCount = Math.max(0, activeRequestCount - 1);
                pumpRequestQueue();
            });
    }
}

function enqueueRequest<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        requestQueue.push({
            run,
            resolve,
            reject,
        });
        pumpRequestQueue();
    });
}

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

function cleanModelOutput(content: string): string {
    const withoutToolCallBlocks = content
        .replace(/<tool_call>[\s\S]*?<tool_call>/gi, '')
        .replace(/<tool_call>/gi, '');

    const withoutClosedThink = withoutToolCallBlocks.replace(/<think[\s\S]*?<\/think>/gi, '');
    const withoutUnclosedThink = withoutClosedThink.replace(/<think[\s\S]*/gi, '');

    let cleaned = withoutUnclosedThink.trim();

    const nonEmptyLines = cleaned
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    const lastLine = nonEmptyLines[nonEmptyLines.length - 1];
    if (lastLine) {
        const quotedLine = lastLine.match(/^["“](.*)["”]$/s);
        if (quotedLine?.[1]) {
            cleaned = quotedLine[1].trim();
        }
    }

    const quotePairs: Array<[string, string]> = [
        ['"', '"'],
        ["'", "'"],
        ['“', '”'],
        ['‘', '’'],
    ];

    for (const [open, close] of quotePairs) {
        if (cleaned.startsWith(open) && cleaned.endsWith(close) && cleaned.length >= 2) {
            cleaned = cleaned.slice(1, -1).trim();
            break;
        }
    }

    if (cleaned.length > 1000) {
        cleaned = `${cleaned.slice(0, 999)}…`;
    }

    return cleaned;
}

async function ask(context: string, task: string, model: string): Promise<string> {
    const prompt = `${context}\n\nTASK: ${task}\n\nRespond with ONLY what is asked. No extra explanation.`;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const completion = await enqueueRequest(() =>
                getGroq().chat.completions.create({
                    model,
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 512,
                    temperature: 0.8,
                })
            );
            const raw = cleanModelOutput(completion.choices[0]?.message?.content ?? '');
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
    const personality = getPersonality(player);
    const ctx = buildContext(game, player);
    const model = pickModel(player);
    logAIStart(game, player, model, 'night-action');
    logAIContext(player, ctx);

    if (player.role === 'mafia') {
        if (game.night.actionsReceived.includes('kill')) return;
        // Prevent a second concurrent mafia member from also calling ask() — only the
        // first one through this gate makes the API request; the other returns early.
        if (mafiaKillQuerying.has(game.gameChannelId)) return;
        mafiaKillQuerying.add(game.gameChannelId);
        try {
            const targets = alive.filter(p => p.role !== 'mafia' && p.id !== player.id);
            if (targets.length === 0) return;
            logAICandidates(
                player,
                'kill candidates',
                targets.map(p => p.name)
            );
            const raw = await ask(
                ctx,
                `It is night. Choose one Town player to eliminate. Options: ${targets.map(p => p.name).join(', ')}. Personality guidance: ${personality.strategy}. Reply with only the player's exact name.`,
                model
            );
            if (game.night.actionsReceived.includes('kill')) return;
            const target = pickFromList(raw, targets);
            logAIChoice(player, 'chose kill target', target.name);
            game.night.killTarget = target.id;
            if (!game.night.actionsReceived.includes('kill')) {
                game.night.actionsReceived.push('kill');
            }
        } finally {
            mafiaKillQuerying.delete(game.gameChannelId);
        }
    } else if (player.role === 'detective') {
        if (game.night.actionsReceived.includes('investigate')) return;
        const targets = alive.filter(p => p.id !== player.id);
        if (targets.length === 0) return;
        logAICandidates(
            player,
            'investigate candidates',
            targets.map(p => p.name)
        );
        const raw = await ask(
            ctx,
            `It is night. Choose one player to investigate. Options: ${targets.map(p => p.name).join(', ')}. Personality guidance: ${personality.strategy}. Reply with only the player's exact name.`,
            model
        );
        if (game.night.actionsReceived.includes('investigate')) return;
        const target = pickFromList(raw, targets);
        const isMafia = target.role === 'mafia';
        logAIChoice(player, 'investigated', `${target.name} → ${isMafia ? 'MAFIA' : 'innocent'}`);
        game.night.investigateTarget = target.id;
        if (!game.night.actionsReceived.includes('investigate')) {
            game.night.actionsReceived.push('investigate');
        }
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
        logAICandidates(
            player,
            'protect candidates',
            targets.map(p => p.name)
        );
        const raw = await ask(
            ctx,
            `It is night. Choose one player to protect from a Mafia kill. Options: ${targets.map(p => p.name).join(', ')}. Personality guidance: ${personality.strategy}. Reply with only the player's exact name.`,
            model
        );
        if (game.night.actionsReceived.includes('protect')) return;
        const target = pickFromList(raw, targets);
        logAIChoice(player, 'chose protect target', target.name);
        game.night.protectTarget = target.id;
        if (!game.night.actionsReceived.includes('protect')) {
            game.night.actionsReceived.push('protect');
        }
        if (target.id === player.id) player.selfProtectUsed = true;
        (game.playerLogs[player.id] ??= []).push(
            `[Night ${game.round}] You chose to protect ${target.name}`
        );
    }
}

// ─── Day message ─────────────────────────────────────────────────────────────

/** Returns a short discussion message the AI player would say during the day. */
export async function generateDayMessage(game: GameState, player: PlayerState): Promise<string> {
    const model = pickModel(player);
    const personality = getPersonality(player);
    const ctx = buildContext(game, player);
    logAIStart(game, player, model, 'day-message');
    logAIContext(player, ctx);
    const text = await ask(
        ctx,
        `It is the day discussion phase. Write ONE short message (1–2 sentences) as a player trying to figure out who the Mafia is. Behavior style: ${personality.style} Ask/accuse style: ${personality.voting} Be natural and conversational. Never break the fourth wall, reveal your role, or mention any special action you took at night. If your private notes contain role-action results (e.g. investigations or protections), use them only to subtly inform your reasoning — never reference the action itself, its outcome, or hint that you have special information.`,
        model
    );
    logAIChoice(player, 'message', text || '(empty, using fallback)');
    return text || 'Not sure who to trust right now...';
}

// ─── Vote target ─────────────────────────────────────────────────────────────

/** Returns the ID of the player the AI wants to vote for. */
export async function pickVoteTarget(game: GameState, player: PlayerState): Promise<string | null> {
    const alive = Object.values(game.players).filter(p => p.alive && p.id !== player.id);
    if (alive.length === 0) return null;
    const model = pickModel(player);
    const personality = getPersonality(player);
    const ctx = buildContext(game, player);
    logAIStart(game, player, model, 'vote-target');
    logAICandidates(
        player,
        'vote candidates',
        alive.map(p => p.name)
    );
    const raw = await ask(
        ctx,
        `It is the voting phase. Vote to eliminate one player. Options: ${alive.map(p => p.name).join(', ')}. Personality guidance: ${personality.voting}. Use only known public information plus your private notes. Reply with only the player's exact name.`,
        model
    );
    const target = pickFromList(raw, alive);
    logAIChoice(player, 'votes to eliminate', target.name);
    return target.id;
}
