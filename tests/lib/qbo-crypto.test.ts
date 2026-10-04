import { describe, it } from "node:test";
import assert from "node:assert";
import { randomBytes } from "node:crypto";
import {
  decryptQboSecret,
  encryptQboSecret,
  parseQboEncryptionKey,
} from "@/lib/qbo-crypto";
import { QboConfigError, QboError } from "@/lib/qbo-errors";

const HEX_KEY = randomBytes(32).toString("hex");
const BASE64_KEY = randomBytes(32).toString("base64");

describe("parseQboEncryptionKey", () => {
  it("accepts a 64-char hex key", () => {
    const key = parseQboEncryptionKey(HEX_KEY);
    assert.strictEqual(key.length, 32);
  });

  it("accepts a base64-encoded 32-byte key", () => {
    const key = parseQboEncryptionKey(BASE64_KEY);
    assert.strictEqual(key.length, 32);
  });

  it("fails closed when the key is missing", () => {
    assert.throws(() => parseQboEncryptionKey(undefined), QboConfigError);
    assert.throws(() => parseQboEncryptionKey(""), QboConfigError);
  });

  it("rejects malformed and wrong-length keys", () => {
    assert.throws(() => parseQboEncryptionKey("tooshort"), QboConfigError);
    assert.throws(
      () => parseQboEncryptionKey(randomBytes(16).toString("hex")),
      QboConfigError
    );
    assert.throws(
      () => parseQboEncryptionKey("z".repeat(64)),
      QboConfigError
    );
  });
});

describe("encrypt/decrypt roundtrip", () => {
  it("encrypts and decrypts a secret", () => {
    const key = parseQboEncryptionKey(HEX_KEY);
    const secret = "refresh-token-value-with-symbols_AB123==";
    const envelope = encryptQboSecret(secret, key);
    assert.notStrictEqual(envelope, secret);
    assert.ok(envelope.startsWith("v1."));
    assert.strictEqual(decryptQboSecret(envelope, key), secret);
  });

  it("produces a fresh nonce per encryption", () => {
    const key = parseQboEncryptionKey(HEX_KEY);
    const a = encryptQboSecret("same", key);
    const b = encryptQboSecret("same", key);
    assert.notStrictEqual(a, b);
  });

  it("refuses to decrypt with the wrong key", () => {
    const key = parseQboEncryptionKey(HEX_KEY);
    const other = parseQboEncryptionKey(randomBytes(32).toString("hex"));
    const envelope = encryptQboSecret("secret", key);
    assert.throws(() => decryptQboSecret(envelope, other), QboError);
  });

  it("refuses tampered ciphertext", () => {
    const key = parseQboEncryptionKey(HEX_KEY);
    const envelope = encryptQboSecret("secret", key);
    const parts = envelope.split(".");
    // Flip a byte in the ciphertext segment.
    const ct = Buffer.from(parts[3], "base64");
    ct[0] = ct[0] ^ 0xff;
    parts[3] = ct.toString("base64");
    assert.throws(() => decryptQboSecret(parts.join("."), key), QboError);
  });

  it("refuses malformed envelopes", () => {
    const key = parseQboEncryptionKey(HEX_KEY);
    for (const bad of ["", "abc", "v2.a.b.c", "v1.a.b", "v1.a.b.c.d"]) {
      assert.throws(() => decryptQboSecret(bad, key), QboError);
    }
  });
});
