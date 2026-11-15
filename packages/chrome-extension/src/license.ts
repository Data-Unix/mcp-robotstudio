/**
 * MCP-ROBOTSTUDIO PRO licensing, decoupled from the UI.
 *
 * The UI only talks to a LicenseProvider. LocalLicenseProvider verifies an
 * offline ECDSA P-256 token (lab / development / classroom licences issued
 * with scripts/license-lab.mjs). A billing backend (ExtPay, Stripe Checkout +
 * webhook) plugs in by issuing the same token format, or by implementing
 * LicenseProvider; the panel does not change. No remote code is loaded.
 */
import { LICENSE_PUBLIC_KEY } from "./license-public-key.js";

export type Plan = "free" | "pro";

export interface LicenseStatus {
  plan: Plan;
  subject?: string;
  expiresAt?: string;
  reason?: string;
}

export interface LicenseProvider {
  getStatus(): Promise<LicenseStatus>;
  activate(token: string): Promise<LicenseStatus>;
  deactivate(): Promise<void>;
  /** URL where the user can buy the single PRO subscription, if configured. */
  checkoutUrl(): string | null;
}

/** Features behind the PRO wall, with the tab that shows the conversion message. */
export const PRO_FEATURES = {
  pcpTracker: "01",
  speedRatioMonitor: "01",
  jointLimitBars: "01",
  singularityIndicator: "01",
  poseConverter: "01",
  forensicCapture: "02",
  timeMachineDiff: "02",
  offlineValidator: "02",
  safeLoader: "02",
  oscilloscope: "03",
  storePathCertifier: "03",
  fleetDashboard: "03",
  remoteBackup: "03",
  reachProbe: "04",
  teachByShowing: "04",
  recipeEditor: "04",
  practiceWizard: "05",
  rspagAnonymizer: "05",
} as const;
export type ProFeature = keyof typeof PRO_FEATURES;

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

/** Verifies "<base64url(payload)>.<base64url(P1363 signature)>". */
export async function verifyLicenseToken(token: string, publicJwk: JsonWebKey, now = Date.now()): Promise<LicenseStatus> {
  const parts = token.trim().split(".");
  if (parts.length !== 2) return { plan: "free", reason: "formato de licencia invalido" };
  const [body, sig] = parts as [string, string];
  let ok: boolean;
  try {
    const key = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64urlToBytes(sig) as BufferSource, new TextEncoder().encode(body));
  } catch {
    ok = false;
  }
  if (!ok) return { plan: "free", reason: "firma de licencia no valida" };
  let payload: { aud?: string; plan?: string; sub?: string; exp?: number };
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))) as typeof payload;
  } catch {
    return { plan: "free", reason: "contenido de licencia ilegible" };
  }
  if (payload.aud !== "mcp-robotstudio-pro" || payload.plan !== "pro") return { plan: "free", reason: "licencia de otro producto" };
  if (typeof payload.exp === "number" && payload.exp * 1000 < now) {
    return { plan: "free", subject: payload.sub, reason: "licencia caducada", expiresAt: new Date(payload.exp * 1000).toISOString() };
  }
  return {
    plan: "pro",
    subject: payload.sub,
    ...(typeof payload.exp === "number" ? { expiresAt: new Date(payload.exp * 1000).toISOString() } : {}),
  };
}

const TOKEN_KEY = "proLicenseToken";

export class LocalLicenseProvider implements LicenseProvider {
  constructor(
    private readonly publicJwk: JsonWebKey = LICENSE_PUBLIC_KEY,
    private readonly checkout: string | null = null,
  ) {}

  async getStatus(): Promise<LicenseStatus> {
    const stored = await chrome.storage.local.get(TOKEN_KEY);
    const token = stored[TOKEN_KEY];
    if (typeof token !== "string" || !token) return { plan: "free" };
    return await verifyLicenseToken(token, this.publicJwk);
  }

  async activate(token: string): Promise<LicenseStatus> {
    const status = await verifyLicenseToken(token, this.publicJwk);
    if (status.plan === "pro") await chrome.storage.local.set({ [TOKEN_KEY]: token.trim() });
    return status;
  }

  async deactivate(): Promise<void> {
    await chrome.storage.local.remove(TOKEN_KEY);
  }

  checkoutUrl(): string | null {
    return this.checkout;
  }
}

export const licenseProvider: LicenseProvider = new LocalLicenseProvider();

export async function isPro(provider: LicenseProvider = licenseProvider): Promise<boolean> {
  return (await provider.getStatus()).plan === "pro";
}
