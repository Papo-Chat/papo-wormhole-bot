import { afterEach, describe, expect, it } from 'vitest';
import { Collection, type TextChannel, type Webhook } from 'discord.js';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { DiscordBridge } from '../src/discord/bridge.js';

describe('rotação de webhooks do Discord', () => {
  let bridge: DiscordBridge | undefined;
  let store: Store | undefined;
  let db: ReturnType<typeof openDb> | undefined;

  afterEach(async () => {
    await bridge?.destroy();
    db?.close();
    bridge = undefined;
    store = undefined;
    db = undefined;
  });

  it('remove o webhook próprio mais antigo quando o orçamento do canal foi atingido', async () => {
    db = openDb(':memory:');
    store = new Store(db);
    const olderId = '100000000000000000';
    const newerId = '100000000004194304';
    const newId = '100000000008388608';
    store.upsertBridgeWebhook({ webhook_id: olderId, channel_id: 'channel-1', papo_user_id: 'papo-user-1', name: 'oldest' });
    store.upsertBridgeWebhook({ webhook_id: newerId, channel_id: 'channel-1', papo_user_id: 'papo-user-2', name: 'newer' });

    const deleted: string[] = [];
    const makeWebhook = (id: string): Webhook => ({
      id,
      delete: async () => { deleted.push(id); }
    } as unknown as Webhook);
    const hooks = new Collection<string, Webhook>();
    hooks.set(olderId, makeWebhook(olderId));
    hooks.set(newerId, makeWebhook(newerId));
    const created = makeWebhook(newId);
    const host = {
      id: 'channel-1',
      createWebhook: async () => created
    } as unknown as TextChannel;

    bridge = new DiscordBridge({
      token: 'test-token',
      handlers: {},
      store,
      webhookBudget: 2
    });
    const subject = bridge as unknown as {
      createWebhookWithRotation: (
        channel: TextChannel,
        name: string,
        avatarBuffer: Buffer | undefined,
        initialHooks: Collection<string, Webhook>
      ) => Promise<Webhook | null>
    };

    const result = await subject.createWebhookWithRotation(host, 'replacement', undefined, hooks);

    expect(result?.id).toBe(newId);
    expect(deleted).toEqual([olderId]);
    expect(store.listBridgeWebhookIds('channel-1')).toEqual([newerId]);
    await bridge.destroy();
    bridge = undefined;
  });

  it('não remove webhooks de terceiros para liberar espaço', async () => {
    db = openDb(':memory:');
    store = new Store(db);
    const thirdPartyId = '100000000000000000';
    const hook = { id: thirdPartyId, delete: async () => { throw new Error('should not delete'); } } as unknown as Webhook;
    const hooks = new Collection<string, Webhook>();
    hooks.set(thirdPartyId, hook);
    const host = {
      id: 'channel-1',
      createWebhook: async () => { throw Object.assign(new Error('Maximum number of webhooks reached'), { code: 30007 }); },
      fetchWebhooks: async () => hooks
    } as unknown as TextChannel;
    bridge = new DiscordBridge({ token: 'test-token', handlers: {}, store, webhookBudget: 1 });
    const subject = bridge as unknown as {
      createWebhookWithRotation: (
        channel: TextChannel,
        name: string,
        avatarBuffer: Buffer | undefined,
        initialHooks: Collection<string, Webhook>
      ) => Promise<Webhook | null>
    };

    const result = await subject.createWebhookWithRotation(host, 'replacement', undefined, hooks);
    expect(result).toBeNull();
    expect(store.listBridgeWebhookIds('channel-1')).toEqual([]);
    await bridge.destroy();
    bridge = undefined;
  });
});
