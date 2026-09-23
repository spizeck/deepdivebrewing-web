// Canonical email-format check, shared by server routes and client
// components. Deliberately pragmatic — one "@", no whitespace, and a dot in
// the domain — not a full RFC 5322 parser. Dependency-free so client
// components can import it without pulling server modules into public
// bundles.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}
