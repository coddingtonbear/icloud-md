import { createHash, pbkdf2Sync } from "node:crypto";

export type SrpProtocol = "s2k" | "s2k_fo";

/**
 * Apple's SRP password-key derivation (idmsa.apple.com's "s2k"/"s2k_fo" protocols):
 *   s2k:    PBKDF2-HMAC-SHA256(SHA256(password), salt, iterations, 32 bytes)
 *   s2k_fo: same, but the SHA256 digest is hex-encoded to an ASCII string first
 *           ("fo" - the digest is fed to PBKDF2 as hex text, not raw bytes).
 * The server picks which protocol applies to a given account via /signin/init's
 * response; the client doesn't choose.
 */
export function deriveSrpPassword(
  password: string,
  salt: Uint8Array,
  iterations: number,
  protocol: SrpProtocol,
): Uint8Array {
  const passwordDigest = createHash("sha256").update(password, "utf8").digest();
  const pbkdf2Input = protocol === "s2k_fo" ? Buffer.from(passwordDigest.toString("hex"), "utf8") : passwordDigest;

  return new Uint8Array(pbkdf2Sync(pbkdf2Input, salt, iterations, 32, "sha256"));
}
