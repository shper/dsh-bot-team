/**
 * M0 spike — Client half.
 *
 * Loaded into the Web page through window.__ModuleLoader__ (plain JS, React
 * comes from the platform module table). It proves, from inside the real page:
 *   1. a plugin can register a sidebar panel entry and a full page in `main`,
 *   2. the authenticated exact Fetch routes registered by the Host half are
 *      reachable with the page's own Cookie (GET + POST),
 *   3. domain writes triggered from the page survive a re-read,
 *   4. Server-Sent Events work end to end, including auto-reconnect after the
 *      server closes the stream,
 *   5. the page component actually renders when the user opens it.
 *
 * It reports every result back to the Host, which appends them to
 * <resultsDir>/results.jsonl next to the Host self-test output.
 *
 * Throwaway: remove the bundle after M0.
 */
window.__ModuleLoader__.load({
  id: '@local/bot-team-spike',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PAGE_KEY = 'bot-team-spike';
    const ROUTE_BOOTSTRAP = '/api/bot-team-spike.bootstrap';
    const ROUTE_ACTION = '/api/bot-team-spike.action';
    const ROUTE_EVENTS = '/api/bot-team-spike.events';
    const CLIENT_NONCE = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const state = {
      started: false,
      results: [],
      cssInjected: false,
    };

    async function postReport(id, pass, detail) {
      const result = { id, pass: pass === true, detail: detail === undefined ? '' : String(detail), at: Date.now() };
      state.results.push(result);
      try {
        await fetch(ROUTE_ACTION, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'report', source: 'client', results: [result] }),
        });
      } catch {
        // Reporting is best effort; Host may still be booting.
      }
      return result;
    }

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, ok: response.ok, body };
    }

    async function waitForBootstrap(timeoutMs) {
      const startedAt = Date.now();
      let last = null;
      while (Date.now() - startedAt < timeoutMs) {
        try {
          last = await fetchJson(ROUTE_BOOTSTRAP, { method: 'GET' });
          if (last.status === 200 && last.body && last.body.ok) return last;
          if (last.status === 401 || last.status === 403) return last; // auth verdict is final
        } catch (error) {
          last = { status: 0, ok: false, error: String(error) };
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return last || { status: 0, ok: false, error: 'timeout' };
    }

    function sseProbe() {
      return new Promise((resolve) => {
        const observed = { hellos: 0, ticks: 0, byes: 0, errors: 0, reconnects: 0 };
        let source = null;
        let finished = false;
        const finish = (ok, reason) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try {
            source && source.close();
          } catch {}
          resolve({ ok, reason, observed });
        };
        const timer = setTimeout(() => finish(false, `timeout after 35s ${JSON.stringify(observed)}`), 35000);
        const connect = () => {
          source = new EventSource(`${ROUTE_EVENTS}?selfClose=1`);
          source.addEventListener('hello', () => {
            observed.hellos += 1;
            if (observed.hellos >= 2) {
              finish(true, `reconnect observed ${JSON.stringify(observed)}`);
            }
          });
          source.addEventListener('tick', () => {
            observed.ticks += 1;
          });
          source.addEventListener('bye', () => {
            observed.byes += 1;
          });
          source.onerror = () => {
            observed.errors += 1;
            // The test stream self-closes; the EventSource reconnects on its own.
          };
        };
        connect();
      });
    }

    async function runClientSelfTest() {
      if (state.started) return;
      state.started = true;
      await new Promise((resolve) => setTimeout(resolve, 2500));

      // 1. GET route reachable from the page (Cookie auth).
      const bootstrap = await waitForBootstrap(30000);
      await postReport(
        'client.route.bootstrap',
        bootstrap.status === 200 && bootstrap.body && bootstrap.body.ok === true,
        `status=${bootstrap.status} ready=${bootstrap.body && bootstrap.body.ready} domainOpen=${bootstrap.body && bootstrap.body.domainOpen} nonce=${bootstrap.body && bootstrap.body.spikeNonce}`,
      );
      if (!bootstrap.body || !bootstrap.body.ok) {
        await postReport('client.selftest.done', false, 'bootstrap unavailable; later checks skipped');
        return;
      }

      // 2. POST route + domain write.
      const probeKey = `probe-${CLIENT_NONCE}`;
      const posted = await fetchJson(ROUTE_ACTION, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'probe', key: probeKey, nonce: CLIENT_NONCE }),
      });
      await postReport(
        'client.route.action',
        posted.status === 200 && posted.body && posted.body.ok === true && posted.body.key === probeKey,
        `status=${posted.status} body=${JSON.stringify(posted.body).slice(0, 200)}`,
      );

      // 3. The write is visible on a re-read.
      const reread = await fetchJson(ROUTE_BOOTSTRAP, { method: 'GET' });
      const probeKeys = (reread.body && reread.body.probeKeys) || [];
      await postReport(
        'client.route.persist',
        probeKeys.includes(probeKey),
        `probeKeys=${JSON.stringify(probeKeys).slice(0, 300)}`,
      );

      // 4. SSE hello + server-forced close + automatic reconnect.
      const sse = await sseProbe();
      await postReport('client.sse.hello', sse.observed.hellos >= 1, JSON.stringify(sse.observed));
      await postReport(
        'client.sse.reconnect',
        sse.observed.hellos >= 2,
        `reason=${sse.reason}; observed=${JSON.stringify(sse.observed)}`,
      );

      const summary = state.results.map((result) => `${result.id}:${result.pass ? 'pass' : 'fail'}`).join(',');
      await postReport('client.selftest.done', sse.observed.hellos >= 2, summary);
    }

    // ── page view ─────────────────────────────────────────────────────────
    function SpikePage() {
      const [boot, setBoot] = React.useState(null);
      const [error, setError] = React.useState('');
      const [refreshAt, setRefreshAt] = React.useState(0);

      React.useEffect(() => {
        let cancelled = false;
        fetch(ROUTE_BOOTSTRAP, { method: 'GET' })
          .then((response) => response.json())
          .then((body) => {
            if (!cancelled) setBoot(body);
          })
          .catch((reason) => {
            if (!cancelled) setError(String(reason));
          });
        return () => {
          cancelled = true;
        };
      }, [refreshAt]);

      React.useEffect(() => {
        void postReport('client.page.mounted', true, `path=${window.location.pathname}`);
      }, []);

      const hostResults = (boot && boot.hostResults) || [];
      const passed = hostResults.filter((result) => result.pass).length;
      const failed = hostResults.filter((result) => !result.pass).length;

      return h(
        'div',
        {
          style: {
            padding: '28px 32px',
            boxSizing: 'border-box',
            height: '100%',
            overflow: 'auto',
            fontFamily: 'var(--dsh-font-ui, system-ui, sans-serif)',
            color: 'var(--dsw-alias-label-primary, #1f2329)',
          },
        },
        h('h1', { style: { fontSize: 20, margin: '0 0 4px' } }, 'Bot Team · M0 Spike'),
        h(
          'p',
          { style: { margin: '0 0 18px', color: 'var(--dsw-alias-label-secondary, #6b7280)' } },
          '这个页面是一次性技术验证（验证完即卸载）。Host 自测结果会实时出现在下方。',
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 } },
          h(
            'button',
            {
              onClick: () => setRefreshAt(Date.now()),
              style: { padding: '6px 12px', borderRadius: 6, border: '1px solid rgba(0,0,0,0.2)', cursor: 'pointer' },
            },
            '刷新',
          ),
          h('span', { style: { fontSize: 13 } }, `Host 检查：通过 ${passed} / 失败 ${failed}`),
          error ? h('span', { style: { fontSize: 13, color: '#b91c1c' } }, `错误：${error}`) : null,
        ),
        h(
          'table',
          { style: { borderCollapse: 'collapse', width: '100%', fontSize: 13 } },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { style: cellHeader }, '检查项'),
              h('th', { style: cellHeader }, '结果'),
              h('th', { style: cellHeader }, '详情'),
            ),
          ),
          h(
            'tbody',
            null,
            hostResults
              .slice()
              .reverse()
              .map((result) =>
                h(
                  'tr',
                  { key: result.id },
                  h('td', { style: cell }, result.id),
                  h(
                    'td',
                    { style: { ...cell, color: result.pass ? '#15803d' : '#b91c1c' } },
                    result.pass ? 'pass' : 'fail',
                  ),
                  h('td', { style: { ...cell, color: '#6b7280', wordBreak: 'break-all' } }, String(result.detail || '')),
                ),
              ),
          ),
        ),
        h(
          'pre',
          {
            style: {
              marginTop: 18,
              padding: 12,
              background: 'rgba(0,0,0,0.04)',
              borderRadius: 8,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
            },
          },
          JSON.stringify(
            {
              ready: boot && boot.ready,
              domainOpen: boot && boot.domainOpen,
              domainError: boot && boot.domainError,
              bot: boot && boot.bot,
              clientReports: boot && boot.clientReports,
              nonce: boot && boot.spikeNonce,
            },
            null,
            2,
          ),
        ),
      );
    }

    const cell = { border: '1px solid rgba(0,0,0,0.08)', padding: '6px 8px', verticalAlign: 'top' };
    const cellHeader = { ...cell, textAlign: 'left', fontWeight: 600, background: 'rgba(0,0,0,0.03)' };

    function PanelIcon(props) {
      const size = (props && props.size) || 18;
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('circle', { cx: 8, cy: 9, r: 3, fill: '#2f7ed8' }),
        h('circle', { cx: 16, cy: 9, r: 3, fill: '#8b5cf6' }),
        h('path', { d: 'M3 19c0-2.8 2.2-5 5-5s5 2.2 5 5', stroke: '#2f7ed8', strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round' }),
        h('path', { d: 'M13 19c0-2.8 2.2-5 5-5s5 2.2 5 5', stroke: '#8b5cf6', strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Whole page in the keyed `main` slot (same mechanism as Plugin Manager).
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PAGE_KEY }, SpikePage),
        );
        // Sidebar entry; clicking it calls ctx.layout.selectPanel(PAGE_KEY).
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PAGE_KEY, order: 95, label: 'Bot Team Spike' }, PanelIcon),
        );
        // Run the client-side transport checks once the shell settles.
        setTimeout(() => {
          void runClientSelfTest();
        }, 2000);
      },
    };
  },
});
