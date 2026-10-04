// Application-level encryption for QuickBooks OAuth token material at rest
// (issue #161). Bearer and refresh tokens are credentials; they are stored
// in Firestore only inside an authenticated-encryption envelope, never as
// plaintext fields.
//
// Envelope: `v1.<base64 iv>.<base64 authTag>.<base64 ciphertext>` —
// AES-256-GCM with a random 12-byte nonce per encryption. The `v1` prefix
// versions the envelope so a future key/algorithm rotation can read old
// records deliberately rather than guessing.
//
// The key arrives via QBO_TOKEN_ENCRYPTION_KEY as 64 hex chars or a
// base64-encoded 32-byte value. Missing or malformed keys fail closed:
// encrypting nothing is always better than storing tokens weakly.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { QboConfigError, QboError } from "@/lib/qbo-errors";

const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export function parseQboEncryptionKey(raw: string | undefined): Buffer {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new QboConfigError("QBO_TOKEN_ENCRYPTION_KEY is not configured.");
  }
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, "hex");
  } else {
    try {
      const decoded = Buffer.from(value, "base64");
      if (decoded.length === KEY_BYTES) key = decoded;
    } catch {
      key = null;
    }
  }
  if (!key || key.length !== KEY_BYTES) {
    throw new QboConfigError(
      "QBO_TOKEN_ENCRYPTION_KEY must be 64 hex characters or a base64-encoded 32-byte key."
    );
  }
  return key;
}

export function encryptQboSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

// Decrypts an envelope produced by encryptQboSecret. Any malformed shape or
// authentication failure is a single opaque error — no partial plaintext
// and no detail an attacker could use ever escapes.
export function decryptQboSecret(envelope: string, key: Buffer): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new QboError(
      "Stored QuickBooks credential is not in a recognized format.",
      "unexpected"
    );
  }
  try {
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const ciphertext = Buffer.from(parts[3], "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new QboError(
      "Stored QuickBooks credential could not be decrypted.",
      "unexpected"
    );
  }
}

// The deployment's configured encryption key — resolves lazily so builds
// and unconfigured environments never touch it.
export function getQboEncryptionKey(): Buffer {
  return parseQboEncryptionKey(process.env.QBO_TOKEN_ENCRYPTION_KEY);
}
