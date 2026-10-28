import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, walk, plain } from './client-harness.js';

const noop = () => {};

const members = [
  { membershipId: 'm1', botId: 'b1', groupId: 'g1', enabled: true },
  { membershipId: 'm2', botId: 'b2', groupId: 'g1', enabled: false },
  { membershipId: 'm3', botId: 'b3', groupId: 'g1' },
];
const bots = [
  { botId: 'b1', name: 'Timi' },
  { botId: 'b2', name: 'Paused' },
  { botId: 'b3', name: 'Docs' },
];
const timi = { member: members[0], bot: bots[0] };
const docs = { member: members[2], bot: bots[2] };

function botMessage(overrides = {}) {
  return {
    messageId: 'm9',
    groupId: 'g1',
    seq: 9,
    author: { type: 'bot', botId: 'b1', name: 'Timi' },
    kind: 'chat',
    text: 'done',
    status: 'done',
    ...overrides,
  };
}

function state() {
  return { statusByMember: {}, bots, members };
}

function composerProps(overrides = {}) {
  return {
    state: state(),
    dispatch: noop,
    group: { groupId: 'g1', kind: 'group', title: '群聊' },
    members,
    bots,
    replyTarget: null,
    userProfile: null,
    onClearReply: noop,
    onSent: noop,
    onResize: noop,
    ...overrides,
  };
}

function runEffects(client) {
  for (const effect of client.effects.splice(0)) {
    const cleanup = effect();
    if (typeof cleanup === 'function') cleanup();
  }
}

function textareaValue(tree) {
  return walk(tree).find(node => node.type === 'textarea').props.value;
}

test('replyMentionOf resolves only enabled bot members of the replied message', () => {
  const client = loadClient();
  assert.deepEqual(plain(client.replyMentionOf(botMessage(), members, bots)), { member: members[0], bot: bots[0] });
  assert.equal(client.replyMentionOf(botMessage({ author: { type: 'human' } }), members, bots), null);
  assert.equal(client.replyMentionOf(botMessage({ author: { type: 'bot', botId: 'b2' } }), members, bots), null, 'disabled members are skipped');
  assert.equal(client.replyMentionOf(botMessage({ author: { type: 'bot', botId: 'nope' } }), members, bots), null, 'non-members are skipped');
  assert.equal(client.replyMentionOf(botMessage(), members, []), null, 'missing bot records are skipped');
});

test('a reply starts with the author bot @mention and the matching explicit mention', () => {
  const client = loadClient();
  const fromEmpty = client.applyReplyMention({ text: '', mentions: [], entry: timi, auto: null });
  assert.equal(fromEmpty.text, '@Timi ');
  assert.deepEqual(plain(fromEmpty.mentions), ['m1']);
  assert.deepEqual(plain(fromEmpty.auto), { membershipId: 'm1', name: 'Timi' });
  assert.equal(fromEmpty.caret, fromEmpty.text.length);

  const withDraft = client.applyReplyMention({ text: '看看这个', mentions: [], entry: timi, auto: null });
  assert.equal(withDraft.text, '@Timi 看看这个');
  assert.deepEqual(plain(withDraft.mentions), ['m1']);
  assert.equal(withDraft.caret, withDraft.text.length);

  const alreadyMentioned = client.applyReplyMention({ text: '@Timi 看看', mentions: [], entry: timi, auto: null });
  assert.equal(alreadyMentioned.text, '@Timi 看看');
  assert.deepEqual(plain(alreadyMentioned.mentions), ['m1']);
  assert.equal(alreadyMentioned.auto, null, 'a mention the user typed is not tracked as auto-inserted');
  assert.equal(alreadyMentioned.caret, null);
});

test('changing the reply target replaces the auto mention and keeps typed text', () => {
  const client = loadClient();
  const previous = { membershipId: 'm1', name: 'Timi' };
  const switched = client.applyReplyMention({
    text: '@Timi 请把结论发我',
    mentions: ['m1'],
    entry: docs,
    auto: previous,
  });
  assert.equal(switched.text, '@Docs 请把结论发我');
  assert.deepEqual(plain(switched.mentions), ['m3']);
  assert.deepEqual(plain(switched.auto), { membershipId: 'm3', name: 'Docs' });
  assert.equal(switched.caret, switched.text.length);

  const sameTarget = client.applyReplyMention({
    text: '@Timi 请把结论发我',
    mentions: ['m1'],
    entry: timi,
    auto: previous,
  });
  assert.equal(sameTarget.text, '@Timi 请把结论发我');
  assert.equal(sameTarget.caret, null, 'replying to another message from the same bot does not duplicate @');
});

test('a non-bot reply target drops the auto mention without touching the user draft', () => {
  const client = loadClient();
  const previous = { membershipId: 'm1', name: 'Timi' };
  const cleaned = client.applyReplyMention({
    text: '@Timi 请把结论发我',
    mentions: ['m1'],
    entry: null,
    auto: previous,
  });
  assert.equal(cleaned.text, '请把结论发我');
  assert.deepEqual(plain(cleaned.mentions), []);
  assert.equal(cleaned.auto, null);
  assert.equal(cleaned.caret, cleaned.text.length);

  const moved = client.applyReplyMention({
    text: '请把 @Timi 的结论发我',
    mentions: ['m1'],
    entry: null,
    auto: previous,
  });
  assert.equal(moved.text, '请把 @Timi 的结论发我', 'a moved token is a user edit and stays');
  assert.deepEqual(plain(moved.mentions), ['m1']);
  assert.equal(moved.caret, null);

  const deleted = client.applyReplyMention({
    text: '请把结论发我',
    mentions: ['m1'],
    entry: null,
    auto: previous,
  });
  assert.deepEqual(plain(deleted.mentions), [], 'a deleted token also drops its stale explicit mention');
});

test('the composer pre-fills @bot when replying in a group but not in a direct chat', () => {
  const client = loadClient();
  const props = composerProps({ replyTarget: botMessage() });
  let tree = client.render(client.Composer, props);
  assert.equal(textareaValue(tree), '');
  runEffects(client);
  tree = client.render(client.Composer, props);
  assert.equal(textareaValue(tree), '@Timi ');
  const replyBar = walk(tree).find(node => node.props?.className === 'bt-reply-bar');
  assert.ok(replyBar, 'reply bar still renders above the input');

  const direct = loadClient();
  const directProps = composerProps({
    group: { groupId: 'dm-b1', kind: 'direct', title: 'Timi' },
    members: [members[0]],
    replyTarget: botMessage({ groupId: 'dm-b1' }),
  });
  let directTree = direct.render(direct.Composer, directProps);
  runEffects(direct);
  directTree = direct.render(direct.Composer, directProps);
  assert.equal(textareaValue(directTree), '', 'single chats dispatch without @');

  const human = loadClient();
  const humanProps = composerProps({ replyTarget: botMessage({ author: { type: 'human' } }) });
  let humanTree = human.render(human.Composer, humanProps);
  runEffects(human);
  humanTree = human.render(human.Composer, humanProps);
  assert.equal(textareaValue(humanTree), '', 'replying to a human message does not invent an @');

  const otherChat = loadClient();
  const otherProps = composerProps({ replyTarget: botMessage({ groupId: 'g2' }) });
  let otherTree = otherChat.render(otherChat.Composer, otherProps);
  runEffects(otherChat);
  otherTree = otherChat.render(otherChat.Composer, otherProps);
  assert.equal(textareaValue(otherTree), '', 'a stale reply target from another chat is ignored');
});
