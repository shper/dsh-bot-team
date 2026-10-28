import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadClient, plain, walk, text } from './client-harness.js';

const ART_IDS = ['bot-orbit', 'bot-spark', 'bot-circuit', 'bot-pixel', 'bot-scout', 'bot-assistant', 'bot-core', 'bot-android'];
const PALETTE_IDS = ['sky', 'violet', 'mint', 'orange', 'pink', 'indigo', 'teal', 'slate'];
const noop = () => {};
const modelCatalog = { groups: [{ id: 'deepseek', models: [{ id: 'deepseek-chat' }] }] };

// Captured from the original rendered illustrations before palette support.
// Hash the drawing's sorted SVG attributes, including fills/strokes, so unchanged
// defaults are checked without duplicating the production drawing functions.
const DEFAULT_DRAWINGS = {
  'bot-orbit': '4ce3a2ab2ae3bf6a2b65ed3f9a88932364b1027de2d103001b452284ac43aff0',
  'bot-spark': '3806cb003b1383a7a6fd6f1910dea8874eb0e92862457e8183146e350d287eb9',
  'bot-circuit': '92fef25afbaea8f850afb1c8a3519c4cce1dacfebee7df8585b96c9ebc68e847',
  'bot-pixel': '66b2b4feda663b94e16b0281afa432f6ee461055977909065ba95e1845044a0f',
  'bot-scout': 'ffa7ac4ce15aa2421d625de8a9c14643850a32de3040ecf3231c4d578e2bdccc',
  'bot-assistant': '88ca05c9162df7fbc374a4d251b3fcaa558660ccdbaa1070f8b3306bb3788c3e',
  'bot-core': 'a686affefb8013edef81404aec622c91a47d06c9b13afc909bd7f2975dd3260e',
  'bot-android': 'de31b1ddca97fb70a002619599e7e037f82a83719f7d5752c2f1a1ed42ec2842',
  planet: '195c4ab8d68784bc476a2541c15d40124cf3874e39ee14792e450ba9354f54ee',
  rocket: '8d34bfb362402b4dd00a8bb25c65f10046f893245837eadf22b0515439fffcf8',
  cloud: 'fce6b5b55ecfb998a4eb44766429026e6c08a00b23e4a90ae19da822f9b1711e',
  bolt: 'cfd7e078494b6c595917770981b90b701c4d9aca0e2777c36087154da1d16a6c',
  leaf: '6795a48fd6007b0b2f036d5b45040458f528628441d2f2fea543158d86003d13',
  flame: 'a195f8787bf2ca64acb685ceb189fe7ce10fe93fe4db0d3a3184505df4ae84de',
  star: '3dddc60413e0465a6c9ef0a9b296e6c6ea36b664cfcbb3ff20789d31b28cab8c',
  moon: 'f29621a7688d5a46003b0e07f49d86e661e68008a33921a2004c2bbc5eb27c80',
  wave: 'd5da6cc3efa2d79ec4279c16ac1aa835e345a3706a9b42b925564113eec6ec39',
  flower: 'df3cc2a49b372622e8120c0ad531a6208fb505003140db36e99ef2b6730325d0',
  'group-team': 'a34b2db4277645b618ba2e5031825943352ccad848a25917aa7d0748be92464b',
  'group-bots': '7d3f4c41a3573645b3972b4b7e6294d06ffcfd28e3ef2485f732f1f242dec8a7',
  'group-network': '14542f7f111cb7a8ce1785625686f107dd0e23632f7bf7e5cada0f8895487844',
  'group-dialogue': '07c70774cd0a160bbee48c6a0c7a0228830f009aa1c5ae8017e0bbee745021e3',
  'group-lab': 'c417c3aeff792f368116f3720b7aa04884490b9755de9411c922de352deda4fa',
  'group-huddle': '974aec9d2b891bb809ca6281a9a1555c06d039515b24a80a806f1b4d51a652fb',
  'group-swarm': '5464d8865171dbd9f1ad2a3396f4d7734bfc1f8ab63143ea369cc433c098dc63',
  'group-community': 'f34851a25cd4c54ce01b6efb1059c02b9eba38bc60fc7560b1d4d184bea8f79b',
};

function randomSequence(values) {
  let calls = 0;
  return {
    random() {
      assert.ok(calls < values.length, 'rendering and non-random controls must not consume randomness');
      return values[calls++];
    },
    assertConsumed() { assert.equal(calls, values.length, 'each random click consumes a shape and a palette/seed draw'); },
  };
}

function formFixture(values = [], bot) {
  const sequence = randomSequence(values);
  const client = loadClient({ random: sequence.random });
  const props = { bot, modelCatalog, onClose: noop, onSaved: noop };
  return { client, ...sequence, render: () => client.render(client.BotFormDialog, props) };
}

function button(tree, label) {
  const matches = walk(tree).filter(node => node.type === 'button' && text(node) === label);
  assert.equal(matches.length, 1, `one real ${label} button`);
  assert.notEqual(matches[0].props.disabled, true);
  assert.equal(typeof matches[0].props.onClick, 'function');
  return matches[0];
}

