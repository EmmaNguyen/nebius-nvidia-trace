// Patrol mode UI: streams one shift from /api/patrol (server-sent events) and renders lanes, radar, units and tickets.
// All text from the server is set with textContent; nothing is rendered as HTML.
const $ = id => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const STATUS_LABEL = { moving: 'MOVING', clocked: 'CLOCKED', investigating: 'PULLED OVER', ticketed: 'TICKETED', paused: 'PAUSED BY RUNTIME', stopped: 'STOPPED · EMERGENCY', clear: 'CLEAR' };
const ACTION_LABEL = { dispatch: 'dispatch', read_lines: 'read', check_policy: 'policy', write_ticket: 'ticket', error: 'error' };

let source = null, configured = false, lanes = {}, units = {}, names = {}, counts = {};

fetch('/api/status').then(r => r.json()).then(s => {
  configured = s.configured;
  $('mode-text').textContent = s.configured ? `LIVE · ${s.model.split('/').pop().toUpperCase()}` : 'DEMO · NO KEY';
  $('mode').classList.toggle('live', s.configured);
  if (!s.configured) { $('officer').value = 'demo'; $('officer').querySelector('[value="live"]').disabled = true; }
}).catch(() => { $('mode-text').textContent = 'OFFLINE'; });

function reset(shift) {
  lanes = {}; units = {}; names = {}; counts = { tickets: 0, queued: new Set() };
  $('lanes').replaceChildren(); $('feed').replaceChildren(); $('units').replaceChildren(); $('tickets').replaceChildren(el('p', 'empty', 'No tickets yet.'));
  for (const id of ['s-events', 's-hits', 's-tickets', 's-stops', 's-prevented']) $(id).textContent = '0';
  $('emergency').hidden = true;
  $('s-radar').textContent = '–'; $('s-cites').textContent = '–'; $('ticket-count').textContent = '0'; $('queue').textContent = 'QUEUE 0';
  $('fleet-count').textContent = `${shift.agents.length} AGENTS`;
  for (const a of shift.agents) {
    names[a.id] = a.name;
    const lane = el('div', 'lane'); lane.dataset.status = 'moving';
    const head = el('div', 'lane-head');
    head.append(el('b', '', a.name), el('span', 'role', a.role));
    const pill = el('span', 'pill', STATUS_LABEL.moving); head.append(pill);
    const road = el('div', 'road');
    const slots = Array.from({ length: a.events }, () => road.appendChild(el('span', 'slot')));
    const last = el('div', 'last', 'Waiting to start…');
    lane.append(head, el('div', 'limit', `LIMIT · ${a.limitLabel}`), road, last);
    $('lanes').append(lane);
    lanes[a.id] = { lane, pill, road, slots, last, next: 0 };
  }
  for (let u = 1; u <= shift.units; u++) {
    const card = el('div', 'unit'); const head = el('div', 'unit-h');
    const who = el('b', '', 'AVAILABLE'); head.append(el('span', '', `UNIT ${u}`), who);
    const radio = el('ol', 'radio'); card.append(head, radio);
    $('units').append(card);
    units[u] = { card, who, radio };
  }
}

// Each lane has one slot per scripted event; runtime control lines add a slot of their own.
function fillSlot(agent, cls, title) {
  const l = lanes[agent];
  let slot = l.slots[l.next];
  if (!slot || cls === 'control') { slot = el('span', 'slot'); l.road.insertBefore(slot, l.slots[l.next] || null); }
  else l.next++;
  slot.className = `slot ${cls}`;
  slot.title = title;
}

function feed(item, cls, t, text, right) {
  const li = el('li', cls);
  const txt = el('span', 'txt');
  txt.append(el('b', '', `${names[item.agent]} `), document.createTextNode(text));
  li.append(el('span', 't', `${t.toFixed(1)}s`), txt, el('span', 'ms', right));
  $('feed').prepend(li);
  while ($('feed').children.length > 80) $('feed').lastChild.remove();
}

