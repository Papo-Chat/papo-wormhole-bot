import { afterEach, describe, expect, it, vi } from 'vitest';
import { PapoApi } from '../src/papo/api.js';

const channel = 'c0000000-0000-4000-8000-000000000001';
const hookID = 'a0000000-0000-4000-8000-000000000001';
const token = 'a'.repeat(64);

function client(withWebhook = true): PapoApi {
    return new PapoApi({
        baseUrl: 'https://papo.example/',
        username: 'reader',
        password: 'not-used-for-webhook',
        webhooks: withWebhook ? { [channel]: { id: hookID, token } } : {},
        rateLimitRps: 0,
    });
}

afterEach(() => vi.unstubAllGlobals());

describe('native incoming webhook transport', () => {
    it('sends external attribution and stable source id only under scoped bearer credentials', async () => {
        const fetchMock = vi.fn(async () => new Response(
            JSON.stringify({ id: 'papo-message', author_id: null, webhook_id: hookID }),
            { status: 201, headers: { 'content-type': 'application/json' } },
        ));
        vi.stubGlobal('fetch', fetchMock);
        const author = { source: 'discord', id: '1234', name: 'Remote User' };
        const result = await client().sendMessage({
            channelId: channel,
            content: 'hello',
            externalAuthor: author,
            externalMessageId: 'discord:1:2:0:0',
        });
        expect(result.id).toBe('papo-message');
        const [url, init] = fetchMock.mock.calls[0]! as unknown as [URL, RequestInit];
        expect(url.toString()).toBe('https://papo.example/webhooks/' + hookID + '/messages');
        const headers = new Headers(init.headers);
        expect(headers.get('Authorization')).toBe('Bearer ' + token);
        expect(headers.has('Cookie')).toBe(false);
        const form = init.body as FormData;
        expect(form.get('external_message_id')).toBe('discord:1:2:0:0');
        expect(JSON.parse(form.get('external_author') as string)).toEqual(author);
        expect(form.get('content')).toBe('hello');
    });

    it('refuses impersonation without a channel webhook instead of submitting user POST', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await expect(client(false).sendMessage({
            channelId: channel, content: 'hi',
            externalAuthor: { source: 'discord', id: '1234', name: 'Remote' },
            externalMessageId: 'source-1234',
        })).rejects.toThrow(/webhook não configurado/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('edits and deletes using the same scoped webhook rather than the user JWT', async () => {
        const fetchMock = vi.fn(async () => new Response(
            JSON.stringify({ id: 'papo-message' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ));
        vi.stubGlobal('fetch', fetchMock);
        const api = client();
        await api.editMessage('papo-message', 'updated', [], channel);
        await api.deleteMessage('papo-message', channel);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        for (const [url, init] of fetchMock.mock.calls as unknown as [URL, RequestInit][]) {
            expect(url.pathname).toBe('/webhooks/' + hookID + '/messages/papo-message');
            expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ' + token);
        }
        expect((fetchMock.mock.calls[0] as unknown as [URL, RequestInit])[1].method).toBe('PUT');
        expect((fetchMock.mock.calls[1] as unknown as [URL, RequestInit])[1].method).toBe('DELETE');
    });
});
