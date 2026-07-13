/**
 * Merges Set-Cookie response headers into an existing "name=value; name2=value2"
 * Cookie header string, keeping only the name=value pair from each Set-Cookie
 * entry (dropping Path/Domain/Secure/HttpOnly/Max-Age/SameSite attributes) and
 * letting a later header for the same name overwrite an earlier one - mirrors
 * how a real cookie jar accumulates cookies across a request sequence.
 */
export function mergeSetCookies(existingCookieHeader: string, setCookieHeaders: readonly string[]): string {
  const cookies = new Map<string, string>();

  for (const pair of existingCookieHeader.split(";")) {
    const parsed = parseNameValue(pair);
    if (parsed) {
      cookies.set(parsed[0], parsed[1]);
    }
  }

  for (const setCookieHeader of setCookieHeaders) {
    const firstSegment = setCookieHeader.split(";", 1)[0] ?? "";
    const parsed = parseNameValue(firstSegment);
    if (parsed) {
      cookies.set(parsed[0], parsed[1]);
    }
  }

  return Array.from(cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function parseNameValue(pair: string): [string, string] | undefined {
  const equalsIndex = pair.indexOf("=");
  if (equalsIndex === -1) {
    return undefined;
  }
  const name = pair.slice(0, equalsIndex).trim();
  const value = pair.slice(equalsIndex + 1).trim();
  if (!name) {
    return undefined;
  }
  return [name, value];
}
