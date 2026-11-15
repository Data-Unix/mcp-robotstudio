import { md5 } from "./md5.js";

export class RwsError extends Error {
  readonly status: number;
  readonly rwsCode?: string;
  readonly rwsMessage?: string;
  readonly rawBody?: string;

  constructor(
    message: string,
    options: {
      status: number;
      rwsCode?: string;
      rwsMessage?: string;
      rawBody?: string;
    },
  ) {
    super(message);
    this.name = "RwsError";
    this.status = options.status;
    this.rwsCode = options.rwsCode;
    this.rwsMessage = options.rwsMessage;
    this.rawBody = options.rawBody;
  }
}

export interface DigestChallenge {
  realm: string;
  nonce: string;
  domain?: string;
  qop?: string;
  opaque?: string;
  algorithm: string;
  stale: boolean;
}

export interface DigestAuthorizationInput {
  username: string;
  password: string;
  method: string;
  uri: string;
  challenge: DigestChallenge;
  nc: number;
  cnonce?: string;
}

export function generateCnonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function unquote(value: string): string {
  return value.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1");
}

function quoteDigestValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Parses a WWW-Authenticate header and strictly rejects Basic challenges
 * so passwords never travel in cleartext over HTTP.
 */
export function parseAuthenticateHeader(headerValue: string): DigestChallenge {
  const trimmed = headerValue.trim();
  if (!trimmed) {
    throw new RwsError("Empty WWW-Authenticate header", {
      status: 401,
      rwsCode: "AUTH_HEADER_EMPTY",
      rwsMessage: "Server returned 401 without a WWW-Authenticate challenge",
    });
  }

  // Split challenges only if a Digest scheme is present alongside others,
  // but reject if only Basic (or any non-Digest scheme) is offered.
  const digestMatch = /(?:^|,\s*)Digest\s+(.+)$/i.exec(trimmed);
  if (!digestMatch) {
    if (/^\s*Basic\b/i.test(trimmed)) {
      throw new RwsError(
        "Basic authentication challenge rejected: credentials must never be sent in cleartext over HTTP",
        {
          status: 401,
          rwsCode: "BASIC_AUTH_REJECTED",
          rwsMessage: "Basic authentication rejected by RWS client security policy",
        },
      );
    }
    throw new RwsError(`Unsupported authentication scheme: ${trimmed.split(/\s+/)[0]}`, {
      status: 401,
      rwsCode: "UNSUPPORTED_AUTH_SCHEME",
      rwsMessage: `Expected Digest authentication, got ${trimmed}`,
    });
  }

  const paramString = digestMatch[1] ?? "";
  const params: Record<string, string> = {};
  const paramRegex = /([a-zA-Z0-9_-]+)\s*=\s*("(?:\\.|[^"])*"|[^,\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = paramRegex.exec(paramString)) !== null) {
    const key = match[1]?.toLowerCase();
    const rawVal = match[2];
    if (key && rawVal !== undefined) {
      params[key] = unquote(rawVal);
    }
  }

  if (!params.realm || !params.nonce) {
    throw new RwsError("Malformed Digest challenge: missing realm or nonce", {
      status: 401,
      rwsCode: "MALFORMED_DIGEST_CHALLENGE",
      rwsMessage: "Missing required Digest challenge parameters (realm/nonce)",
    });
  }

  const algorithm = (params.algorithm ?? "MD5").toUpperCase();
  if (algorithm !== "MD5") {
    throw new RwsError(`Unsupported Digest algorithm: ${algorithm}`, {
      status: 401,
      rwsCode: "UNSUPPORTED_DIGEST_ALGORITHM",
      rwsMessage: `Only MD5 Digest is supported by RWS 1.0 (got ${algorithm})`,
    });
  }

  return {
    realm: params.realm,
    nonce: params.nonce,
    domain: params.domain,
    qop: params.qop,
    opaque: params.opaque,
    algorithm,
    stale: params.stale?.toUpperCase() === "TRUE",
  };
}

function selectQop(challengeQop?: string): "auth" | undefined {
  if (!challengeQop) return undefined;
  const options = challengeQop
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (options.includes("auth")) {
    return "auth";
  }
  throw new RwsError(`Unsupported Digest qop value: ${challengeQop}`, {
    status: 401,
    rwsCode: "UNSUPPORTED_DIGEST_QOP",
    rwsMessage: `Server requested unsupported qop=${challengeQop}`,
  });
}

/** RFC 7617 Basic credentials. Callers must only send this over https://. */
export function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

export function computeDigestAuthorization(input: DigestAuthorizationInput): {
  header: string;
  response: string;
  ncHex: string;
  cnonce: string;
  qop?: "auth";
} {
  const { username, password, method, uri, challenge } = input;
  const qop = selectQop(challenge.qop);
  const ncHex = Math.max(1, input.nc).toString(16).padStart(8, "0");
  const cnonce = input.cnonce ?? generateCnonce();

  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method.toUpperCase()}:${uri}`);

  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username=${quoteDigestValue(username)}`,
    `realm=${quoteDigestValue(challenge.realm)}`,
    `nonce=${quoteDigestValue(challenge.nonce)}`,
    `uri=${quoteDigestValue(uri)}`,
    `algorithm=MD5`,
    `response=${quoteDigestValue(response)}`,
  ];

  if (challenge.opaque !== undefined) {
    parts.push(`opaque=${quoteDigestValue(challenge.opaque)}`);
  }
  if (qop) {
    parts.push(`qop=${qop}`);
    parts.push(`nc=${ncHex}`);
    parts.push(`cnonce=${quoteDigestValue(cnonce)}`);
  }

  return {
    header: `Digest ${parts.join(", ")}`,
    response,
    ncHex,
    cnonce,
    qop,
  };
}
