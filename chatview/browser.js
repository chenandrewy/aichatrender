// Run: loaded by the live chatview browser page.
// Inputs: same-origin session listing and Server-Sent Events stream.
// Output: session picker state and parsed transcript snapshots for the renderer.
'use strict';

window.chatviewSubscribe = function (receive) {
  const picker = document.getElementById('chatview-session');
  const refresh = document.getElementById('chatview-refresh');
  const connection = document.getElementById('chatview-connection');
  let stream;

  function selectSession() {
    if (stream) stream.close();
    const key = picker.value;
    receive({ type: 'replaceHistory', status: key ? 'Loading transcript…' : 'No sessions found.' });
    connection.textContent = key ? 'Connecting…' : '';
    if (!key) return;
    const next = new EventSource('/events?' + new URLSearchParams({ session: key }));
    stream = next;
    next.onmessage = (event) => {
      if (stream !== next) return;
      receive(JSON.parse(event.data));
      connection.textContent = 'Live';
    };
    next.addEventListener('transcript-error', (event) => {
      if (stream === next) connection.textContent = JSON.parse(event.data);
    });
    next.onerror = () => {
      if (stream === next) connection.textContent = 'Reconnecting…';
    };
  }

  async function loadSessions() {
    refresh.disabled = true;
    try {
      const response = await fetch('/sessions', { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load sessions.');
      const sessions = await response.json();
      const previous = picker.value;
      const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });
      picker.replaceChildren();
      for (const session of sessions) {
        const provider = session.provider === 'claude' ? 'Claude' : 'Codex';
        const date = dates.format(new Date(session.modified));
        const option = new Option(provider + ' · ' + session.title + ' · ' + date, session.key);
        picker.add(option);
      }
      if (sessions.some((session) => session.key === previous)) picker.value = previous;
      picker.disabled = !sessions.length;
      if (!stream || picker.value !== previous) selectSession();
    } catch {
      connection.textContent = 'Could not load sessions. Try Refresh.';
    } finally {
      refresh.disabled = false;
    }
  }

  picker.addEventListener('change', selectSession);
  refresh.addEventListener('click', loadSessions);
  loadSessions();
};