function radioLine(unit, text, cls, meta) {
  const li = el('li', cls, text);
  if (meta) li.append(el('small', '', meta));
  units[unit].radio.append(li);
  while (units[unit].radio.children.length > 6) units[unit].radio.firstChild.remove();
}

function renderTicket(t) {
  if (!counts.tickets) $('tickets').replaceChildren();
  counts.tickets++;
  const card = el('article', t.findings.length ? 'ticket' : 'ticket clean');
  const head = el('div', 'tk-h');
  head.append(el('span', '', `TICKET #${t.number}`), el('b', '', t.name), el('span', 'r', `UNIT ${t.unit} · ${(t.ms / 1000).toFixed(1)}s`));
  card.append(head, el('p', 'tk-sum', t.summary));
  for (const f of t.findings) {
    const box = el('div', 'finding');
    const fh = el('div', 'f-h');
    fh.append(el('span', `sev ${f.severity}`, f.severity), document.createTextNode(f.title));
    const ev = el('ul', 'ev');
    for (const e of f.evidence) {
      const li = el('li');
      li.append(el('code', e.source, `${e.source}:${e.line}`), el('span', '', e.quote));
      li.title = e.quote;
      ev.append(li);
    }
    box.append(fh, ev);
    if (f.recommendation) box.append(el('div', 'fix', `Fix: ${f.recommendation}`));
    card.append(box);
  }
  const foot = el('div', 'tk-f');
  const { verified, total } = t.citations;
  foot.append(el('span', verified === total ? 'tag ok' : 'tag warn', `CITATIONS VERIFIED ${verified}/${total}`));
  if (t.stop) foot.append(el('span', t.stop.decision === 'allow' ? 'tag stop' : 'tag', t.stop.decision === 'allow' ? 'STOP REQUESTED · RUNTIME PAUSED AGENT' : `STOP REQUESTED · ${t.stop.decision.toUpperCase()}`));
  foot.append(el('span', 'tag', t.mode === 'nebius' ? `NEMOTRON · ${t.steps} STEPS` : 'DEMO OFFICER'));
  if (t.fallback) foot.append(el('span', 'tag warn', 'FELL BACK TO RADAR EVIDENCE'));
  if (t.dropped && t.dropped.length) {
    const tag = el('span', 'tag warn', `${t.dropped.length} UNCITED CLAIM${t.dropped.length > 1 ? 'S' : ''} DROPPED`);
    tag.title = t.dropped.join('\n');
    foot.append(tag);
  }
  card.append(foot);
  $('tickets').prepend(card);
  $('ticket-count').textContent = String(counts.tickets);
}

