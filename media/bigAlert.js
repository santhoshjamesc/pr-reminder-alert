// @ts-check
// Big PR alert overlay. All untrusted strings are rendered with textContent only.
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let events = [];
  let index = 0;

  const HEADLINES = {
    pr_merged: ['PR MERGED', 'merged'],
    pr_closed: ['PR CLOSED', 'closed'],
    pr_reopened: ['PR REOPENED', 'info'],
    pr_opened: ['PR OPENED', 'info'],
    pr_inaccessible: ['PR INACCESSIBLE', 'bad'],
    changes_requested: ['CHANGES REQUESTED', 'bad'],
    review_submitted: ['NEW REVIEW', 'ok'],
    reviewer_comment: ['NEW COMMENT', 'warn'],
    issue_comment: ['NEW COMMENT', 'warn'],
    review_comment: ['NEW COMMENT', 'warn'],
    ci_failed: ['CI FAILED', 'bad'],
    ci_passed: ['CI PASSED', 'ok'],
    commit_pushed: ['NEW COMMITS', 'info'],
    review_requested: ['REVIEW REQUESTED', 'info'],
    branch_deleted: ['BRANCH DELETED', 'warn'],
  };

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

  function ago(iso) {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!isFinite(mins) || mins < 1) return 'just now';
    return mins < 60 ? mins + ' min ago' : mins < 2880 ? Math.round(mins / 60) + ' h ago' : Math.round(mins / 1440) + ' days ago';
  }

  function render() {
    if (!events.length) {
      app.replaceChildren();
      return;
    }
    index = Math.min(index, events.length - 1);
    const e = events[index];
    const [headline, kind] = HEADLINES[e.type] || [e.type.replace(/_/g, ' ').toUpperCase(), e.severity === 'high' ? 'bad' : 'info'];
    const primary = h('button', { class: 'btn primary', onclick: () => send({ type: 'open', id: e.id }), text: 'Open PR' });
    app.replaceChildren(
      h('div', { class: 'overlay ' + kind, role: 'alertdialog', 'aria-labelledby': 'headline', 'aria-describedby': 'summary' }, [
        h('div', { class: 'pulse-ring' }),
        h('div', { class: 'content' }, [
          h('div', { class: 'eyebrow' }, [h('span', { class: 'live-dot' }), 'PR ALERT', events.length > 1 ? h('span', { class: 'counter', text: (index + 1) + ' of ' + events.length }) : null]),
          h('h1', { id: 'headline', class: 'headline', text: headline }),
          h('div', { class: 'pr-ref', text: e.repo + ' #' + e.number }),
          e.prTitle ? h('div', { class: 'pr-title', text: e.prTitle }) : null,
          h('div', { id: 'summary', class: 'summary' }, [h('span', { text: e.summary })]),
          h('div', { class: 'meta', text: (e.actor ? 'by @' + e.actor + ' · ' : '') + ago(e.occurredAt) }),
          h('div', { class: 'actions' }, [
            primary,
            h('button', { class: 'btn', onclick: () => send({ type: 'ack', id: e.id }), text: 'Acknowledge' }),
            events.length > 1 ? h('button', { class: 'btn', onclick: () => send({ type: 'ackAll' }), text: 'Acknowledge all ' + events.length }) : null,
            h('button', { class: 'btn ghost', onclick: () => send({ type: 'snooze' }), text: 'Snooze…' }),
          ]),
          events.length > 1 ? h('div', { class: 'pager' }, [
            h('button', { class: 'btn ghost small', disabled: index === 0, onclick: () => { index--; render(); }, text: '‹ Previous' }),
            h('button', { class: 'btn ghost small', disabled: index === events.length - 1, onclick: () => { index++; render(); }, text: 'Next ›' }),
          ]) : null,
          h('div', { class: 'hint' }, ['Press ', h('kbd', { text: 'Enter' }), ' to open · ', h('kbd', { text: 'Esc' }), ' to dismiss (alerts stay unread)']),
        ]),
      ]),
    );
    primary.focus();
  }

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') send({ type: 'dismiss' });
    else if (ev.key === 'ArrowRight' && index < events.length - 1) { index++; render(); }
    else if (ev.key === 'ArrowLeft' && index > 0) { index--; render(); }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'events') {
      const firstId = events[0] && events[0].id;
      events = msg.events;
      if (events[0] && events[0].id !== firstId) index = 0; // newest alert jumps to the front
      render();
    }
  });
  send({ type: 'ready' });
})();