function presetButtons(tree) {
  const picker = walk(tree).find(node => node.props?.role === 'group' && node.props['aria-label'] === '预置头像');
  assert.ok(picker, 'the preset picker is accessible');
  return walk(picker).filter(node => node.type === 'button');
}

function selectedPresets(tree) {
  return presetButtons(tree).filter(node => node.props['aria-pressed']).map(node => node.props.key);
}

function preview(client, tree) {
  const matches = walk(tree).filter(node => node.type === client.Avatar);
  assert.equal(matches.length, 1, 'one Bot avatar preview');
  return matches[0];
}

// Only resolve the avatar subtree: the dialog and its children own separate hooks.
function resolveComponents(node) {
  if (Array.isArray(node)) return node.map(resolveComponents);
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return resolveComponents(node.type(node.props));
  return { type: node.type, props: { ...node.props, children: resolveComponents(node.props.children) } };
}

function svgFrom(node) {
  const resolved = resolveComponents(node);
  const svgs = walk(resolved).filter(candidate => candidate.type === 'svg');
  assert.equal(svgs.length, 1, 'the avatar resolves to an SVG illustration');
  for (const candidate of walk(resolved)) {
    assert.ok(!candidate.props.filter && !candidate.props.style?.filter && !candidate.props.style?.WebkitFilter, 'colors are rendered without filters');
  }
  return svgs[0];
}

function renderAvatar(client, kind, avatar) {
  return svgFrom(kind === 'bot'
    ? client.Avatar({ bot: { name: 'Avatar Bot', avatar }, size: 40 })
    : client.GroupAvatar({ group: { title: 'Avatar group', avatar }, size: 40 }));
}

function drawing(svg) {
  return plain(walk(svg).slice(1).map(node => ({
    type: node.type,
    props: Object.fromEntries(Object.entries(node.props)
      .filter(([key]) => key !== 'children' && key !== 'key')
      .sort(([a], [b]) => a.localeCompare(b))),
  })));
}

function geometry(svg) {
  return drawing(svg).map(({ type, props }) => ({
    type,
    props: Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'fill' && key !== 'stroke')),
  }));
}

function bodyColors(svg, attribute) {
  const body = walk(svg).find(node => node.type === 'g');
  assert.ok(body, 'a Bot illustration has a body separate from its background');
  return walk(body).map(node => node.props[attribute]).filter(color => color && color !== 'none');
}

function assertDefaultDrawing(svg, id) {
  const hash = createHash('sha256').update(JSON.stringify(drawing(svg))).digest('hex');
  assert.equal(hash, DEFAULT_DRAWINGS[id], `${id} retains its original geometry and colors`);
}

test('the real random button reaches all eight Bot illustrations and all eight palette choices', () => {
  const cases = ART_IDS.flatMap((id, shape) => PALETTE_IDS.map((palette, color) => ({
    id, palette, random: [(shape + 0.5) / 9, (color + 0.5) / 8],
  })));
  const fixture = formFixture(cases.flatMap(entry => entry.random));
  let tree = fixture.render();
  assert.deepEqual(presetButtons(tree).map(node => node.props.key), ART_IDS);
  assert.deepEqual(selectedPresets(tree), []);
  for (const { id, palette } of cases) {
    button(tree, '随机生成').props.onClick();
    tree = fixture.render();
    assert.equal(preview(fixture.client, tree).props.bot.avatar, `art:${id}:${palette}`);
    assert.deepEqual(selectedPresets(tree), [id], `${id}:${palette} highlights its shape`);
    assert.deepEqual(geometry(svgFrom(preview(fixture.client, tree))), geometry(renderAvatar(fixture.client, 'bot', `art:${id}`)));
  }
  fixture.assertConsumed();
});

test('random range endpoints select the first art, last art, and legacy robot with its second random seed', () => {
  const fixture = formFixture([0, 0, 8 / 9 - Number.EPSILON, 1 - Number.EPSILON, 8 / 9, 0.25, 1 - Number.EPSILON, 0.75]);
  let tree = fixture.render();
  for (const expected of ['art:bot-orbit:sky', 'art:bot-android:slate', /^preset:r-[a-z0-9]+-9$/, /^preset:r-[a-z0-9]+-r$/]) {
    button(tree, '随机生成').props.onClick();
    tree = fixture.render();
    const avatar = preview(fixture.client, tree).props.bot.avatar;
    if (typeof expected === 'string') {
      assert.equal(avatar, expected);
    } else {
      assert.match(avatar, expected, 'legacy seed uses the second random sample');
      assert.deepEqual(selectedPresets(tree), []);
      const svg = svgFrom(preview(fixture.client, tree));
      assert.ok(walk(svg).some(node => node.type === 'linearGradient'), 'legacy selection still renders the robot mascot');
      assert.deepEqual(plain(svgFrom(preview(fixture.client, fixture.render()))), plain(svg), 'the legacy seed is stable across renders');
    }
  }
  fixture.assertConsumed();
});

