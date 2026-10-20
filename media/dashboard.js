// @ts-check
// PR Reminder dashboard webview script.
// All untrusted strings (PR titles, comments, logins) are rendered with textContent only.
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let state = null;
  let filters = saved.filters || { repo: '', status: 'open', reviewer: '', q: '' };
  let view = saved.view || 'overview';
  let activityFilter = saved.activityFilter || 'all';
  let mappingDraft = null; // array of {login, email, phone} while in edit mode; null = view mode
  let mappingErrors = {}; // row index -> { field: message }
  let saveError = null;
  let saving = false;
  let justSaved = false;
  const app = document.getElementById('app');

  const VIEWS = [
    { id: 'overview', label: 'Overview', icon: 'home' },
    { id: 'prs', label: 'Pull requests', icon: 'pr' },
    { id: 'activity', label: 'Activity', icon: 'bell' },
    { id: 'channels', label: 'Channels', icon: 'send' },
    { id: 'mapping', label: 'Reviewers', icon: 'people' },
  ];

  // Minimal stroke icons (24x24 viewBox), drawn with DOM APIs so the CSP stays strict.
  const ICONS = {
    home: ['M3 11l9-7 9 7', 'M5 10v10h14V10', 'M10 20v-6h4v6'],
    pr: ['M6 3a2 2 0 1 0 0 4a2 2 0 1 0 0-4', 'M6 7v10', 'M6 17a2 2 0 1 0 0 4a2 2 0 1 0 0-4', 'M18 17a2 2 0 1 0 0 4a2 2 0 1 0 0-4', 'M18 17V9a3 3 0 0 0-3-3h-4', 'M13 3l-3 3l3 3'],
    bell: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 20a2 2 0 0 0 4 0'],
    send: ['M3 11l18-8l-8 18l-2-8z', 'M11 13l10-10'],
    people: ['M9 7a3 3 0 1 0 0 6a3 3 0 1 0 0-6', 'M3 20a6 6 0 0 1 12 0', 'M16 5a3 3 0 0 1 0 6', 'M18 14a5 5 0 0 1 3 6'],
    refresh: ['M20 11a8 8 0 1 0-2 6', 'M20 4v7h-7'],
    pause: ['M8 5v14', 'M16 5v14'],
    play: ['M7 4l13 8l-13 8z'],
    gear: ['M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6', 'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3', 'M4.9 4.9l2.1 2.1', 'M17 17l2.1 2.1', 'M4.9 19.1L7 17', 'M17 7l2.1-2.1'],
    search: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14', 'M16 16l5 5'],
    check: ['M4 12l5 5L20 6'],
    clock: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M12 7v5l3 3'],
    plus: ['M12 5v14', 'M5 12h14'],
    trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
    warn: ['M12 3l10 18H2z', 'M12 10v4', 'M12 17v.5'],
    pencil: ['M4 20h4l11-11l-4-4L4 16z', 'M13.5 6.5l4 4'],
    zap: ['M13 2L4 14h7l-1 8l9-12h-7z'],
  };

  function icon(name, cls) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icon ' + (cls || ''));
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name] || []) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  /** @param {string} tag @param {Record<string, any>} [attrs] @param {(Node|string|null|undefined|false)[]} [children] */
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children || []) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  const send = (msg) => vscode.postMessage(msg);

  function persist() {
    vscode.setState({ filters, view, activityFilter });
  }

  function rel(iso) {
    if (!iso) return '—';
    const t = typeof iso === 'number' ? iso : Date.parse(iso);
    const diff = t - Date.now();
    const mins = Math.round(Math.abs(diff) / 60000);
    if (mins < 1) return 'now';
    const s = mins < 60 ? mins + 'm' : mins < 2880 ? Math.round(mins / 60) + 'h' : Math.round(mins / 1440) + 'd';
    return diff >= 0 ? 'in ' + s : s + ' ago';
  }

  function badge(text, kind) {
    return h('span', { class: 'badge ' + (kind || ''), text });
  }

  function link(text, url, cls) {
    return h('a', { href: '#', class: cls || '', onclick: (e) => { e.preventDefault(); send({ type: 'openUrl', url }); }, text });
  }

  /** @param {string} text @param {() => void} onclick @param {string} [kind] @param {string} [iconName] */
  function button(text, onclick, kind, iconName) {
    return h('button', { class: 'btn ' + (kind || ''), onclick, title: text }, [iconName ? icon(iconName) : null, text ? h('span', { text }) : null]);
  }

  function select(value, options, onchange) {
    const el = h('select', { onchange: (e) => onchange(e.target.value) }, options.map(([v, label]) => h('option', { value: v, text: label })));
    el.value = value;
    return el;
  }

  function empty(iconName, title, text, action) {
    return h('div', { class: 'empty' }, [icon(iconName, 'empty-icon'), h('div', { class: 'empty-title', text: title }), text ? h('div', { class: 'muted', text }) : null, action || null]);
  }

  function panel(title, children, actions, subtitle) {
    return h('div', { class: 'panel' }, [
      title ? h('div', { class: 'panel-head' }, [h('div', {}, [h('h3', { text: title }), subtitle ? h('div', { class: 'muted small', text: subtitle }) : null]), actions ? h('div', { class: 'actions' }, actions) : null]) : null,
      ...children,
    ]);
  }

  function goTo(id) {
    view = id;
    persist();
    render(true);
    const main = document.querySelector('.main');
    if (main) main.scrollTop = 0;
  }

  // ---------- derived data ----------

  function counts() {
    const prs = state.prs || [];
    const open = prs.filter((p) => p.state === 'open');
    const awaiting = open.filter((p) => p.reviewers.some((r) => r.status === 'pending'));
    const alerts = (state.alerts && state.alerts.open) || [];
    const unmapped = (state.unmapped || []).length;
    const failed = (state.failedMessages || []).length;
    return { prs, open, awaiting, alerts, unmapped, failed };
  }

  // ---------- shell ----------

  function renderSidebar(c) {
    const s = state.status;
    const conn = state.connection;
    const navBadge = { prs: c.awaiting.length || null, activity: c.alerts.length || null, mapping: c.unmapped || null, channels: c.failed || null };
    const navAlert = { activity: c.alerts.some((e) => e.severity === 'high'), mapping: c.unmapped > 0, channels: c.failed > 0 };
    const connected = conn.state === 'connected';
    return h('nav', { class: 'sidebar', 'aria-label': 'Dashboard sections' }, [
      h('div', { class: 'brand' }, [
        h('div', { class: 'brand-mark' }, [icon('pr')]),
        h('div', { class: 'brand-text' }, [h('div', { class: 'brand-name', text: 'PR Reminder' }), h('div', { class: 'brand-user muted small', text: s && s.githubUser ? '@' + s.githubUser : 'GitHub not connected' })]),
      ]),
      h('ul', { class: 'nav', role: 'tablist' }, VIEWS.map((v) =>
        h('li', {}, [
          h('button', { class: 'nav-item nav-' + v.id + (view === v.id ? ' active' : ''), role: 'tab', 'aria-selected': view === v.id ? 'true' : 'false', onclick: () => goTo(v.id), title: v.label }, [
            icon(v.icon),
            h('span', { class: 'nav-label', text: v.label }),
            navBadge[v.id] ? h('span', { class: 'nav-count' + (navAlert[v.id] ? ' alert' : ''), text: String(navBadge[v.id]) }) : null,
          ]),
        ]))),
      h('div', { class: 'sidebar-foot' }, [
        h('div', { class: 'conn' }, [h('span', { class: 'dot ' + (connected ? 'ok' : 'bad') }), h('span', { class: 'small', text: connected ? 'Service connected' : 'Service ' + conn.state })]),
        h('div', { class: 'muted small', text: s ? 'Synced ' + rel(s.lastSyncAt) : '' }),
      ]),
    ]);
  }

  function renderHeader(title, subtitle, actions) {
    return h('header', { class: 'view-head' }, [
      h('div', {}, [h('h1', { text: title }), subtitle ? h('div', { class: 'muted', text: subtitle }) : null]),
      h('div', { class: 'actions' }, actions || []),
    ]);
  }

  function renderBanner(c) {
    const open = c.alerts;
    if (open.length === 0) return null;
    const high = open.filter((e) => e.severity === 'high');
    const snoozed = state.alerts.snoozedUntil && state.alerts.snoozedUntil > Date.now();
    return h('div', { class: 'alert-banner ' + (high.length ? 'high ' : '') + (high.length && !snoozed ? 'flash' : ''), role: 'alert' }, [
      h('div', { class: 'alert-icon' }, [icon('bell')]),
      h('div', { class: 'alert-body' }, [
        h('div', { class: 'alert-title', text: open.length + ' unacknowledged alert' + (open.length === 1 ? '' : 's') + (high.length ? ' · ' + high.length + ' high priority' : '') + (snoozed ? ' · snoozed ' + rel(state.alerts.snoozedUntil).replace('in ', 'for ') : '') }),
        h('ul', { class: 'alert-list' }, open.slice(0, 3).map((e) => h('li', {}, [badge(e.severity, e.severity), link(e.repo + '#' + e.number, e.url, 'mono'), h('span', { class: 'ellipsis', text: e.summary })]))),
        open.length > 3 ? h('a', { href: '#', class: 'small', onclick: (e) => { e.preventDefault(); goTo('activity'); }, text: 'View all ' + open.length + ' →' }) : null,
      ]),
      h('div', { class: 'actions' }, [button('Acknowledge all', () => send({ type: 'ack', ids: 'all' }), 'primary', 'check'), button('Snooze', () => send({ type: 'snooze' }), '', 'clock')]),
    ]);
  }

  function renderWarnings(c) {
    const items = [];
    if (state.connection.error) items.push(h('div', { class: 'notice bad' }, [icon('warn'), h('span', { text: state.connection.error })]));
    const s = state.status;
    if (s && s.lastSyncError) items.push(h('div', { class: 'notice bad' }, [icon('warn'), h('span', { text: 'Sync failed: ' + s.lastSyncError })]));
    if (state.error) items.push(h('div', { class: 'notice bad' }, [icon('warn'), h('span', { text: state.error })]));
    if (s && !s.baselineComplete) items.push(h('div', { class: 'notice info' }, [icon('clock'), h('span', { text: 'Initial sync in progress — existing activity is recorded as a baseline and will not alert.' })]));
    if (c.unmapped) {
      items.push(h('div', { class: 'notice warn' }, [icon('people'), h('span', { text: c.unmapped + ' reviewer' + (c.unmapped === 1 ? ' has' : 's have') + ' no email or WhatsApp number and won\'t be reminded.' }), button('Fix', () => goTo('mapping'), 'small')]));
    }
    if (c.failed) {
      items.push(h('div', { class: 'notice warn' }, [icon('warn'), h('span', { text: c.failed + ' reviewer message' + (c.failed === 1 ? '' : 's') + ' failed to send.' }), button('Retry', () => send({ type: 'retryMessages' }), 'small'), button('Clear', () => send({ type: 'clearMessages' }), 'small ghost'), button('Details', () => goTo('channels'), 'small ghost')]));
    }
    return items.length ? h('div', { class: 'notices' }, items) : null;
  }

  // ---------- views ----------

  function stat(label, value, kind, onclick, hint) {
    return h(onclick ? 'button' : 'div', { class: 'stat ' + (kind || '') + (onclick ? ' clickable' : ''), onclick }, [
      h('div', { class: 'stat-v', text: value }),
      h('div', { class: 'stat-k', text: label }),
      hint ? h('div', { class: 'stat-hint muted small', text: hint }) : null,
    ]);
  }

  function renderOverview(c) {
    const s = state.status;
    const conn = state.connection;
    const paused = s && s.globalPaused;
    const stats = h('div', { class: 'stats' }, [
      stat('Open PRs', String(c.open.length), '', () => { filters = { ...filters, status: 'open' }; goTo('prs'); }),
      stat('Awaiting review', String(c.awaiting.length), c.awaiting.length ? 'warn' : 'ok', () => { filters = { ...filters, status: 'needs-review' }; goTo('prs'); }),
      stat('Unread alerts', String(c.alerts.length), c.alerts.length ? 'bad' : 'ok', () => goTo('activity')),
      stat('Queued messages', s ? String(s.pendingMessages) : '—', '', null, c.failed ? c.failed + ' failed' : null),
    ]);
    const health = [
      ['Service', conn.state === 'connected' ? 'Connected' : conn.state, conn.state === 'connected' ? 'ok' : 'bad'],
      ['GitHub', s ? (s.githubConfigured ? '@' + (s.githubUser || '?') : 'Not configured') : '—', s && s.githubConfigured ? 'ok' : 'bad'],
      ['Google Chat', s ? (s.chatConfigured ? 'Signed in' : 'Not signed in') : '—', s && s.chatConfigured ? 'ok' : 'warn'],
      ['WhatsApp', s ? (s.whatsappLinked && !s.whatsappError ? 'Linked' : s.whatsappError ? 'Error' : 'Not linked') : '—', s && s.whatsappLinked && !s.whatsappError ? 'ok' : state.channels && state.channels.whatsapp ? 'warn' : 'off'],
      ['Reminders', s ? (paused ? 'Paused' : 'Active') : '—', paused ? 'warn' : 'ok'],
      ['Last sync', s ? rel(s.lastSyncAt) : '—', s && s.lastSyncError ? 'warn' : 'ok'],
      ['API quota', s && s.rateLimit.remaining !== null ? s.rateLimit.remaining + ' / ' + s.rateLimit.limit : '—', ''],
    ];
    const healthList = h('div', { class: 'health' }, health.map(([k, v, cls]) => h('div', { class: 'health-row' }, [h('span', { class: 'dot ' + cls }), h('span', { class: 'health-k muted', text: k }), h('span', { class: 'health-v', text: v })])));
    const recent = (state.events || []).slice(0, 6);
    const attention = c.awaiting.slice().sort((a, b) => (Date.parse(a.nextReminderAt || '') || Infinity) - (Date.parse(b.nextReminderAt || '') || Infinity)).slice(0, 5);
    return [
      renderHeader('Overview', paused ? 'Reminders are paused' : 'Monitoring your pull requests', [
        button('Refresh', () => send({ type: 'refresh' }), '', 'refresh'),
        paused ? button('Resume all', () => send({ type: 'resume' }), 'primary', 'play') : button('Pause all', () => send({ type: 'pause' }), '', 'pause'),
        button('Setup', () => send({ type: 'setup' }), 'ghost', 'gear'),
      ]),
      renderBanner(c),
      renderWarnings(c),
      stats,
      h('div', { class: 'grid-2' }, [
        panel('Needs attention', [attention.length ? h('div', { class: 'mini-list' }, attention.map((p) => h('div', { class: 'mini-row' }, [
          h('div', { class: 'mini-main' }, [link(p.title, p.url, 'mini-title'), h('div', { class: 'muted small mono', text: p.repo + '#' + p.number })]),
          h('div', { class: 'mini-side muted small', text: p.paused ? 'paused' : 'next ' + rel(p.nextReminderAt) }),
        ]))) : empty('check', 'All caught up', 'No PRs are waiting on reviewers.')], [button('View all', () => { filters = { ...filters, status: 'needs-review' }; goTo('prs'); }, 'small ghost')]),
        panel('Health', [healthList]),
      ]),
      panel('Recent activity', [recent.length ? renderEventList(recent) : empty('bell', 'No activity yet', 'Events appear here as your PRs change.')], [button('View all', () => goTo('activity'), 'small ghost')]),
    ];
  }

  function renderPrs(c) {
    const prs = c.prs;
    const repos = [...new Set(prs.map((p) => p.repo))].sort();
    const reviewers = [...new Set(prs.flatMap((p) => p.reviewers.map((r) => r.login)))].sort();
    const q = (filters.q || '').toLowerCase();
    const filtered = prs.filter((p) => {
      if (filters.repo && p.repo !== filters.repo) return false;
      if (filters.status === 'needs-review' && !(p.state === 'open' && p.reviewers.some((r) => r.status === 'pending'))) return false;
      if (filters.status && filters.status !== 'needs-review' && p.state !== filters.status) return false;
      if (filters.reviewer && !p.reviewers.some((r) => r.login === filters.reviewer)) return false;
      if (q && !(p.title.toLowerCase().includes(q) || (p.repo + '#' + p.number).toLowerCase().includes(q))) return false;
      return true;
    });
    const update = (k) => (v) => { filters = { ...filters, [k]: v }; persist(); render(true); };
    const statusChips = [['open', 'Open'], ['needs-review', 'Awaiting review'], ['merged', 'Merged'], ['closed', 'Closed'], ['', 'All']];
    const toolbar = h('div', { class: 'toolbar' }, [
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Status filter' }, statusChips.map(([v, label]) => h('button', { class: 'chip' + (filters.status === v ? ' active' : ''), onclick: () => update('status')(v), text: label }))),
      h('div', { class: 'toolbar-right' }, [
        h('div', { class: 'search' }, [icon('search'), h('input', { type: 'search', placeholder: 'Search PRs', value: filters.q || '', 'data-keep': 'prs-search', oninput: (e) => { filters = { ...filters, q: e.target.value }; persist(); render(true); } })]),
        select(filters.repo, [['', 'All repositories'], ...repos.map((r) => [r, r])], update('repo')),
        select(filters.reviewer, [['', 'All reviewers'], ...reviewers.map((r) => [r, r])], update('reviewer')),
      ]),
    ]);
    const ciKind = { success: 'ok', failure: 'bad', pending: 'warn', none: '' };
    const cards = filtered.map((p) => {
      const stateKind = p.state === 'open' ? 'ok' : p.state === 'merged' ? 'merged' : 'bad';
      const pending = p.state === 'open' && p.reviewers.filter((r) => r.status === 'pending');
      const cardKind = !pending ? stateKind : pending.some((r) => !r.mapped) || p.ciState === 'failure' ? 'blocked' : pending.length ? 'waiting' : stateKind;
      return h('article', { class: 'pr-card ' + cardKind }, [
        h('div', { class: 'pr-top' }, [
          h('div', { class: 'pr-id' }, [link(p.repo + '#' + p.number, p.url, 'mono muted small'), badge(p.state, stateKind), p.draft ? badge('draft') : null, p.paused ? badge('paused', 'warn') : null, p.ciState && p.ciState !== 'none' ? badge('CI ' + p.ciState, ciKind[p.ciState]) : null]),
          h('div', { class: 'actions' }, [
            p.state === 'open' ? (p.paused ? button('Resume', () => send({ type: 'resume', prKey: p.key }), 'small', 'play') : button('Pause', () => send({ type: 'pause', prKey: p.key }), 'small ghost', 'pause')) : null,
            button('', () => send({ type: 'openUrl', url: p.url }), 'small ghost icon-only', 'external'),
          ]),
        ]),
        link(p.title, p.url, 'pr-title'),
        h('div', { class: 'reviewers' }, p.reviewers.length ? p.reviewers.map((r) => {
          const kind = r.status === 'pending' ? (r.mapped ? 'warn' : 'bad') : r.status === 'responded' ? 'ok' : '';
          const label = r.status === 'pending' ? (r.mapped ? 'pending · ' + r.reminderCount + ' sent' : 'not mapped') : r.status === 'responded' ? (r.reviewState || 'responded').toLowerCase().replace(/_/g, ' ') : 'removed';
          return h('span', { class: 'reviewer ' + kind }, [h('span', { class: 'avatar', text: r.login.replace(/^@/, '').charAt(0).toUpperCase() }), h('span', { text: (r.kind === 'team' ? '' : '@') + r.login }), h('span', { class: 'reviewer-state', text: label })]);
        }) : [h('span', { class: 'muted small', text: 'No reviewers requested' })]),
        h('div', { class: 'pr-meta muted small' }, [
          h('span', {}, [icon('send'), 'Last notified ' + rel(p.lastNotifiedAt)]),
          p.state === 'open' ? h('span', {}, [icon('clock'), p.paused ? 'Reminders paused' : 'Next reminder ' + rel(p.nextReminderAt)]) : null,
        ]),
      ]);
    });
    return [
      renderHeader('Pull requests', filtered.length + ' of ' + prs.length + ' shown', [button('Refresh', () => send({ type: 'refresh' }), '', 'refresh')]),
      toolbar,
      cards.length ? h('div', { class: 'pr-list' }, cards) : panel(null, [empty('pr', 'No pull requests match', 'Try a different filter.', button('Clear filters', () => { filters = { repo: '', status: '', reviewer: '', q: '' }; persist(); render(true); }, 'small'))]),
    ];
  }

  function renderEventList(events) {
    return h('ul', { class: 'timeline' }, events.map((e) =>
      h('li', { class: 'event ' + (e.acknowledged ? '' : 'unread ') + (e.severity || '') }, [
        h('span', { class: 'event-dot' }),
        h('div', { class: 'event-body' }, [
          h('div', { class: 'event-line' }, [h('span', { class: 'event-summary', text: e.summary })]),
          h('div', { class: 'muted small' }, [link(e.repo + '#' + e.number, e.url, 'mono'), ' · ' + rel(e.recordedAt)]),
        ]),
        h('div', { class: 'event-side' }, [badge(e.severity, e.severity), !e.acknowledged && e.id ? button('', () => send({ type: 'ack', ids: [e.id] }), 'small ghost icon-only', 'check') : null]),
      ])));
  }

  function renderAlertSize() {
    const size = (state.alerts && state.alerts.size) || 'normal';
    const option = (id, title, desc, iconName) => h('button', { class: 'size-option' + (size === id ? ' active' : ''), role: 'radio', 'aria-checked': size === id ? 'true' : 'false', onclick: () => { if (size !== id) { state.alerts.size = id; render(true); send({ type: 'setAlertSize', size: id }); } } }, [
      h('span', { class: 'size-icon' }, [icon(iconName)]),
      h('span', { class: 'size-text' }, [h('span', { class: 'size-title', text: title }), h('span', { class: 'muted small', text: desc })]),
      h('span', { class: 'size-radio' }),
    ]);
    return panel('Alert size', [
      h('div', { class: 'size-options', role: 'radiogroup', 'aria-label': 'Alert size' }, [
        option('normal', 'Normal', 'Notification, banner and status bar.', 'bell'),
        option('big', 'Big', 'Full black overlay over the editor saying what happened on which PR (merged, commented, reviewed…).', 'zap'),
      ]),
    ], [button('Preview big alert', () => send({ type: 'previewBigAlert' }), 'small ghost', 'zap')]);
  }

  function formatMinutes(m) {
    if (m % 1440 === 0) return (m / 1440) + ' day' + (m === 1440 ? '' : 's');
    if (m % 60 === 0) return (m / 60) + ' hour' + (m === 60 ? '' : 's');
    return m + ' min';
  }

  function renderReminderSchedule() {
    const r = state.reminders || { intervalMinutes: 30, maxRemindersPerReviewer: 5 };
    const presets = [5, 10, 15, 30, 45, 60, 120, 180, 240, 480, 1440];
    const intervals = [...new Set([...presets, r.intervalMinutes])].sort((a, b) => a - b);
    const maxes = [...new Set([0, 1, 2, 3, 5, 10, 20, r.maxRemindersPerReviewer])].sort((a, b) => a - b);
    const update = (patch) => { state.reminders = { ...r, ...patch }; render(true); send({ type: 'setReminders', ...patch }); };
    const total = r.maxRemindersPerReviewer === 0 ? 'Reminders are off.' : 'Up to ' + r.maxRemindersPerReviewer + ' reminder' + (r.maxRemindersPerReviewer === 1 ? '' : 's') + ', one every ' + formatMinutes(r.intervalMinutes) + ', until the reviewer responds.';
    return panel('Reminder schedule', [
      h('div', { class: 'actions' }, [
        h('label', { class: 'small', text: 'Remind every' }),
        select(String(r.intervalMinutes), intervals.map((m) => [String(m), formatMinutes(m)]), (v) => update({ intervalMinutes: Number(v) })),
        h('label', { class: 'small', text: 'Max per reviewer' }),
        select(String(r.maxRemindersPerReviewer), maxes.map((n) => [String(n), n === 0 ? 'Off' : String(n)]), (v) => update({ maxRemindersPerReviewer: Number(v) })),
      ]),
    ], [button('Custom…', () => send({ type: 'customReminderInterval' }), 'small ghost', 'clock')], total);
  }

  function renderActivity(c) {
    const events = state.events || [];
    const shown = events.filter((e) => activityFilter === 'unread' ? !e.acknowledged : activityFilter === 'high' ? e.severity === 'high' : true).slice(0, 100);
    const setF = (f) => { activityFilter = f; persist(); render(true); };
    return [
      renderHeader('Activity', c.alerts.length ? c.alerts.length + ' unacknowledged' : 'You\'re all caught up', [
        c.alerts.length ? button('Acknowledge all', () => send({ type: 'ack', ids: 'all' }), 'primary', 'check') : null,
        button('Snooze', () => send({ type: 'snooze' }), '', 'clock'),
      ]),
      renderAlertSize(),
      h('div', { class: 'toolbar' }, [h('div', { class: 'chips' }, [['all', 'All'], ['unread', 'Unread'], ['high', 'High priority']].map(([v, l]) => h('button', { class: 'chip' + (activityFilter === v ? ' active' : ''), onclick: () => setF(v), text: l })))]),
      panel(null, [shown.length ? renderEventList(shown) : empty('bell', 'Nothing here', activityFilter === 'all' ? 'No activity since monitoring started.' : 'No events match this filter.')]),
      h('p', { class: 'muted small', text: 'Acknowledging only hides an alert. It does not change anything on GitHub.' }),
    ];
  }

  function renderChannels(c) {
    const s = state.status;
    const ch = state.channels || { chat: true, whatsapp: false };
    const rows = [
      {
        id: 'chat', name: 'Google Chat', desc: 'Direct messages to reviewers\' Google Workspace accounts.', on: ch.chat,
        ready: !!(s && s.chatConfigured), readyText: 'Signed in', notReadyText: 'Not signed in',
        setup: button('Sign in with Google', () => send({ type: 'signInGoogle' }), 'small primary'),
        test: button('Send test', () => send({ type: 'testChat' }), 'small', 'send'),
      },
      {
        id: 'whatsapp', name: 'WhatsApp', desc: 'Messages sent from your linked WhatsApp account.', on: ch.whatsapp,
        ready: !!(s && s.whatsappLinked && !s.whatsappError), readyText: 'Linked', notReadyText: s && s.whatsappError ? s.whatsappError : 'Not linked',
        setup: button(s && s.whatsappLinked ? 'Re-link' : 'Link (scan QR)', () => send({ type: 'linkWhatsApp' }), s && s.whatsappLinked ? 'small ghost' : 'small primary'),
        test: button('Send test', () => send({ type: 'testWhatsApp' }), 'small', 'send'),
      },
    ];
    const list = h('div', { class: 'channel-grid' }, rows.map((r) =>
      h('div', { class: 'channel ' + (r.on ? (r.ready ? 'ok' : 'warn') : 'off') }, [
        h('div', { class: 'channel-head' }, [
          h('div', {}, [h('div', { class: 'channel-name', text: r.name }), h('div', { class: 'muted small', text: r.desc })]),
          h('label', { class: 'switch', title: (r.on ? 'Turn off ' : 'Turn on ') + r.name + ' messages' }, [
            h('input', { type: 'checkbox', checked: r.on, 'aria-label': r.name + ' enabled', onchange: (e) => send({ type: 'setChannel', channel: r.id, enabled: e.target.checked }) }),
            h('span', { class: 'slider' }),
          ]),
        ]),
        h('div', { class: 'channel-status' }, [h('span', { class: 'dot ' + (r.ready ? 'ok' : r.on ? 'warn' : 'off') }), h('span', { class: 'small', text: r.ready ? r.readyText : r.notReadyText })]),
        h('div', { class: 'actions' }, [r.ready ? r.test : r.setup, r.ready && r.id === 'whatsapp' ? r.setup : null]),
      ])));
    const failed = state.failedMessages || [];
    return [
      renderHeader('Channels', 'Reviewers are messaged on every channel that is on and has their contact.', []),
      list,
      renderReminderSchedule(),
      failed.length ? panel('Failed messages', [
        h('ul', { class: 'failed-list' }, failed.slice(0, 20).map((f) => h('li', {}, [
          badge(f.channel === 'whatsapp' ? 'WhatsApp' : 'Chat'),
          h('div', { class: 'grow' }, [h('div', { text: f.kind + ' → ' + f.recipient + ' · ' + f.prKey }), h('div', { class: 'error small', text: f.lastError || 'unknown error' })]),
          h('div', { class: 'actions' }, [button('Retry', () => send({ type: 'retryMessages', ids: [f.id] }), 'small ghost'), button('Clear', () => send({ type: 'clearMessages', ids: [f.id] }), 'small ghost')]),
        ]))),
      ], [button('Retry all', () => send({ type: 'retryMessages' }), 'small primary', 'refresh'), button('Clear all', () => send({ type: 'clearMessages' }), 'small ghost')], failed.length + ' message' + (failed.length === 1 ? '' : 's') + ' could not be delivered') : null,
    ];
  }

  const LOGIN_RE = /^(@[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const normalizePhone = (v) => v.replace(/[\s().-]/g, '').replace(/^\+/, '').replace(/^00/, '');

  /** Saved reviewers as rows, merged from the email and WhatsApp settings. */
  function savedRows() {
    const rows = new Map();
    const row = (login) => {
      const key = login.toLowerCase();
      if (!rows.has(key)) rows.set(key, { login, email: '', phone: '' });
      return rows.get(key);
    };
    for (const [login, email] of Object.entries(state.mapping || {})) row(login).email = email;
    for (const [login, phone] of Object.entries(state.numbers || {})) row(login).phone = phone;
    return [...rows.values()].sort((a, b) => a.login.localeCompare(b.login));
  }

  /** Enters edit mode (a private copy of the saved rows). Optionally adds a row and focuses a field. */
  function startEdit(addLogin, focusIndex) {
    if (!mappingDraft) {
      mappingDraft = savedRows().map((r) => ({ ...r }));
      mappingErrors = {};
      saveError = null;
    }
    if (addLogin !== undefined) {
      mappingDraft.push({ login: addLogin, email: '', phone: '' });
      focusIndex = mappingDraft.length - 1;
    }
    if (view !== 'mapping') goTo('mapping'); else render(true);
    if (focusIndex !== undefined) {
      const field = addLogin ? 'email' : 'login';
      const el = document.querySelector('[data-row="' + focusIndex + '"][data-field="' + field + '"]');
      if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
    }
  }

  function cancelEdit() {
    mappingDraft = null;
    mappingErrors = {};
    saveError = null;
    saving = false;
    render(true);
  }

  /** Validates every row; returns the payload, or null after recording per-field errors. */
  function validateDraft() {
    const errors = {};
    const seen = new Map();
    const mapping = {};
    const numbers = {};
    mappingDraft.forEach((r, i) => {
      const login = r.login.trim().replace(/^@(?=[^/]*$)/, '');
      const email = r.email.trim();
      const phone = (r.phone || '').trim();
      if (!login && !email && !phone) return; // blank row: ignored
      const e = {};
      if (!login) e.login = 'Required';
      else if (!LOGIN_RE.test(login)) e.login = 'Not a valid GitHub login or @org/team';
      else if (seen.has(login.toLowerCase())) e.login = 'Duplicate of row ' + (seen.get(login.toLowerCase()) + 1);
      if (email && !EMAIL_RE.test(email)) e.email = 'Not a valid email';
      if (phone && !/^[1-9]\d{7,14}$/.test(normalizePhone(phone))) e.phone = 'Use country code, e.g. +919876543210';
      if (login && !email && !phone) e.email = 'Add an email or a WhatsApp number';
      if (login) seen.set(login.toLowerCase(), i);
      if (Object.keys(e).length) { errors[i] = e; return; }
      if (email) mapping[login] = email;
      if (phone) numbers[login] = phone;
    });
    mappingErrors = errors;
    return Object.keys(errors).length ? null : { mapping, numbers };
  }

  function saveDraft() {
    const payload = validateDraft();
    if (!payload) {
      saveError = 'Fix the highlighted fields, then save again.';
      render(true);
      return;
    }
    saving = true;
    saveError = null;
    render(true);
    send({ type: 'saveMapping', ...payload });
  }

  function contactCell(value, kind) {
    return value ? h('span', { class: 'contact ' + kind, text: value }) : h('span', { class: 'muted small', text: '—' });
  }

  function renderMappingView(c) {
    const rows = savedRows();
    const unmapped = state.unmapped || [];
    const table = h('table', { class: 'map-table' }, [
      h('thead', {}, [h('tr', {}, [h('th', { text: 'GitHub login' }), h('th', { text: 'Workspace email' }), h('th', { text: 'WhatsApp number' }), h('th')])]),
      h('tbody', {}, rows.map((r, i) => h('tr', {}, [
        h('td', {}, [h('span', { class: 'avatar', text: r.login.replace(/^@/, '').charAt(0).toUpperCase() }), h('strong', { text: (r.login.startsWith('@') ? '' : '@') + r.login })]),
        h('td', {}, [contactCell(r.email, 'email')]),
        h('td', {}, [contactCell(r.phone, 'phone')]),
        h('td', { class: 'row-actions' }, [button('Edit', () => startEdit(undefined, i), 'small ghost', 'pencil')]),
      ]))),
    ]);
    return [
      renderHeader('Reviewers', rows.length + ' reviewer' + (rows.length === 1 ? '' : 's') + ' mapped', [
        rows.length ? button('Edit', () => startEdit(), 'primary', 'pencil') : null,
        button('Add reviewer', () => startEdit(''), '', 'plus'),
      ]),
      justSaved ? h('div', { class: 'notice ok' }, [icon('check'), h('span', { text: 'Reviewer mapping saved.' })]) : null,
      unmapped.length ? panel('Missing contacts', [h('div', { class: 'suggest' }, unmapped.map((u) => h('div', { class: 'suggest-row' }, [
        h('div', {}, [h('strong', { text: (u.kind === 'team' ? '' : '@') + u.login }), h('div', { class: 'muted small', text: 'Requested on ' + u.prKeys.join(', ') })]),
        button('Add contact', () => startEdit(u.login), 'small primary', 'plus'),
      ])))], null, 'These reviewers receive no messages until you add their contact.') : null,
      state.whatsappEnabled ? null : h('div', { class: 'notice info' }, [icon('send'), h('span', { text: 'WhatsApp is off: numbers are saved but not used until you link WhatsApp in Channels.' })]),
      panel(null, [rows.length ? table : empty('people', 'No reviewers mapped', 'Only listed reviewers get messages; contacts are never guessed.', button('Add reviewer', () => startEdit(''), 'small primary', 'plus'))]),
    ];
  }

  function field(row, i, key, label, type, placeholder) {
    const err = mappingErrors[i] && mappingErrors[i][key];
    return h('label', { class: 'field' + (err ? ' invalid' : '') }, [
      h('span', { class: 'field-label', text: label }),
      h('input', {
        value: row[key] || '', type, placeholder, disabled: saving, 'data-row': String(i), 'data-field': key,
        oninput: (e) => { row[key] = e.target.value; if (err) { delete mappingErrors[i][key]; e.target.closest('.field').classList.remove('invalid'); } },
        onkeydown: (e) => { if (e.key === 'Enter') saveDraft(); else if (e.key === 'Escape') cancelEdit(); },
      }),
      err ? h('span', { class: 'field-error', text: err }) : null,
    ]);
  }

  function renderMappingEdit(c) {
    const rows = mappingDraft.map((row, i) =>
      h('div', { class: 'map-row' }, [
        field(row, i, 'login', 'GitHub login', 'text', 'github-login or @org/team'),
        field(row, i, 'email', 'Workspace email', 'email', 'name@company.com'),
        field(row, i, 'phone', 'WhatsApp number', 'tel', '+919876543210'),
        button('', () => { mappingDraft.splice(i, 1); mappingErrors = {}; render(true); }, 'small ghost icon-only danger', 'trash'),
      ]));
    return [
      renderHeader('Edit reviewers', 'Changes are saved together when you press Save. Enter saves, Esc cancels.', [
        button('Add row', () => startEdit(''), '', 'plus'),
      ]),
      panel(null, [rows.length ? h('div', { class: 'map-list' }, rows) : empty('people', 'No reviewers', 'Saving now removes all reviewer contacts.', button('Add row', () => startEdit(''), 'small primary', 'plus'))]),
      h('div', { class: 'savebar editing' }, [
        h('span', { class: 'savebar-text small' + (saveError ? ' error' : ''), text: saving ? 'Saving…' : saveError || 'Editing ' + mappingDraft.length + ' reviewer' + (mappingDraft.length === 1 ? '' : 's') }),
        h('div', { class: 'actions' }, [
          button('Cancel', cancelEdit, 'ghost'),
          h('button', { class: 'btn primary', disabled: saving, onclick: saveDraft }, [icon('check'), h('span', { text: saving ? 'Saving…' : 'Save all' })]),
        ]),
      ]),
    ];
  }

  function renderMapping(c) {
    return mappingDraft ? renderMappingEdit(c) : renderMappingView(c);
  }


  // ---------- render ----------

  /** @param {boolean} [force] render even while the user is typing (user-initiated changes) */
  function render(force) {
    if (!state) return;
    const active = document.activeElement;
    if (!force && mappingDraft && view === 'mapping') return; // edit mode keeps its own copy; do not disturb typing
    const keep = active && active.getAttribute && active.getAttribute('data-keep');
    const caret = keep ? active.selectionStart : null;
    if (!VIEWS.some((v) => v.id === view)) view = 'overview';
    const c = counts();
    const body = { overview: renderOverview, prs: renderPrs, activity: renderActivity, channels: renderChannels, mapping: renderMapping }[view](c);
    const main = document.querySelector('.main');
    const scroll = main ? main.scrollTop : 0;
    app.replaceChildren(h('div', { class: 'layout' }, [renderSidebar(c), h('main', { class: 'main', id: 'sec-' + view }, [h('div', { class: 'view' }, body.filter(Boolean))])]));
    const newMain = document.querySelector('.main');
    if (newMain) newMain.scrollTop = scroll;
    if (keep) {
      const el = document.querySelector('[data-keep="' + keep + '"]');
      if (el) { el.focus(); if (caret !== null) el.setSelectionRange(caret, caret); }
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'state') {
      state = msg;
      render();
    } else if (msg && msg.type === 'saveResult') {
      saving = false;
      if (msg.ok) {
        mappingDraft = null;
        mappingErrors = {};
        saveError = null;
        justSaved = true;
        setTimeout(() => { justSaved = false; render(); }, 4000);
      } else {
        saveError = 'Not saved: ' + msg.error;
      }
      render(true);
    } else if (msg && msg.type === 'scrollTo') {
      const id = msg.section === 'status' || msg.section === 'warnings' ? 'overview' : msg.section;
      if (VIEWS.some((v) => v.id === id)) goTo(id);
    }
  });
  setInterval(() => render(), 30000); // keep relative times fresh
  send({ type: 'ready' });
})();
