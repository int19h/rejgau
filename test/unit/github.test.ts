import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pemToPkcs8 } from "../../src/github";

describe("pemToPkcs8", () => {
  it("wraps a PKCS#1 key (as GitHub issues them) so WebCrypto can sign with it", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    expect(pkcs1).toContain("BEGIN RSA PRIVATE KEY");
    const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(pkcs1), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const data = new TextEncoder().encode("hello");
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
    expect(verify("sha256", data, createPublicKey(privateKey), Buffer.from(sig))).toBe(true);
  });

  it("passes PKCS#8 through, including keys pasted with literal \\n", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const der = privateKey.export({ type: "pkcs8", format: "der" });
    expect(Buffer.from(pemToPkcs8(pkcs8.replace(/\n/g, "\\n")))).toEqual(der);
  });
});
