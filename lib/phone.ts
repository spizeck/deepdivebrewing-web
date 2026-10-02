// Phone number normalization for trade leads (Issue #152). Dependency-free
// and client-safe: the admin workspace uses it for display and tel:/wa.me
// links, and the server persists the normalized form on lead writes.
//
// The brewery sits on Saba (+599, Caribbean Netherlands) and most trade
// contacts are on neighboring islands. Normalization is deliberately
// conservative — an `e164` value is only produced for inputs that carry an
// explicit international prefix (`+`/`00`) or match an unambiguous local
// pattern (7-digit Saba local, NANP-style 10/11-digit). Anything else keeps
// its raw form for display and never produces a WhatsApp link, because a
// guessed wa.me URL points at the wrong person's phone.

export interface NormalizedPhone {
  // Canonical E.164 ("+<digits>") when the number can be confidently
  // interpreted, else null.
  e164: string | null;
  // Human-readable form: grouped E.164 when known, else the raw input.
  display: string;
  // Digits-only form suitable for tel:/wa.me when e164 is known.
  digits: string | null;
}

// Saba local numbers are 7 digits behind the +599 country code.
const DEFAULT_COUNTRY_CODE = "599";
const LOCAL_DIGITS = 7;
const E164_MIN = 7;
const E164_MAX = 15;

function digitsOnly(value: string): string {
  return value.replace(/[^\d]/g, "");
}

function validDigits(digits: string): boolean {
  return (
    digits.length >= E164_MIN &&
    digits.length <= E164_MAX &&
    !digits.startsWith("0")
  );
}

function groupDigits(digits: string): string {
  // NANP-style +1 numbers: +1 (721) 555-1234.
  if (digits.startsWith("1") && digits.length === 11) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  // Caribbean Netherlands +599 numbers: +599 416 3544.
  if (digits.startsWith(DEFAULT_COUNTRY_CODE) && digits.length === 10) {
    return `+599 ${digits.slice(3, 6)} ${digits.slice(6)}`;
  }
  // Generic fallback: "+", first 3 digits, then groups of 3.
  const head = digits.slice(0, 3);
  const rest = digits.slice(3);
  const groups: string[] = [];
  for (let i = 0; i < rest.length; i += 3) {
    groups.push(rest.slice(i, i + 3));
  }
  return `+${head} ${groups.join(" ")}`.trim();
}

// Normalizes free-form input ("+1 (721) 555-1234", "416 3544",
// "00599 416 3544", …) into a canonical E.164 form where the number can be
// safely interpreted. `defaultCountryCode` (the digits after "+") applies
// only to bare local-length numbers.
export function normalizePhoneNumber(
  raw: string,
  defaultCountryCode: string = DEFAULT_COUNTRY_CODE
): NormalizedPhone {
  const trimmed = raw.trim();
  if (!trimmed) return { e164: null, display: "", digits: null };

  const hadPlus = trimmed.startsWith("+");
  const hadIdd = !hadPlus && trimmed.startsWith("00");
  // For an explicit international prefix the digits after "+" or "00" are
  // the full E.164 national number.
  const digits = hadIdd
    ? digitsOnly(trimmed.slice(2))
    : digitsOnly(trimmed);
  if (!digits) return { e164: null, display: trimmed, digits: null };

  if (hadPlus || hadIdd) {
    if (validDigits(digits)) {
      return { e164: `+${digits}`, display: groupDigits(digits), digits };
    }
    return { e164: null, display: trimmed, digits: null };
  }

  // Bare 7-digit input: a local number in the brewery's home country code.
  if (digits.length === LOCAL_DIGITS) {
    const full = `${defaultCountryCode}${digits}`;
    if (validDigits(full)) {
      return { e164: `+${full}`, display: groupDigits(full), digits: full };
    }
  }

  // Bare input that already starts with the default country code and has
  // exactly the local length after it ("599 416 3544" without the "+").
  if (
    digits.startsWith(defaultCountryCode) &&
    digits.length === defaultCountryCode.length + LOCAL_DIGITS
  ) {
    if (validDigits(digits)) {
      return { e164: `+${digits}`, display: groupDigits(digits), digits };
    }
  }

  // Bare 11-digit numbers starting with "1" are unambiguous NANP
  // international form ("17215551234" → +1 721 555 1234, Sint Maarten).
  if (digits.length === 11 && digits.startsWith("1")) {
    return { e164: `+${digits}`, display: groupDigits(digits), digits };
  }

  // Bare 10-digit numbers read as NANP national form ("721 555 1234" →
  // +1 721 555 1234). Safe here only because it follows the +599 checks
  // above — a 10-digit input that starts "599" is Caribbean Netherlands,
  // not NANP.
  if (digits.length === 10) {
    const full = `1${digits}`;
    if (validDigits(full)) {
      return { e164: `+${full}`, display: groupDigits(full), digits: full };
    }
  }

  // Anything else is ambiguous — keep the raw text for display and never
  // mint a confident international form.
  return { e164: null, display: trimmed, digits: null };
}

// `tel:` link. Prefers the canonical E.164 form; falls back to the raw
// digits so an unparseable number still dials (the handset sorts it out) —
// numbers that don't normalize still deserve a call link.
export function telHref(phone: NormalizedPhone): string | null {
  if (phone.e164) return `tel:${phone.e164}`;
  const raw = phone.display.replace(/[^\d]/g, "");
  return raw.length >= 3 ? `tel:${raw}` : null;
}

// `wa.me` deep link. wa.me requires the full international number, so this
// exists only when normalization produced a confident E.164 — a guessed
// link would target the wrong account.
export function whatsappHref(phone: NormalizedPhone): string | null {
  if (!phone.e164) return null;
  return `https://wa.me/${phone.e164.slice(1)}`;
}