const handlers = {
  shift: d => { reset(d); $('radar-state').textContent = 'ON'; },
  event: d => {
    const worst = d.hits.some(h => h.severity === 'high') ? 'high' : d.hits.length ? 'medium' : '';
    const label = `${d.source}:${d.line}  ${d.text}`;
    fillSlot(d.agent, d.control ? 'control' : worst ? `hit-${worst}` : 'ok', label);
    lanes[d.agent].last.textContent = label;
    feed(d, d.control ? 'control' : worst ? `hit-${worst}` : '', d.t, `${d.source}:${d.line} ${d.text}`, d.control ? 'RUNTIME' : d.hits.length ? d.hits.map(h => h.title).join(' · ').toUpperCase() : `${d.ms.toFixed(3)} ms`);
    if (!d.control) {
      $('s-events').textContent = String(Number($('s-events').textContent) + 1);
      $('s-hits').textContent = String(Number($('s-hits').textContent) + d.hits.length);
      counts.radar = [...(counts.radar || []), d.ms];
      const sorted = [...counts.radar].sort((a, b) => a - b);
      $('s-radar').textContent = `${sorted[Math.floor(sorted.length / 2)].toFixed(2)} ms`;
    }
  },
  prevented: d => {
    fillSlot(d.agent, 'prevented', `Not executed: ${d.text}`);
    feed(d, 'prevented', d.t, d.text, 'PREVENTED');
    $('s-prevented').textContent = String(Number($('s-prevented').textContent) + 1);
  },
  agent: d => {
    const l = lanes[d.agent];
    l.lane.dataset.status = d.status;
    l.pill.textContent = STATUS_LABEL[d.status] || d.status.toUpperCase();
  },
  // The tripwire fired: the runtime halted every agent at once.
  emergency: d => {
    $('emergency').replaceChildren(el('b', '', 'EMERGENCY STOP'), document.createTextNode(`${names[d.agent]}: ${d.title.toLowerCase()} at ${d.refs.map(r => `${r.source}:${r.line}`).join(', ')}. The runtime halted all ${d.halted} running agents ${d.ms.toFixed(1)} ms after that line arrived, at ${d.t.toFixed(1)} s. Officers keep investigating for the report.`));
    $('emergency').hidden = false;
    $('s-stops').textContent = String(d.halted);
  },
  dispatch: d => {
    if (d.queued) counts.queued.add(d.agent); else counts.queued.delete(d.agent);
    $('queue').textContent = `QUEUE ${counts.queued.size}`;
    if (d.queued) return;
    const u = units[d.unit];
    u.card.classList.add('busy');
    u.who.textContent = `→ ${names[d.agent]}${d.backup ? ' (backup)' : d.followUp ? ' (follow-up)' : ''}`;
    u.radio.replaceChildren();
    radioLine(d.unit, `Radar: ${d.readings.map(r => r.title.toLowerCase()).join('; ')}`, '', d.readings.flatMap(r => r.refs.map(ref => `${ref.source}:${ref.line}`)).join(' '));
  },
  officer: d => {
    const meta = d.args && d.args.source ? `${d.args.source} ${d.args.from}-${d.args.to}` : ACTION_LABEL[d.action] || d.action;
    radioLine(d.unit, d.note || d.action, d.action === 'error' ? 'err' : '', meta);
  },
  ticket: d => {
    renderTicket(d);
    const u = units[d.unit];
    u.card.classList.remove('busy');
    u.who.textContent = 'AVAILABLE';
    radioLine(d.unit, `Ticket #${d.number} issued for ${d.name}.`, '', d.stop && d.stop.decision === 'allow' ? 'runtime paused agent' : '');
    $('s-tickets').textContent = String(counts.tickets);
    counts.verified = (counts.verified || 0) + d.citations.verified; counts.total = (counts.total || 0) + d.citations.total;
    $('s-cites').textContent = `${counts.verified}/${counts.total}`;
    if (d.stop && d.stop.decision === 'allow') $('s-stops').textContent = String(Number($('s-stops').textContent) + 1);
  },
  failure: d => finish(`Shift stopped: ${d.error}`),
  done: d => finish(`Shift complete in ${d.seconds}s · ${d.events} events checked · ${d.tickets} tickets · ${d.emergency ? `emergency stop at ${d.emergency.t.toFixed(1)}s, ${d.emergency.halted} agents halted` : `${d.stops} agents paused`}`)
};

function finish(message) {
  if (source) { source.close(); source = null; }
  $('radar-state').textContent = 'OFF';
  $('start').disabled = false;
  $('start').firstChild.textContent = 'Run another shift ';
  for (const u of Object.values(units)) { u.card.classList.remove('busy'); if (u.who.textContent.startsWith('→')) u.who.textContent = 'OFF DUTY'; }
  $('feed').prepend(el('li', 'summary', message));
}

$('start').addEventListener('click', () => {
  if (source) return;
  $('start').disabled = true;
  $('radar-state').textContent = 'CONNECTING';
  const mode = configured && $('officer').value === 'live' ? 'live' : 'demo';
  source = new EventSource(`/api/patrol?speed=${encodeURIComponent($('speed').value)}&mode=${mode}&contain=${$('contain').value}`);
  for (const [type, handle] of Object.entries(handlers)) source.addEventListener(type, e => handle(JSON.parse(e.data)));
  // EventSource reconnects on its own when a stream ends; a shift is one stream, so close instead.
  source.onerror = () => { if (source) finish('Connection closed before the shift finished. A live shift may already be running; try again or use the demo officer.'); };
});
