/**
 * Host ↔ Client transport: authenticated exact Fetch routes under the `/api`
 * fence (M0-verified). Reads use GET, writes POST JSON, live updates SSE.
 *
 *   GET  /api/bot-team.bootstrap   — bots / groups / members / model catalog
 *   GET  /api/bot-team.messages    — timeline page (?groupId=&afterSeq=&beforeSeq=&limit=)
 *   GET  /api/bot-team.events      — SSE frames for one group
 *   POST /api/bot-team.action      — { action, payload } (groups, direct chats,
 *                                    folders, members, messages, tasks …)
 *   GET  /api/bot-team.file        — persona file read (?botId=&kind=bot, legacy soul|agent)
 *   PUT  /api/bot-team.file        — persona file write (JSON body { botId, kind, text })
 *   POST /api/bot-team.upload      — generic file upload (?name=&groupId=; raw bytes)
 *   GET  /api/bot-team.skills      — user-invocable skills for a group workspace
 */
export const ROUTES = {
  bootstrap: '/api/bot-team.bootstrap',
  messages: '/api/bot-team.messages',
  events: '/api/bot-team.events',
  action: '/api/bot-team.action',
  health: '/api/bot-team.health',
  file: '/api/bot-team.file',
  upload: '/api/bot-team.upload',
  skills: '/api/bot-team.skills',
};

export function registerRoutes(ctx, service) {
  const disposers = [];
  const register = (route) => disposers.push(ctx.connection.fetch.register(route));

  register({
    path: ROUTES.bootstrap,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => service.handleBootstrap(),
  });
  register({
    path: ROUTES.messages,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => service.handleMessages(request),
  });
  register({
    path: ROUTES.events,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => service.handleEvents(request),
  });
  register({
    path: ROUTES.action,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => service.handleActionHttp(request),
  });
  register({
    path: ROUTES.health,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => service.handleHealth(),
  });
  register({
    path: ROUTES.file,
    methods: ['GET', 'PUT'],
    requestBody: 'buffered',
    fetch: (request) => service.handleFileHttp(request),
  });
  register({
    path: ROUTES.upload,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => service.handleUploadHttp(request),
  });
  register({
    path: ROUTES.skills,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => service.handleSkillsHttp(request),
  });

  return async () => {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch {
        /* noop */
      }
    }
  };
}
