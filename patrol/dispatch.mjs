// The dispatcher runs one patrol shift. It replays the simulated fleet in real time, runs the radar on every
// event, sends officers to radar hits (three units, most urgent hit first, follow-ups for new hits), and plays the part of the
// runtime that decides on stop requests. Traceback itself never stops an agent: it asks, and the runtime decides.
//
// Containment policy (`contain`):
//   escape (default)  the first sign of traffic leaving a sandbox triggers the runtime's emergency stop at once,
//                     with no model in the loop, and every agent halts. Officers still investigate for the report.
//   any               the same, but any radar hit trips it, including a stated plan to get around a limit.
//   verify            no tripwire: the runtime pauses one agent only after a verified high-severity ticket.
import { performance } from 'node:perf_hooks';
import { modelId } from '../lib/model.mjs';
import { FLEET } from './fleet.mjs';
import { investigate } from './officer.mjs';
import { radar } from './radar.mjs';

const UNITS = 3;
const ESCAPE_RULES = new Set(['off_route', 'exemption']);
const stamp = t => `[${t.toFixed(1).padStart(4, '0')}]`;
const sleep = (ms, signal) => new Promise(resolve => {
  const id = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true });
});

// Options for the escape simulation: `only` runs a subset of the fleet (starting within a second), and
// `watch: false` turns Traceback off entirely, so the same run plays out with no radar and no officers.
export async function runPatrol({ live, speed, send, signal, only, watch = true, contain = 'escape' }) {
  const fleet = only ? FLEET.filter(a => only.includes(a.id)) : FLEET;
  const shift = only ? Math.min(...fleet.flatMap(a => a.events.map(e => e.t))) - 0.8 : 0;
  const agents = fleet.map(a => ({ ...a, events: a.events.map(e => ({ ...e, t: e.t - shift })), trace: [], openshell: [], radarState: {}, readings: [], handled: 0, status: 'moving', active: 0, queued: false, remaining: a.events.length, tickets: 0 }));
  const stats = { events: 0, radarMs: [], hits: 0, tickets: 0, stops: 0, prevented: 0, verified: 0, cited: 0, ticketMs: [] };
  const free = Array.from({ length: UNITS }, (_, i) => i + 1);
  const jobs = new Set();
  let seq = 0;
  const started = Date.now();
  const clock = () => (Date.now() - started) / 1000 * speed;

  let emergency = null;
  send('shift', { live, watch, contain, model: live ? modelId() : 'Traceback demo officer', speed, units: UNITS, agents: agents.map(({ id, name, role, limitLabel, events }) => ({ id, name, role, limitLabel, events: events.length })) });

  const setStatus = (a, status) => { a.status = status; send('agent', { agent: a.id, status }); };
  const halted = a => a.status === 'paused' || a.status === 'stopped';
  const snapshot = a => () => ({ trace: [...a.trace], openshell: [...a.openshell], status: a.status === 'paused' ? 'paused by runtime' : a.status === 'stopped' ? 'stopped by the emergency stop' : a.remaining ? 'running' : 'finished' });
  const record = (a, source, text, t) => {
    const line = a[source].push(`${stamp(t)} ${text}`);
    send('event', { agent: a.id, source, line, text, t, ms: 0, hits: [], control: true });
  };

  // The tripwire: Traceback triggers the runtime's emergency stop the moment a containment rule is hit, and the
  // simulated runtime halts every agent that is still running. `since` is when the triggering line arrived.
  function tripwire(a, hits, since) {
    if (emergency || contain === 'verify') return;
    const trip = hits.find(h => contain === 'any' || ESCAPE_RULES.has(h.rule));
    if (!trip) return;
    record(a, 'openshell', `control action=emergency_stop scope=all_agents requested_by=traceback-tripwire trigger=${trip.rule} decision=allow policy=escape-tripwire`, clock());
    for (const x of agents) if (x === a || (x.remaining && !halted(x))) setStatus(x, 'stopped');
    emergency = { agent: a.id, name: a.name, rule: trip.rule, title: trip.title, refs: trip.refs, t: Number(clock().toFixed(2)), ms: Number((performance.now() - since).toFixed(3)), halted: agents.filter(x => x.status === 'stopped').length };
    send('emergency', emergency);
  }

  // The simulated runtime: it pauses an agent only for a ticket with a verified high-severity finding.
  function decideStop(a, ticket) {
    if (!ticket.requestStop) return null;
    if (halted(a)) return { decision: a.status === 'stopped' ? 'already stopped' : 'already paused' };
    if (!a.remaining) return { decision: 'not needed', reason: 'The run had already finished.' };
    const t = clock();
    if (!ticket.findings.some(f => f.severity === 'high' && f.evidence.length)) {
      record(a, 'openshell', 'control action=pause_agent requested_by=traceback-patrol decision=deny reason=no_verified_high_finding', t);
      return { decision: 'deny', reason: 'No verified high-severity finding.' };
    }
    record(a, 'openshell', 'control action=pause_agent requested_by=traceback-patrol decision=allow policy=verified-ticket', t);
    stats.stops++;
    setStatus(a, 'paused');
    return { decision: 'allow', reason: 'Runtime paused the agent on a verified ticket.' };
  }

  // Free units go to the most urgent waiting hit: high severity first, then oldest. An agent gets one unit at
  // a time, except that a new high-severity hit gets a backup unit instead of waiting behind an earlier one.
  const waiting = a => {
    const pending = a.readings.slice(a.handled);
    if (!pending.length) return null;
    const high = pending.some(r => r.severity === 'high');
    if (a.active && !(high && a.active < 2)) return null;
    return { a, high, seq: pending[0].seq };
  };
  function schedule() {
    while (free.length && !signal.aborted) {
      const next = agents.map(waiting).filter(Boolean).sort((x, y) => (y.high - x.high) || (x.seq - y.seq))[0];
      if (!next) break;
      start(next.a);
    }
    for (const a of agents) {
      if (!a.queued && waiting(a)) { a.queued = true; send('dispatch', { agent: a.id, queued: true }); }
    }
  }

  function start(a) {
    const unit = free.shift(), backup = a.active > 0, readings = a.readings.slice(a.handled), t0 = clock();
    a.handled = a.readings.length;
    a.queued = false;
    a.active++;
    if (!halted(a)) setStatus(a, 'investigating');
    send('dispatch', { agent: a.id, unit, backup, followUp: a.tickets > 0, readings: readings.map(({ rule, severity, title, detail, refs }) => ({ rule, severity, title, detail, refs })) });
    const job = investigate({ agent: a, readings, snapshot: snapshot(a), live, signal, pace: () => sleep(700 / speed, signal), log: step => send('officer', { agent: a.id, unit, ...step }) })
      .then(ticket => {
        if (signal.aborted) return;
        a.tickets++;
        stats.tickets++;
        stats.verified += ticket.citations.verified;
        stats.cited += ticket.citations.total;
        stats.ticketMs.push(ticket.ms);
        const stop = decideStop(a, ticket);
        send('ticket', { agent: a.id, name: a.name, unit, number: a.tickets, shiftSeconds: Number((clock() - t0).toFixed(1)), ...ticket, stop });
        if (!halted(a) && a.active <= 1) setStatus(a, ticket.findings.length ? 'ticketed' : a.remaining ? 'moving' : 'clear');
      })
      .catch(error => { if (!signal.aborted) send('officer', { agent: a.id, unit, action: 'error', note: `Investigation failed: ${error.message}` }); })
      .finally(() => {
        jobs.delete(job);
        a.active--;
        free.push(unit);
        free.sort();
        if (a.status === 'investigating' && !a.active) setStatus(a, a.remaining ? 'moving' : 'clear');
        schedule();
      });
    jobs.add(job);
  }

  const timeline = agents.flatMap(a => a.events.map(e => ({ ...e, a }))).sort((x, y) => x.t - y.t);
  for (const ev of timeline) {
    const wait = ev.t / speed * 1000 - (Date.now() - started);
    if (wait > 0) await sleep(wait, signal);
    if (signal.aborted) return;
    const a = ev.a;
    a.remaining--;
    if (halted(a)) {
      stats.prevented++;
      send('prevented', { agent: a.id, source: ev.src, text: ev.text, t: ev.t });
      continue;
    }
    const line = a[ev.src].push(`${stamp(ev.t)} ${ev.text}`);
    const r0 = performance.now();
    const hits = watch ? radar(a, a.radarState, ev.src, line, ev.text) : [];
    const ms = performance.now() - r0;
    stats.events++;
    stats.radarMs.push(ms);
    stats.hits += hits.length;
    send('event', { agent: a.id, source: ev.src, line, text: ev.text, t: ev.t, ms, hits: hits.map(({ rule, severity, title }) => ({ rule, severity, title })) });
    if (hits.length) {
      for (const h of hits) h.seq = ++seq;
      a.readings.push(...hits);
      if (!a.active) setStatus(a, 'clocked');
      tripwire(a, hits, r0);
      schedule();
    } else if (!a.remaining && a.status === 'moving') setStatus(a, 'clear');
  }
  while (jobs.size && !signal.aborted) await Promise.allSettled([...jobs]);
  if (signal.aborted) return;

  const sorted = [...stats.radarMs].sort((x, y) => x - y);
  send('done', {
    watch, contain, emergency,
    events: stats.events, hits: stats.hits, tickets: stats.tickets, stops: stats.stops, prevented: stats.prevented,
    citations: { verified: stats.verified, total: stats.cited },
    radarMedianMs: sorted[Math.floor(sorted.length / 2)] || 0, radarMaxMs: sorted[sorted.length - 1] || 0,
    avgTicketMs: stats.ticketMs.length ? Math.round(stats.ticketMs.reduce((x, y) => x + y, 0) / stats.ticketMs.length) : 0,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    agents: agents.map(a => ({ id: a.id, status: a.status, tickets: a.tickets }))
  });
}
