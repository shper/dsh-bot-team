/** Profile-wide chat display preferences. Missing/legacy values keep the feed's hover defaults. */
export const CHAT_DISPLAY_SETTINGS_KEY = 'chat-display-settings';
export const CHAT_DISPLAY_MODES = Object.freeze(['hover', 'always', 'hidden']);
export const DEFAULT_CHAT_DISPLAY_SETTINGS = Object.freeze({
  model: 'hover',
  inputTokens: 'hover',
  outputTokens: 'hover',
  speed: 'hover',
});

export function normalizeChatDisplaySettings(value) {
  const settings = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(DEFAULT_CHAT_DISPLAY_SETTINGS).map(([key, fallback]) => [
    key,
    Object.hasOwn(settings, key) && CHAT_DISPLAY_MODES.includes(settings[key]) ? settings[key] : fallback,
  ]));
}

export function isChatDisplaySettings(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === Object.keys(DEFAULT_CHAT_DISPLAY_SETTINGS).length
    && Object.keys(DEFAULT_CHAT_DISPLAY_SETTINGS).every(key =>
      Object.hasOwn(value, key) && CHAT_DISPLAY_MODES.includes(value[key]));
}
