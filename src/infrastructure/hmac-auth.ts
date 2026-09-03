import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface HmacHeaders { "x-lcc-key-id": string; "x-lcc-timestamp": string; "x-lcc-nonce": string; "x-lcc-signature": string }
export interface HmacCredentials { keyId: string; secret: string }

export function bodyDigest(body: string): string { return createHash("sha256").update(body).digest("hex"); }
function canonical(method: string, path: string, timestamp: string, nonce: string, body: string): string { return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyDigest(body)}`; }
export function signRequest(credentials: HmacCredentials, method: string, path: string, body = "", now = Date.now(), nonce = randomBytes(16).toString("hex")): HmacHeaders {
  const timestamp = String(now);
  const signature = createHmac("sha256", credentials.secret).update(canonical(method, path, timestamp, nonce, body)).digest("hex");
  return { "x-lcc-key-id": credentials.keyId, "x-lcc-timestamp": timestamp, "x-lcc-nonce": nonce, "x-lcc-signature": signature };
}

export class HmacVerifier {
  private readonly nonces = new Map<string, number>();
  constructor(private readonly credentials: HmacCredentials, private readonly maxSkewMs = 60_000, private readonly now: () => number = Date.now) {}
  verify(method: string, path: string, body: string, headers: Partial<HmacHeaders>): boolean {
    const keyId = headers["x-lcc-key-id"], timestamp = headers["x-lcc-timestamp"], nonce = headers["x-lcc-nonce"], signature = headers["x-lcc-signature"];
    if (!keyId || keyId !== this.credentials.keyId || !timestamp || !nonce || !signature || !/^\d+$/.test(timestamp)) return false;
    const time = Number(timestamp), current = this.now();
    if (Math.abs(current - time) > this.maxSkewMs || this.nonces.has(nonce)) return false;
    const expected = createHmac("sha256", this.credentials.secret).update(canonical(method, path, timestamp, nonce, body)).digest();
    let supplied: Buffer; try { supplied = Buffer.from(signature, "hex"); } catch { return false; }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    this.nonces.set(nonce, current); for (const [value, seen] of this.nonces) if (current - seen > this.maxSkewMs) this.nonces.delete(value);
    return true;
  }
}
