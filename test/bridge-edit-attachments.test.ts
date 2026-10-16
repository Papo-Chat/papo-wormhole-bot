import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Outbox } from '../src/db/outbox.js';
import { Store, type MessageMapRow } from '../src/db/store.js';
import { Bridge } from '../src/bridge/bridge.js';
import type { EditJob } from '../src/bridge/jobs.js';
import type { Config } from '../src/config.js';

const cfg: Config = {
  papo: {
    baseUrl: 'http://localhost',
    wsUrl: 'ws://localhost/ws',
    username: 'bot',
    password: 'password',
    refreshHours: 12,
    backfillOnStart: false,
    rateLimitRps: 0,
    rateBurst: 1
  },
  discord: { token: 'test-token', maxFileBytes: 20_000_000, maxMessagesPer5s: 5, webhookBudget: 15 },
  bridge: {
    dataDir: ':memory:',
    dbPath: ':memory:',
    mediaPort: 0,
    timezone: 'UTC',
    emojiAutoImport: false,
    propagateMentions: false,
    maxAttempts: 5,
    backoffBaseMs: 20,
    backoffMaxMs: 60
  }
};

describe('edições de attachment no Discord', () => {
  let db: ReturnType<typeof openDb> | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('substitui o attachment antigo no Papo e atualiza o mapeamento', async () => {
    db = openDb(':memory:');
    const store = new Store(db);
    const outbox = new Outbox(db, { maxAttempts: 5, baseMs: 20, maxMs: 60 });
    const link = store.upsertChannelLink({ papo_channel_id: 'papo-channel', discord_channel_id: 'discord-channel' });
    store.mapMessage({
      link_id: link.id,
      direction: 'discord_to_papo',
      papo_message_id: 'pm-old',
      discord_message_id: 'discord-message',
      chunk_index: 0,
      chunk_total: 1,
      rendered: 'Wordle board 1',
      bridge_embed: { author: { name: 'Wordle' }, description: 'Wordle board 1' },
      footer_base: 'Discord',
      link_embeds: null
    });
    const sent: { attachments?: { name: string; data: Buffer }[]; content?: string }[] = [];
    const deleted: string[] = [];
    const api = {
      sendMessage: async (input: { attachments?: { name: string; data: Buffer }[]; content?: string }) => {
        sent.push(input);
        return {
          id: 'pm-new',
          channel_id: 'papo-channel',
          author_id: 'bot',
          content: input.content ?? null,
          created_at: new Date().toISOString()
        };
      },
      deleteMessage: async (messageId: string) => { deleted.push(messageId); }
    };
    const bridge = new Bridge(cfg, store, outbox, api as never, {} as never, {} as never, {} as never);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(Buffer.from('updated wordle image'), { status: 200 })) as typeof fetch;

    const job: EditJob = {
      kind: 'edit',
      side: 'discord',
      linkId: link.id,
      sourceMessageId: 'discord-message',
      targetChannelId: 'papo-channel',
      chunkIndex: 0,
      chunkTotal: 1,
      text: 'Wordle board 2',
      revision: '2026-10-15T12:00:00.000Z',
      refreshAttachments: true,
      sources: [{
        side: 'discord',
        id: 'attachment-new',
        name: 'wordle.png',
        mime: 'image/png',
        sizeBytes: 20,
        url: 'https://cdn.discordapp.com/attachments/1/2/wordle.png'
      }]
    };

    try {
      const current = store.findMapByDiscord('discord-message');
      const subject = bridge as unknown as {
        replaceDiscordCopyAttachments(job: EditJob, maps: MessageMapRow[], mainMap: MessageMapRow): Promise<void>
      };
      await subject.replaceDiscordCopyAttachments(job, current, current[0]!);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(sent).toHaveLength(1);
    expect(sent[0]?.attachments?.map((file) => file.name)).toEqual(['wordle.png']);
    expect(sent[0]?.attachments?.[0]?.data.toString()).toBe('updated wordle image');
    expect(store.findMapByDiscord('discord-message')[0]?.papo_message_id).toBe('pm-new');
    expect(store.findMapByDiscord('discord-message')[0]?.rendered).toBe('Wordle board 2');
    expect(deleted).toEqual(['pm-old']);
  });
});
