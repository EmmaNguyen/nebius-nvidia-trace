import assert from 'node:assert/strict';

const baseUrl = (process.env.TRACEBACK_URL || 'http://localhost:3000').replace(/\/$/, '');
const statusResponse = await fetch(`${baseUrl}/api/status`);
assert.equal(statusResponse.status, 200, 'Traceback server should be reachable');
const status = await statusResponse.json();
assert.equal(status.configured, true, 'Set NEBIUS_API_KEY on the server before running this live test');
assert.equal(status.provider, 'Nebius Token Factory');
console.log(`Calling ${status.provider} with ${status.model} at ${baseUrl}…`);

const response = await fetch(`${baseUrl}/api/analyze`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    trace: '[1] tool=inventory_api status=timeout after_ms=2000\n[2] assistant_output="All 12 items are in stock."',
    context: 'Only report inventory facts supported by a successful inventory tool result.'
  }),
  signal: AbortSignal.timeout(60_000)
});
const payload = await response.json();
assert.equal(response.status, 200, `Inference failed: ${payload.error || response.status}`);
assert.equal(payload.mode, 'nebius', 'A live inference response must be returned; deterministic demo mode is not accepted');
assert.ok(payload.model, 'Provider model ID should be visible');
assert.ok(payload.result && typeof payload.result.summary === 'string', 'Expected a structured incident analysis');
console.log(`Live Token Factory inference passed (${payload.model}); findings=${payload.result.findings.length}, confidence=${payload.result.overall_confidence}.`);