test('both avatar renderers change body fills, strokes, and background while preserving every Bot silhouette', () => {
  const fixture = formFixture();
  for (const id of ART_IDS) {
    const original = renderAvatar(fixture.client, 'bot', `art:${id}`);
    const fills = new Set();
    const strokes = new Set();
    const backgrounds = new Set();
    for (const palette of PALETTE_IDS) {
      const avatar = `art:${id}:${palette}`;
      const svg = renderAvatar(fixture.client, 'bot', avatar);
      assert.deepEqual(geometry(svg), geometry(original), `${avatar} keeps the original SVG geometry`);
      const fillColors = bodyColors(svg, 'fill');
      const strokeColors = bodyColors(svg, 'stroke');
      assert.ok(fillColors.length > 0);
      for (const color of [...fillColors, ...strokeColors]) {
        assert.match(color, /^(?:#[0-9a-f]{3,8}|rgba?[(][^)]+[)])$/i, 'body colors are explicit SVG colors');
      }
      const background = svg.props.children.find(node => node.type === 'rect');
      assert.equal(svg.props.style.background, background.props.fill, 'CSS and SVG backgrounds agree');
      fills.add(JSON.stringify(fillColors));
      strokes.add(JSON.stringify(strokeColors));
      backgrounds.add(background.props.fill);
      const groupSvg = renderAvatar(fixture.client, 'group', avatar);
      assert.deepEqual(drawing(groupSvg), drawing(svg), 'GroupAvatar renders the same colored Bot illustration');
      assert.deepEqual(plain(renderAvatar(fixture.client, 'bot', avatar)), plain(svg), 'Bot colors are stable across renders');
      assert.deepEqual(plain(renderAvatar(fixture.client, 'group', avatar)), plain(groupSvg), 'group colors are stable across renders');
    }
    assert.equal(fills.size, PALETTE_IDS.length, `${id} changes body fills for every palette`);
    assert.equal(backgrounds.size, PALETTE_IDS.length, `${id} changes its background for every palette`);
    if (bodyColors(original, 'stroke').length) assert.ok(strokes.size > 1, `${id} also changes body strokes`);
    assertDefaultDrawing(renderAvatar(fixture.client, 'bot', `art:${id}`), id);
  }
  fixture.assertConsumed();
});

test('unqualified existing art values keep their original drawings in Avatar and GroupAvatar', () => {
  const client = loadClient();
  for (const id of Object.keys(DEFAULT_DRAWINGS)) {
    for (const kind of ['bot', 'group']) assertDefaultDrawing(renderAvatar(client, kind, `art:${id}`), id);
  }
});

test('reopening any colored Bot selects its preset, and clicking that preset restores the original colors', () => {
  for (const id of ART_IDS) {
    for (const palette of PALETTE_IDS) {
      const fixture = formFixture([], { botId: 'bot-1', name: 'Avatar Bot', provider: 'deepseek', model: 'deepseek-chat', avatar: `art:${id}:${palette}` });
      let tree = fixture.render();
      assert.deepEqual(selectedPresets(tree), [id], 'a saved palette variant highlights the matching shape');
      const selected = presetButtons(tree).find(node => node.props.key === id);
      const selectedStyle = plain(selected.props.style);
      selected.props.onClick();
      tree = fixture.render();
      assert.equal(preview(fixture.client, tree).props.bot.avatar, `art:${id}`, 'preset clicks remove the randomized palette');
      assert.deepEqual(selectedPresets(tree), [id]);
      assert.deepEqual(plain(presetButtons(tree).find(node => node.props.key === id).props.style), selectedStyle, 'colored and default selections have the same visible highlight');
      assertDefaultDrawing(svgFrom(preview(fixture.client, tree)), id);
      fixture.assertConsumed();
    }
  }
});

test('reset clears randomized art and legacy avatars and restores the default generated robot', () => {
  const fixture = formFixture([0.4, 0.6, 0.99, 0.25]);
  let tree = fixture.render();
  const original = plain(svgFrom(preview(fixture.client, tree)));
  for (const expected of ['art:bot-pixel:pink', 'legacy']) {
    button(tree, '随机生成').props.onClick();
    tree = fixture.render();
    const avatar = preview(fixture.client, tree).props.bot.avatar;
    if (expected === 'legacy') assert.match(avatar, /^preset:r-/);
    else assert.equal(avatar, expected);
    button(tree, '重置').props.onClick();
    tree = fixture.render();
    assert.equal(preview(fixture.client, tree).props.bot.avatar, '');
    assert.deepEqual(selectedPresets(tree), []);
    assert.deepEqual(plain(svgFrom(preview(fixture.client, tree))), original);
    assert.ok(!walk(tree).some(node => node.type === 'button' && text(node) === '重置'), 'reset disappears when there is no custom selection');
  }
  fixture.assertConsumed();
});
