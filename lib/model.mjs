// Shared Nebius Token Factory client and evidence safeguards, used by /api/analyze and the patrol officer.
// Settings are read lazily because server.mjs loads .env after its imports are evaluated.

export const baseUrl = () => (process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/$/, '');
export const modelId = () => process.env.NEBIUS_MODEL || 'nvidia/Nemotron-3_5-Lightning';
export const configured = () => Boolean(process.env.NEBIUS_API_KEY);

export async function chat({ messages, temperature = 0.1, maxTokens = 1800, timeoutMs = 45_000, signal }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.NEBIUS_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelId(),
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      // Nemotron otherwise writes its reasoning into content and runs out of tokens before the JSON.
      chat_template_kwargs: { enable_thinking: false },
      messages
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Nebius Token Factory returned ${response.status}. ${detail}`);
  }
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Nebius returned an empty response. Please try again.');
  return { content, model: payload.model || modelId() };
}

export function extractJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    // Some models prepend prose ("Here's the analysis…") despite json_object mode.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('Model response was not valid JSON.');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

export function validateCitations(result, sources) {
  for (const finding of result.findings) {
    const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
    finding.evidence = evidence.filter(item => {
      const source = typeof item.source === 'string' ? item.source : 'trace';
      const lines = sources[source];
      const lineNumber = Number(item.line);
      return Array.isArray(lines) && Number.isInteger(lineNumber) && lineNumber >= 1 && lineNumber <= lines.length &&
        typeof item.quote === 'string' && item.quote.trim().length > 0 && lines[lineNumber - 1].includes(item.quote);
    });
    if (!finding.evidence.length) {
      finding.uncertainty = [finding.uncertainty, 'No citation could be verified against the supplied trace; treat this finding as unsubstantiated.'].filter(Boolean).join(' ');
      finding.severity = 'info';
    }
  }
  return result;
}

export function scrubSensitiveOutput(payload) {
  const secretPatterns = [
    /\b(?:sk-[A-Za-z0-9_-]{8,}|nvapi-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/gi,
    /\b((?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*[:=]\s*)(?!\[REDACTED\])[^\s,;"']+/gi,
    /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
  ];
  const redact = value => secretPatterns.reduce((text, pattern) => text.replace(pattern, match => {
    if (/^\s*(?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*[:=]/i.test(match)) {
      return match.replace(/([^:=]+[:=]\s*).+$/i, '$1[REDACTED]');
    }
    return '[REDACTED]';
  }), value);
  const visit = value => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  return visit(payload);
}
