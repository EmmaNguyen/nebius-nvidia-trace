# Traceback

**Evidence-grounded incident investigation for AI workflows.** Paste a run trace and expected behavior to get a likely diagnosis, trace citations, uncertainty, and a suggested fix with a replay check.

Traceback is a hackathon MVP for the Nebius × NVIDIA Global AI Hackathon, Best Apps and Agents track. It uses an NVIDIA Nemotron model through Nebius Token Factory when configured. Without credentials it runs a clearly labeled deterministic demo analysis for the included synthetic incident.

## Setup

**Requirements:** Node.js 20 or newer. The project has no npm packages, so there is no `npm install` step.

1. Clone the repository and change into it.
2. Copy the example environment file: `cp .env.example .env`
3. Create a Token Factory API key in the Nebius console and set `NEBIUS_API_KEY` in `.env`. Keep `.env` private; it is listed in `.gitignore`.
4. Start the server: `npm start`
5. Open [http://localhost:3000](http://localhost:3000). The top bar shows `LIVE INFERENCE` with the model name when the key is set, and `DEMO · NO API CALL` otherwise.
6. Check the live path: `npm run eval:live` (with the server running). This makes one real request, so it uses a small amount of Token Factory credit.

Environment variables (read from `.env` or the shell):

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NEBIUS_API_KEY` | For live inference | none | Token Factory key. It stays on the server. |
| `NEBIUS_MODEL` | No | `nvidia/Nemotron-3_5-Lightning` | Any NVIDIA open model your Token Factory account can use. |
| `NEBIUS_BASE_URL` | No | `https://api.tokenfactory.nebius.com/v1` | OpenAI-compatible base URL. |
| `PORT` | No | `3000` | HTTP port. |
| `HOST` | No | `127.0.0.1` | Bind address. Keep loopback unless you add access control. |

Troubleshooting:
- **`Traceback server should be reachable`** from `npm run eval:live`: start `npm start` first.
- **`Set NEBIUS_API_KEY on the server…`**: the key is missing from `.env`, or the server started before you added it. Restart the server.
- **`Inference failed`**: the error includes the Token Factory status and detail. Check the key, and check that your account can use the model in `NEBIUS_MODEL`.
- **Port 3000 in use**: run `PORT=3001 npm start`.

## NVIDIA open models and Nebius services

**Model:** `nvidia/Nemotron-3_5-Lightning`, an NVIDIA Nemotron open model, served by Nebius Token Factory. Traceback uses it in three places:

- **Incident analysis** (`POST /api/analyze`, `lib/model.mjs`, `server.mjs`): reads the submitted trace, runtime evidence and expected behavior, and returns structured findings. Requests use JSON response format at low temperature (0.1, then 0 on the retry), with thinking disabled (`enable_thinking: false`) so the JSON isn't crowded out. A malformed response gets one retry.
- **Patrol officer** (`patrol/officer.mjs`): an agent loop of up to five steps (read lines, check policy, write ticket). Every citation in the ticket is verified against the source line.
- **Live check** (`npm run eval:live`): one real request that fails if the app falls back to demo mode.

To try another NVIDIA open model, set `NEBIUS_MODEL`. The top bar shows the active model.

**How Token Factory sped up the build:**
- It is a hosted, OpenAI-compatible chat completions API. The server makes a standard bearer-token request, so the project needed no model serving, GPU provisioning or inference stack.
- Switching models is a single environment variable, with no code change.
- The API key stays on the server, and the browser never receives it.
- Limit: we have not yet published measured latency or cost per investigation. Each live analysis response includes `latencyMs`, which is the figure to report.

**Other Nebius services:** none. Token Factory is the only Nebius service this project uses. It does not use AI Cloud compute, Serverless Endpoints, Serverless Jobs or DevPods. Serverless Endpoints (deployment) and Serverless Jobs (background patrol runs) are planned, not implemented.

**Other NVIDIA technologies:** NVIDIA OpenShell is supported as pasted runtime evidence, a text import only. NVIDIA Sentry is represented only by a synthetic illustrative sample. Neither is connected to a live runtime.

Open [http://localhost:3000](http://localhost:3000). Without a key the app runs an explicitly labeled deterministic demo; it does not pretend this path used Nemotron. To meet the hackathon's runtime-use requirement and verify live behavior, configure `NEBIUS_API_KEY` and run `npm run eval:live` (see [Live inference verification](#live-inference-verification)).

The default model is `nvidia/Nemotron-3_5-Lightning`. Set `NEBIUS_MODEL` to another NVIDIA open model available to your Token Factory account. The server makes a runtime call to the OpenAI-compatible chat completions endpoint; the API key stays server-side. The UI shows whether it is using live Token Factory inference or the local demo path. See [Nebius Token Factory's Nemotron API guide](https://nebius.com/services/token-factory/models/nvidia-nemotron-models-inference).

## What it does

1. Paste a multi-line model/tool trace and optional expected behavior.
2. Traceback asks Nemotron to identify likely failures using only submitted context.
3. Every factual finding must cite exact trace lines. Each citation is checked against the source line and quote; invalid citations are dropped. A finding left with no valid citation is downgraded to informational.
4. Review uncertainty, missing evidence, and a verification step. Traceback never executes suggested changes.

Optional runtime activity can also be pasted and labeled as OpenShell, Sentry, or another source. Evidence citations retain that source label and line number. This is a text import boundary: Traceback does not connect to, authenticate, or control either runtime. The Sentry example is synthetic illustrative normalized text and is not a native Sentry event format. See the [system design](./docs/system-design.md).

Inputs are held only for the current browser session and are not written to a database. When a Nebius key is configured, trace and context are sent to Nebius Token Factory for inference; in local demo mode they remain on this machine. Do not paste production secrets or personal data. Recognized API keys, bearer tokens, credential assignments, and email addresses are scrubbed from returned analysis.

## Patrol mode (agent orchestration)

Open [http://localhost:3000/patrol](http://localhost:3000/patrol) and start a shift. Patrol mode watches a fleet of agents live instead of analyzing one pasted run:

1. **Radar** (`patrol/radar.mjs`): deterministic rules check every event as it happens against each agent's limits (allowed hosts, spending caps, instructions inside tool output, plans to bypass constraints, success claims after a failure). No model call; typically well under a millisecond per event.
2. **Officer** (`patrol/officer.mjs`): when the radar hits, an officer agent on Nemotron investigates in a loop of up to five steps. It chooses which lines to read (`read_lines`), can check the policy (`check_policy`), and ends with `write_ticket`. Every ticket citation is verified against the exact source line; findings without a verified citation are dropped and listed on the ticket.
3. **Dispatcher** (`patrol/dispatch.mjs`): three officer units work in parallel. Free units go to the most urgent waiting hit (high severity first, then oldest), and a new high-severity hit gets a backup unit instead of waiting behind an earlier investigation.
4. **Containment (simulated runtime)**: by default, the first sign of traffic leaving a sandbox (the radar's off-route or exemption rules) triggers the runtime's **emergency stop** straight away, with no model in the loop, and every running agent halts within a millisecond. Officers still investigate afterwards and write the cited report. Two other policies are available: `any` stops everything at any radar hit, including a stated plan to get around a limit, and `verify` keeps the older behavior of pausing one agent only after a verified high-severity ticket. Halted agents' later actions are reported as prevented. Traceback never stops an agent itself: it triggers the runtime's stop. Because Traceback reads each record after the action, the request that trips the stop has already happened; only a deny-by-default runtime policy can block that first request.

The fleet (`patrol/fleet.mjs`) is synthetic: six agents, four of which break their limits (prompt injection and an over-limit refund, a false metric claim, a sandbox escape through a maintenance proxy, a false success report after a denied write) and two that stay within them. In our live test shifts, every violator received a high-severity ticket, clean agents received none, all citations verified, and the runtime paused the escaping agent before its git clone. Results vary between live runs because the officer is a model.

With a Token Factory key, each investigation makes up to five Nemotron calls (a full shift is typically 15–30 calls), and only one live shift runs at a time. Choose **Demo officer** in the UI, or call `/api/patrol?mode=demo`, to run the same flow with a deterministic officer and no model calls.

## Escape simulation

Open [http://localhost:3000/simulate](http://localhost:3000/simulate) to watch one agent, eval-runner-09, escape an offline sandbox through a maintenance proxy. Run it twice:

- **Without Traceback:** the agent reaches pypi.org and GitHub, takes the CTF answers, and reports that it used only the provided tools. OpenShell allows every request through the proxy exemption, and nothing flags it.
- **With Traceback:** at the first escape sign, Traceback triggers the runtime's emergency stop and the agent halts within a millisecond, so the git clone, the GitHub egress and the false report never run. The first request to pypi.org has already left by then; choose "Stop everything at any warning sign" to stop on the agent's stated plan instead, before anything leaves. Officers (Nemotron, or the demo officer) still investigate and write the cited ticket.

The page animates the sandbox, the proxy, OpenShell's gate and the internet, narrates each step in plain words, and lines up the two records as they arrive, marking flagged and cited lines. It runs the real patrol engine on that one agent, through the same event stream as `/api/patrol`. Every record is synthetic and the runtime is simulated.

## API

- `GET /api/status` reports whether Nebius credentials are configured and the selected model ID.
- `POST /api/analyze` accepts `{ "trace": string, "context": string, "runtimeEvidence": string, "runtimeSource": "openshell" | "sentry" | "other" }` and returns `{ "mode", "model", "result" }`. Trace is required; limits are 60,000 characters for trace, 20,000 for context, and 20,000 for runtime evidence. Citations identify each source independently and are checked against the corresponding pasted text.
- `GET /api/patrol?speed=1&mode=live|demo&contain=escape|any|verify` streams one patrol shift as server-sent events: `shift`, `event` (every radar check, with its hits and timing), `agent` (status changes), `emergency` (the tripwire fired and the runtime halted every running agent), `dispatch`, `officer` (each investigation step), `ticket`, `prevented` (actions not run after a pause), `done`, and `failure`. `speed` is clamped to 0.5–25. A second live shift while one is running returns 429.
- `GET /api/simulate?traceback=on|off&mode=live|demo&contain=escape|any|verify&speed=1` streams the same events for the escape simulation: eval-runner-09 alone, with Traceback on or off. With Traceback off there is no radar, no officer and no model call.

## Live inference verification

After setting `NEBIUS_API_KEY` on the server and starting Traceback, run:

```sh
npm run eval:live
```

This makes a real inference request to the configured Token Factory model and fails if the app is unconfigured or returns its deterministic demo path. It uses synthetic trace content. It may consume Nebius credits. `npm run eval` runs local deterministic checks only and makes no external model calls; it includes a fast demo patrol shift that checks clean agents get no tickets, every citation verifies, and the escaping agent is paused before its git clone.

## OpenShell and Sentry notes

The [NVIDIA/OpenShell source repository](https://github.com/NVIDIA/OpenShell) is public. NVIDIA describes OpenShell as a sandboxed runtime with policy-enforced access and audit activity. The app presently accepts pasted records; a live OpenShell connector is not implemented.

NVIDIA's [Sentry reference-design article](https://developer.nvidia.com/blog/nvidia-open-agent-safety-platform-a-reference-for-continuous-in-silicon-agent-monitoring/) describes out-of-band monitoring on BlueField-4. The official sources checked did not expose a separate public Sentry source repository or native event schema/SDK. The app therefore makes no native integration claim: its seeded Sentry scenario is synthetic illustrative text, and pasted labels are unverified. Traceback remains read-only; OpenShell/Sentry own monitoring and enforcement. See [system design](./docs/system-design.md) for boundaries and references.

No incident content is logged or persisted by the server. The app does not include authentication and is intended for local demos or a protected hackathon deployment; add access controls before exposing it to untrusted users.

## License

MIT License, an OSI-approved open-source license. See [LICENSE](./LICENSE).
