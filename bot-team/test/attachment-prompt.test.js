import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnPrompt } from '../host/prompt.js';

function repoFor() {
  const group = { groupId: 'g1', kind: 'direct', title: 'Timi', workspaceCwd: '/tmp/ws' };
  const bot = { botId: 'b1', name: 'Timi', provider: 'deepseek', model: 'deepseek-chat' };
  return {
    getGroup: () => group,
    getBot: () => bot,
    membersOf: () => [{ membershipId: 'm1', groupId: 'g1', botId: 'b1', enabled: true }],
    getMember: () => ({ membershipId: 'm1', groupId: 'g1', botId: 'b1', enabled: true }),
  };
}

test('turn prompts expose attachment handles and keep the slash gesture at a boundary', () => {
  const repo = repoFor();
  const message = {
    messageId: 'm1',
    groupId: 'g1',
    seq: 7,
    author: { type: 'human', name: '用户' },
    kind: 'chat',
    text: '/office 总结这个附件',
    mentions: [],
    attachments: [
      { attachmentId: 'sha256:' + 'a'.repeat(64), name: 'brief.pdf', bytes: 1536, path: '/tmp/ws/brief.pdf' },
    ],
    status: 'done',
  };
  const prompt = buildTurnPrompt({
    repo,
    botId: 'b1',
    groupId: 'g1',
    contextMessages: [message],
    triggeredByMessageId: 'm1',
    mention: true,
  });
  assert.match(prompt, /\[#7\] 用户： \/office 总结这个附件/);
  assert.match(prompt, /附件（已保存为只读文件/);
  assert.match(prompt, /brief\.pdf/);
  assert.match(prompt, /1\.5 KB/);
  assert.match(prompt, /\/tmp\/ws\/brief\.pdf/);
  assert.match(prompt, /附件是只读文件/);
});

test('long user instructions retain their final constraints for native compaction', () => {
  const text = 'Context detail. '.repeat(400) + '\nFinal constraint: preserve the original records.';
  const prompt = buildTurnPrompt({
    repo: repoFor(), botId: 'b1', groupId: 'g1', triggeredByMessageId: 'long', mention: true,
    contextMessages: [{ messageId: 'long', seq: 9, author: { type: 'human' }, text }],
  });
  assert.ok(prompt.includes(text));
  assert.doesNotMatch(prompt, /已截断/);
});

test('attachment-only messages still render a context line and missing paths are explicit', () => {
  const repo = repoFor();
  const message = {
    messageId: 'm2',
    groupId: 'g1',
    seq: 8,
    author: { type: 'human', name: '用户' },
    kind: 'chat',
    text: '',
    attachments: [
      { attachmentId: 'sha256:' + 'b'.repeat(64), name: 'data.csv', bytes: 2048 },
    ],
    status: 'done',
  };
  const prompt = buildTurnPrompt({
    repo,
    botId: 'b1',
    groupId: 'g1',
    contextMessages: [message],
    triggeredByMessageId: 'm2',
    mention: true,
  });
  assert.match(prompt, /\[#8\] 用户： （仅附件）/);
  assert.match(prompt, /data\.csv/);
  assert.match(prompt, /2\.0 KB/);
  assert.match(prompt, /路径不可用/);
});
