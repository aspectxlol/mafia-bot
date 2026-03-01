import { Message } from 'discord.js';

import { EventHandler, TriggerHandler } from './index.js';
import { getGame } from '../game/gameState.js';
import { logEvent } from '../game/aiPlayer.js';

export class MessageHandler implements EventHandler {
    constructor(private triggerHandler: TriggerHandler) {}

    public async process(msg: Message): Promise<void> {
        // Don't respond to system messages or self
        if (msg.system || msg.author.id === msg.client.user?.id) {
            return;
        }

        // Log human messages to AI context during day phase
        const game = msg.channelId ? getGame(msg.channelId) : undefined;
        if (game && game.phase === 'day' && !msg.author.bot) {
            const player = game.players[msg.author.id];
            if (!player || !player.alive) {
                await this.triggerHandler.process(msg);
                return;
            }
            const name = player.name;
            let text = msg.content?.trim() ?? '';
            if (!text && msg.embeds?.length > 0 && msg.embeds[0].description) {
                text = msg.embeds[0].description.slice(0, 100);
            }
            if (!text && msg.attachments.size > 0) {
                text = '[Attachment]';
            }
            if (!text && msg.stickers?.size > 0) {
                text = '[Sticker]';
            }
            if (text) {
                logEvent(game, `[Day ${game.round}] ${name}: "${text.slice(0, 160)}"`);
            }
        }

        // Process trigger
        await this.triggerHandler.process(msg);
    }
}
