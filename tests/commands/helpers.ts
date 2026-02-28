/**
 * Shared helpers for command unit tests.
 * Provides factory functions for fake ChatInputCommandInteraction objects.
 */

import { vi } from 'vitest';

export interface FakeUser {
    id: string;
    bot?: boolean;
}

export interface FakeInteraction {
    channelId: string;
    guild: { id: string } | null;
    user: FakeUser;
    editReply: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    options: {
        getUser: (name: string, required?: boolean) => FakeUser | null;
    };
    client: {
        channels: {
            fetch: ReturnType<typeof vi.fn>;
        };
        user: { id: string };
    };
}

export function makeIntr(
    overrides: Partial<FakeInteraction> & { targetUser?: FakeUser } = {}
): FakeInteraction {
    const target = overrides.targetUser ?? { id: 'target1' };
    return {
        channelId: 'ch1',
        guild: { id: 'guild1' },
        user: { id: 'user1' },
        editReply: vi.fn().mockResolvedValue(undefined),
        followUp: vi.fn().mockResolvedValue(undefined),
        options: {
            getUser: vi.fn().mockReturnValue(target),
        },
        client: {
            channels: {
                fetch: vi.fn().mockResolvedValue({
                    send: vi.fn().mockResolvedValue(undefined),
                    messages: { fetch: vi.fn().mockResolvedValue(null) },
                    permissionOverwrites: { set: vi.fn().mockResolvedValue(undefined) },
                    setTopic: vi.fn().mockResolvedValue(undefined),
                }),
            },
            user: { id: 'botUser' },
        },
        ...overrides,
    };
}
