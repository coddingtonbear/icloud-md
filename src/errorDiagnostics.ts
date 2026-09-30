/** Scrub free-text diagnostics before either displaying or persisting them.
 * Do not serialize arbitrary error properties (they may hold requests/cookies).
 * This is defense in depth, not a substitute for reviewing a report to share. */
export function redactDiagnostic(text: string): string {
  return text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        if (url.username || url.password) {
          url.username = "REDACTED";
          url.password = "";
        }
        if (url.search) url.search = "?REDACTED";
        if (url.hash) url.hash = "#REDACTED";
        return url.toString();
      } catch {
        return "[redacted URL]";
      }
    })
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie|scnt|x-apple-id-session-id)\s*:\s*[^\r\n]+/gi, "[redacted header]")
    .replace(/(["']?[\w.-]*(?:password|passwd|secret|token|cookie|authorization|api[_-]?key|securityCode|scnt|session[_-]?id)[\w.-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi, "$1 [redacted]");
}

/** Keep useful nested causes without following cycles or dumping object internals. */
export function diagnosticMessage(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && !seen.has(current) && parts.length < 5) {
    seen.add(current);
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return redactDiagnostic(parts.join("\nCaused by: "));
}
