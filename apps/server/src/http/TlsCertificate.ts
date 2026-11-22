import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface TlsCertificate {
  readonly key: string;
  readonly cert: string;
}

const DAY_MS = 86_400_000;
const VALIDITY_MS = 3_650 * DAY_MS;
const RENEW_BEFORE_MS = 30 * DAY_MS;

const der = (tag: number, content: Buffer): Buffer => {
  if (content.length < 0x80) return Buffer.concat([Buffer.from([tag, content.length]), content]);
  const length: number[] = [];
  for (let rest = content.length; rest > 0; rest >>= 8) length.unshift(rest & 0xff);
  return Buffer.concat([Buffer.from([tag, 0x80 | length.length, ...length]), content]);
};

const sequence = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts));

const objectId = (dotted: string): Buffer => {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const value of rest) {
    const groups: number[] = [];
    let remaining = value;
    do {
      groups.unshift(remaining & 0x7f);
      remaining = Math.floor(remaining / 128);
    } while (remaining > 0);
    bytes.push(...groups.map((group, index) => (index < groups.length - 1 ? group | 0x80 : group)));
  }
  return der(0x06, Buffer.from(bytes));
};

// RFC 5280 encodes dates through 2049 as UTCTime and later ones as GeneralizedTime.
const time = (date: Date): Buffer => {
  const stamp = `${date.toISOString().replace(/[-:T]/gu, "").slice(0, 14)}Z`;
  return date.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(stamp.slice(2)))
    : der(0x18, Buffer.from(stamp));
};

const pem = (label: string, body: Buffer): string =>
  `-----BEGIN ${label}-----\n${body
    .toString("base64")
    .replace(/(.{64})/gu, "$1\n")
    .trimEnd()}\n-----END ${label}-----\n`;

/** A self-signed ECDSA P-256 certificate. Clients pin it whole, so it names no host. */
export const createTlsCertificate = (nowMs = Date.now()): TlsCertificate => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const algorithm = sequence(objectId("1.2.840.10045.4.3.2"));
  const name = sequence(
    der(0x31, sequence(objectId("2.5.4.3"), der(0x0c, Buffer.from("Lumen Server")))),
  );
  const notCertificateAuthority = sequence(
    objectId("2.5.29.19"),
    der(0x01, Buffer.from([0xff])),
    der(0x04, sequence()),
  );
  const toBeSigned = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    algorithm,
    name,
    sequence(time(new Date(nowMs - DAY_MS)), time(new Date(nowMs + VALIDITY_MS))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, sequence(notCertificateAuthority)),
  );
  const signature = sign("sha256", toBeSigned, privateKey);
  const certificate = sequence(
    toBeSigned,
    algorithm,
    der(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: pem("CERTIFICATE", certificate),
  };
};

const readUsable = async (
  keyPath: string,
  certPath: string,
  nowMs: number,
): Promise<TlsCertificate | null> => {
  try {
    const [key, cert] = await Promise.all([readFile(keyPath, "utf8"), readFile(certPath, "utf8")]);
    const parsed = new X509Certificate(cert);
    if (!parsed.checkPrivateKey(createPrivateKey(key))) return null;
    if (Date.parse(parsed.validTo) - nowMs < RENEW_BEFORE_MS) return null;
    return { key, cert };
  } catch {
    return null;
  }
};

const writePrivate = async (path: string, contents: string): Promise<void> => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
};

/**
 * The LAN listener's certificate, kept in the data directory so clients that pinned it keep
 * trusting the server across restarts. A missing, unreadable or nearly expired pair is replaced.
 */
export const loadTlsCertificate = async (
  dataDir: string,
  nowMs = Date.now(),
): Promise<TlsCertificate> => {
  const directory = join(dataDir, "tls");
  const keyPath = join(directory, "lan-key.pem");
  const certPath = join(directory, "lan-cert.pem");
  const existing = await readUsable(keyPath, certPath, nowMs);
  if (existing !== null) return existing;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const created = createTlsCertificate(nowMs);
  // The key lands first, so a crash between the writes leaves a pair that fails the check above.
  await writePrivate(keyPath, created.key);
  await writePrivate(certPath, created.cert);
  return created;
};
