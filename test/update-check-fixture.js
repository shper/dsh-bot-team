/** Explicit offline dependency injection for services booted by unrelated tests. */
export const offlineUpdateDependencies = {
  updateCheck: {
    getRuntimeVersion: async () => '0.2.1-rc.3',
    fetch: async () => Response.json({
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { name: 'dsh-bot-team', version: '1.0.0', engines: { dsh: '^0.2.1-rc.3' } } },
    }),
  },
};
