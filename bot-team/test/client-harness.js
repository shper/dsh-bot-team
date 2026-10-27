// Isolated component/logic tests for the plain-JS client. Not a browser/layout renderer.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const marker = '    return {\n      inject:';
const exposed = 'DEFAULT_CHAT_DISPLAY_SETTINGS, CHAT_DISPLAY_FIELDS, CHAT_DISPLAY_MODES, normalizeChatDisplaySettings, initialState, reducer, messageMetadataItems, renderMessageMetadata, MessageRow, MessageList, MessageContextMenu, messageActionList, placeMessageMenu, messageMenuHeight, buildQuoteMarkdown, MESSAGE_MENU_WIDTH, TypingDots, Avatar, GroupAvatar, GroupList, WelcomeScreen, GettingStartedDialog, BotFormDialog, ChatSettingsDialog, BotTeamPage, useSse, GLOBAL_CSS, Modal, setTestLocale, uiT, UI_EN, isEnglishUi, withContent, inContent, translateSystemText, ApprovalRow, containModalFocus, SIDEBAR_COLLAPSED_KEY, readSidebarCollapsed, persistSidebarCollapsed, RIGHT_PANEL_COLLAPSED_KEY, readRightPanelCollapsed, persistRightPanelCollapsed, SECTIONS_COLLAPSED_KEY, readSectionsCollapsed, persistSectionsCollapsed, sectionFolderKey, isDirectGroup, replyMentionOf, applyReplyMention, buildSidebarModel, findSidebarGroup, scopeGroupIds, computeGroupDrop, computeFolderDrop, stepGroupOrder, stepFolderOrder, SidebarMenu, FolderFormDialog, GroupFormDialog, DirectPanel, MembersPanel, Composer, ProjectWorkspaceDialog, pickProjectDirectory, formatFileSize, findSkillTrigger, rankSkills, mergeExecutionEvents, emptyExecutionState, mergeExecutionPage, projectExecutionEvents, executionPayload, createExecutionController, useMessageExecution, ExecutionPayload, ExecutionEvent, ExecutionDrawer';

export const plain = value => JSON.parse(JSON.stringify(value));
export function walk(node) {
  if (Array.isArray(node)) return node.flatMap(walk);
  if (!node || typeof node !== 'object') return [];
  return [node, ...walk(node.props?.children), ...walk(node.props?.footer)];
}
export function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  return text(node.props?.children);
}

export function loadClient(options = {}) {
  let definition;
  let cursor = 0;
  const hooks = [];
  const effects = [];
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) } }; },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useReducer(reducer, initial, init) {
      const [state, setState] = React.useState(options.state || (typeof init === 'function' ? init(initial) : initial));
      return [state, action => setState(old => reducer(old, action))];
    },
    useRef(initial) { return React.useState(() => ({ current: initial }))[0]; },
    useCallback(fn) { return fn; },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!options.lifecycleEffects) { effects.push(fn); return; }
      const previous = hooks[index];
      if (previous && deps && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return;
      const entry = { deps, cleanup: previous?.cleanup };
      hooks[index] = entry;
      effects.push(() => { entry.cleanup?.(); entry.cleanup = fn(); return entry.cleanup; });
    },
  };
  const context = vm.createContext({
    window: {
      __ModuleLoader__: { load(value) { definition = value; } },
      localStorage: options.localStorage,
      ...options.window,
    },
    console, URL, Blob, AbortController,
    document: options.document, navigator: options.navigator,
    setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout,
    requestAnimationFrame: callback => { callback(0); return 1; },
    cancelAnimationFrame: () => {},
    fetch: options.fetch || (() => { throw new Error('Unexpected network request in client unit test'); }),
    EventSource: options.EventSource,
  });
  assert.ok(source.includes(marker), 'test export anchor exists');
  vm.runInContext(source.replace(marker, `    return {\n      __test: { ${exposed} },\n      inject:`), context, { filename: 'client.js' });
  assert.equal(definition.id, pkg.name, 'client bundle id must equal the package name');
  const module = definition.factory(name => {
    if (name === 'react') return React;
    throw new Error('No external modules in isolated test: ' + name);
  });
  return {
    ...module.__test,
    apply: module.apply,
    inject: module.inject,
    effects,
    flushEffects() { for (const effect of effects.splice(0)) effect(); },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); hooks.length = 0; effects.length = 0; },
    render(component, props) { cursor = 0; return component(props); },
    remount(component, props) { cursor = 0; hooks.length = 0; effects.length = 0; return component(props); },
  };
}
