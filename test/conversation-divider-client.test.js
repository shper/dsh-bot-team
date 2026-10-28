import test from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, walk, text } from './client-harness.js';

const conversation = (ordinal, createdAt, afterSeq = ordinal - 1) => ({
  conversationId: 'c' + ordinal, groupId: 'g1', ordinal, createdAt, afterSeq,
  previousConversationId: ordinal > 1 ? 'c' + (ordinal - 1) : null,
});
const part = (tree, className) => walk(tree).find(node => node.props?.className === className);
const rangeText = tree => text(part(tree, 'bt-conversation-range'));
const today = (hour, minute, second = 0) => { const date = new Date(); date.setHours(hour, minute, second, 0); return date.getTime(); };
const render = (client, conversation, nextConversation, current = false, onViewLogs) =>
  client.render(client.ConversationDivider, { conversation, nextConversation, current, onViewLogs });

test('same-day historical range uses its successor and current range stays open', () => {
  const client = loadClient(); client.setTestLocale('zh');
  const first = conversation(1, today(0, 36, 29));
  const second = conversation(2, today(14, 37, 25));
  const historical = render(client, first, second);
  assert.equal(rangeText(historical), '今天 00:36–14:37');
  assert.equal(walk(historical).filter(node => node.type === 'time').length, 2);
  const tooltip = text(part(historical, 'bt-conversation-tooltip'));
  assert.ok(tooltip.includes('00:36:29') && tooltip.includes('14:37:25'));
  assert.equal(rangeText(render(client, second, conversation(3, today(18, 0)), true)), '今天 14:37–至今');
  client.setTestLocale('en');
  const current = render(client, second, null, true);
  assert.equal(rangeText(current), 'Today 14:37–Present');
  assert.equal(text(part(current, 'bt-conversation-current')), 'Current');
});

test('cross-day and cross-year ranges keep both dates unambiguous', () => {
  const client = loadClient(); client.setTestLocale('zh');
  const year = new Date().getFullYear();
  let first = conversation(1, new Date(year, 9, 27, 23, 50).getTime());
  let second = conversation(2, new Date(year, 9, 28, 0, 15).getTime());
  assert.equal(rangeText(render(client, first, second)), '10/27 23:50–10/28 00:15');
  first = conversation(1, new Date(2025, 11, 31, 23, 50).getTime());
  second = conversation(2, new Date(2026, 0, 1, 0, 20).getTime());
  assert.equal(rangeText(render(client, first, second)), '2025/12/31 23:50–2026/01/01 00:20');
});

test('incomplete history and malformed timestamps never invent an end time', () => {
  const client = loadClient(); client.setTestLocale('zh');
  const first = conversation(1, today(9, 0));
  const second = conversation(2, today(10, 0));
  for (const next of [undefined, conversation(3, today(11, 0)), { ...second, groupId: 'other' },
    { ...second, ordinal: 9 }, { ...second, previousConversationId: 'other' },
    { ...second, createdAt: 'invalid' }, { ...second, createdAt: today(8, 59) }]) {
    assert.equal(rangeText(render(client, first, next)), '今天 09:00–结束时间未知');
  }
  assert.equal(rangeText(render(client, first, { ...second, createdAt: first.createdAt })), '今天 09:00–09:00');
  for (const createdAt of [null, undefined, '', 'invalid', false]) {
    assert.equal(rangeText(render(client, { ...first, createdAt }, second)), '时间未知–结束时间未知');
  }
  assert.ok(!rangeText(render(client, { ...first, createdAt: 0 }, second)).startsWith('–'));
});

test('timeline uses direct links across empty conversations and incomplete pagination', () => {
  const client = loadClient();
  const first = conversation(1, today(9, 0), 0);
  const second = conversation(2, today(10, 0), 0);
  const third = conversation(3, today(11, 0), 0);
  const props = { messages: [], conversations: [third, first, second], group: { currentConversationId: 'c3' } };
  const dividers = walk(client.MessageList(props)).filter(node => node.type === client.ConversationDivider);
  assert.equal(dividers.length, 3);
  assert.equal(dividers[0].props.nextConversation.conversationId, 'c2');
  assert.equal(dividers[1].props.nextConversation.conversationId, 'c3');
  assert.equal(dividers[2].props.current, true);
  const partial = walk(client.MessageList({ ...props, conversations: [first, third] })).filter(node => node.type === client.ConversationDivider);
  assert.equal(partial[0].props.nextConversation, undefined);
  assert.ok(rangeText(client.render(client.ConversationDivider, partial[0].props)).endsWith('结束时间未知'));
});

test('first message timestamp is hidden only when it repeats its immediate boundary minute', () => {
  const client = loadClient();
  const first = conversation(1, today(9, 56, 29), 0);
  const message = { messageId: 'm1', seq: 1, conversationId: 'c1', createdAt: today(9, 56, 40) };
  const countTimes = (messages, conversations = [first]) => walk(client.MessageList({ messages, conversations, group: { currentConversationId: 'c1' } }))
    .filter(node => node.type?.name === 'TimeDivider').length;
  assert.equal(countTimes([message]), 0);
  assert.equal(countTimes([{ ...message, createdAt: today(9, 58) }]), 1);
  assert.equal(countTimes([{ ...message, createdAt: today(9, 56, 10) }]), 1);
  assert.equal(countTimes([{ ...message, conversationId: 'c2' }]), 1);
  assert.equal(countTimes([message], []), 1);
  assert.equal(countTimes([message], [{ ...first, createdAt: null }]), 1);
});

test('logs target their own conversation and the full range is keyboard accessible', () => {
  const client = loadClient(); client.setTestLocale('en');
  const first = conversation(1, today(9, 0));
  const second = conversation(2, today(10, 0));
  const opened = [];
  const props = { conversation: first, nextConversation: second, onViewLogs: value => opened.push(value) };
  let tree = client.render(client.ConversationDivider, props);
  const button = part(tree, 'bt-conversation-logs');
  assert.equal(button.props['aria-label'], 'View logs for Conversation 1');
  button.props.onClick(); assert.equal(opened[0], first);
  const range = part(tree, 'bt-conversation-range');
  assert.equal(range.props.tabIndex, 0);
  assert.equal(range.props['aria-describedby'], part(tree, 'bt-conversation-tooltip').props.id);
  part(tree, 'bt-conversation-date').props.onKeyDown({ key: 'Escape', stopPropagation() {} });
  tree = client.render(client.ConversationDivider, props);
  assert.equal(part(tree, 'bt-conversation-date').props['data-dismissed'], true);
  part(tree, 'bt-conversation-date').props.onFocus();
  assert.equal(part(client.render(client.ConversationDivider, props), 'bt-conversation-date').props['data-dismissed'], false);
});
