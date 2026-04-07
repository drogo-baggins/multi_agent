import { isIP } from "node:net";

export interface OutboundUrlPolicy {
  allowedOrigins?: readonly string[];
}

function isAllowedOrigin(url: URL, policy?: OutboundUrlPolicy): boolean {
  return (policy?.allowedOrigins ?? []).includes(url.origin);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase();
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [first, second] = octets;
  if (first === 0 || first === 10 || first === 127) {
    return true;
  }
  if (first === 100 && second !== undefined && second >= 64 && second <= 127) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 172 && second !== undefined && second >= 16 && second <= 31) {
    return true;
  }
  return first === 192 && second === 168;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice("::ffff:".length));
  }
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  if (normalized === "metadata" || normalized === "metadata.google.internal") {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isPrivateIpv4(normalized);
  }
  if (ipVersion === 6) {
    return isPrivateIpv6(normalized);
  }

  return false;
}

export function assertSafeOutboundUrl(rawUrl: string, policy?: OutboundUrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked URL scheme: ${url.protocol || "unknown"}. Only http and https are allowed.`);
  }

  if (isAllowedOrigin(url, policy)) {
    return url;
  }

  if (isBlockedHost(url.hostname)) {
    throw new Error(
      `Blocked URL host: ${url.hostname}. Localhost, private, link-local, and metadata addresses are not allowed.`
    );
  }

  return url;
}