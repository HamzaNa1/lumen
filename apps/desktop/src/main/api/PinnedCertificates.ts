import { X509Certificate } from "node:crypto";
import { checkServerIdentity, type PeerCertificate, rootCertificates } from "node:tls";

/** A server's LAN certificate, and the origins it advertised for it. */
export interface PinnedTls {
  readonly certificate: string;
  readonly origins: ReadonlyArray<string>;
}

/** What an account contributes to pinning: its server's certificate and every origin it uses. */
export interface PinSource {
  readonly origin: string;
  readonly routes: ReadonlyArray<{ readonly origin: string }>;
  readonly tls?: PinnedTls;
}

/** The certificate's SHA-256 fingerprint as Node prints it, or null when it does not parse. */
export const certificateFingerprint = (pem: string): string | null => {
  try {
    return new X509Certificate(pem).fingerprint256;
  } catch {
    return null;
  }
};

const normalizeHost = (host: string): string => host.replace(/^\[|\]$/gu, "").toLowerCase();

const hostOf = (origin: string): string | null => {
  try {
    return normalizeHost(new URL(origin).hostname);
  } catch {
    return null;
  }
};

/**
 * Certificates a host may present instead of one a public CA signed. A server's certificate is
 * trusted only on the hosts of that server's own routes, so one server cannot answer for another.
 */
export class PinnedCertificates {
  constructor(private readonly sources: () => ReadonlyArray<PinSource>) {}

  certificatesFor(host: string): ReadonlyArray<string> {
    const wanted = normalizeHost(host);
    const certificates = new Set<string>();
    for (const source of this.sources()) {
      if (source.tls === undefined) continue;
      const origins = [source.origin, ...source.tls.origins, ...source.routes.map((r) => r.origin)];
      if (origins.some((origin) => hostOf(origin) === wanted))
        certificates.add(source.tls.certificate);
    }
    return [...certificates];
  }

  /** Whether `host` presenting the certificate `pem` reaches a server that pinned it there. */
  trusts(host: string, pem: string): boolean {
    const presented = certificateFingerprint(pem);
    return (
      presented !== null &&
      this.certificatesFor(host).some((pinned) => certificateFingerprint(pinned) === presented)
    );
  }

  /** Options for Node's TLS that accept the host's pinned certificates and public CAs otherwise. */
  tlsOptions(host: string): {
    readonly ca: ReadonlyArray<string>;
    readonly checkServerIdentity: (host: string, certificate: PeerCertificate) => Error | undefined;
  } {
    const pinned = this.certificatesFor(host);
    const accepted = new Set(pinned.map(certificateFingerprint));
    return {
      ca: [...rootCertificates, ...pinned],
      // A pinned certificate names no host, so its exact bytes stand in for the name check.
      checkServerIdentity: (name, certificate) =>
        accepted.has(certificate.fingerprint256)
          ? undefined
          : checkServerIdentity(name, certificate),
    };
  }
}
