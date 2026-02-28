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
        getString: (name: string, required?: boolean) => string | null;
    };
    client: {
        channels: {
            fetch: ReturnType<typeof vi.fn>;
        };
        user: { id: string };
    };
}

export function makeIntr(
    overrides: Partial<FakeInteraction> & {
        targetUser?: FakeUser;
        targetName?: string | null;
        noTarget?: boolean;
    } = {}
): FakeInteraction {
    const noTarget = overrides.noTarget === true;
    const target = overrides.targetUser ?? { id: 'target1' };
    const targetName = overrides.targetName !== undefined ? overrides.targetName : null;
    return {
        channelId: 'ch1',
        guild: { id: 'guild1' },
        user: { id: 'user1' },
        editReply: vi.fn().mockResolvedValue(undefined),
        followUp: vi.fn().mockResolvedValue(undefined),
        options: {
            getUser: vi
                .fn()
                .mockImplementation(() => (noTarget || targetName !== null ? null : target)),
            getString: vi.fn().mockReturnValue(noTarget ? null : targetName),
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
