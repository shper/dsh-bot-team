import test from 'node:test';
import assert from 'node:assert/strict';
import { openRepository } from '../host/domain.js';
import { BotTeamService } from '../host/service.js';
import { loadClient, text, walk } from './client-harness.js';

const signature = '领航员 / Navigator 🧭';
const botInput = { name: '42', provider: 'deepseek', model: 'deepseek-chat' };
const modelCatalog = { groups: [{ id: botInput.provider, models: [{ id: botInput.model }] }] };
const settle = () => new Promise(resolve => setImmediate(resolve));

async function repositoryFixture() {
  const tables = new Map();
  const domain = {
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const records = tables.get(name);
      return {
        entries: () => [...records].map(([key, value]) => [key, structuredClone(value)]),
        async put(key, value) { records.set(key, structuredClone(value)); },
        async delete(key) { records.delete(key); },
      };
    },
    async close() {},
  };
  const reopen = () => openRepository({ storageDomain: { open: async () => domain } });
  const service = Object.assign(Object.create(BotTeamService.prototype), {
    repo: await reopen(),
    ensureDirectGroup: async () => ({ groupId: 'direct' }),
    directGroups: () => [],
  });
  return { service, reopen };
}

test('bot signatures persist across reopening, preserve omitted updates, and clear explicitly', async () => {
  const { service, reopen } = await repositoryFixture();
  const bot = await service.createBot({ ...botInput, signature: `  ${signature}  ` });
  service.repo = await reopen();
  assert.equal(service.repo.getBot(bot.botId).signature, signature);
  await service.updateBot({ botId: bot.botId, name: 'Renamed' });
  assert.equal((await reopen()).getBot(bot.botId).signature, signature);
  await service.updateBot({ botId: bot.botId, signature: '  新签名  ' });
  assert.equal((await reopen()).getBot(bot.botId).signature, '新签名');
  await service.updateBot({ botId: bot.botId, signature: '   ' });
  assert.equal(Object.hasOwn((await reopen()).getBot(bot.botId), 'signature'), false);
  const legacy = await service.createBot({ ...botInput, name: 'Legacy' });
  assert.equal(Object.hasOwn((await reopen()).getBot(legacy.botId), 'signature'), false);
  const bounded = await service.createBot({ ...botInput, name: 'Long', signature: '长'.repeat(150) });
  assert.equal(bounded.signature, '长'.repeat(120));
  await service.updateBot({ botId: bounded.botId, signature: '新'.repeat(150) });
  assert.equal((await reopen()).getBot(bounded.botId).signature, '新'.repeat(120));
});

test('new and edit forms submit signatures, retain them on reopen, and allow clearing', async () => {
  const requests = [];
  const saved = [];
  const client = loadClient({ lifecycleEffects: true, fetch: async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (body?.action) requests.push(body);
    return Response.json({ ok: true, result: { botId: 'bot-1' }, text: '' });
  } });
  const base = { modelCatalog, onClose() {}, onSaved: value => saved.push(value) };
  const input = tree => walk(tree).find(node => node.type === 'input' && node.props['aria-label'] === '签名 / Title');
  const submit = (tree, label) => {
    const button = walk(tree).find(node => node.type === 'button' && text(node) === label);
    assert.equal(button.props.disabled, false);
    button.props.onClick();
  };
  let tree = client.render(client.BotFormDialog, base);
  const nameInput = walk(tree).find(node => node.type === 'input' && node.props.maxLength === 40);
  nameInput.props.onChange({ target: { value: botInput.name } });
  input(tree).props.onChange({ target: { value: `  ${signature}  ` } });
  tree = client.render(client.BotFormDialog, base);
  submit(tree, '创建 Bot');
  await settle();
  assert.equal(requests[0].action, 'bot.create');
  assert.equal(requests[0].payload.signature, signature);
  assert.equal(requests[0].payload.name, botInput.name);
  assert.equal(saved.length, 1);

  const editing = { ...base, bot: { ...botInput, botId: 'bot-1', signature } };
  tree = client.remount(client.BotFormDialog, editing);
  assert.equal(input(tree).props.value, signature);
  client.flushEffects();
  await settle();
  input(tree).props.onChange({ target: { value: '' } });
  tree = client.render(client.BotFormDialog, editing);
  submit(tree, '保存');
  await settle();
  assert.equal(requests[1].action, 'bot.update');
  assert.equal(requests[1].payload.botId, 'bot-1');
  assert.equal(requests[1].payload.signature, '');
  assert.equal(saved.length, 2);
  client.unmount();
});

test('message headers show current signatures verbatim after the bot name in both locales', () => {
  const client = loadClient();
  const bot = { ...botInput, botId: 'bot-1', signature };
  const message = { messageId: 'm1', kind: 'chat', text: 'Hello', status: 'done', author: { type: 'bot', botId: bot.botId, name: 'Old name' } };
  const row = (bots, overrides = {}) => client.MessageRow({ message, bots, tasks: [], allMessages: [], groupStart: true, groupEnd: true, ...overrides });
  const signatures = tree => walk(tree).filter(node => node.props.className === 'bt-msg-signature');
  for (const locale of ['zh', 'en']) {
    client.setTestLocale(locale);
    for (const value of [signature, '取消', '<b>Title</b>']) {
      const tree = row([{ ...bot, signature: value }]);
      const [node] = signatures(tree);
      assert.equal(text(node), value);
      assert.equal(node.props.title, value);
      const header = walk(tree).find(item => item.props.children?.includes(node));
      assert.equal(text(header.props.children[1]), bot.name);
      assert.equal(header.props.children[2], node);
    }
    for (const value of [undefined, '', '   ']) assert.equal(signatures(row([{ ...bot, signature: value }])).length, 0);
    assert.equal(signatures(row([])).length, 0, 'deleted or legacy bot has no signature');
    assert.equal(signatures(row([bot], { groupStart: false })).length, 0, 'grouped follow-up does not repeat the header');
    assert.equal(signatures(row([bot], { message: { ...message, author: { type: 'human' } } })).length, 0);
    const streaming = row([bot], { message: { ...message, status: 'streaming' } });
    assert.equal(signatures(streaming).length, 1);
    assert.ok(text(streaming).includes(client.uiT('正在输入')));
  }
});
