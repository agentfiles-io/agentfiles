function sanitizeConfiguredBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use http:// or https://");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("PUBLIC_BASE_URL must not include a path, query, or hash");
  }
  return parsed.origin;
}

export function getPublicBaseUrl(requestUrl: string): string {
  const configured = process.env["PUBLIC_BASE_URL"]?.trim();
  if (configured) {
    return sanitizeConfiguredBaseUrl(configured);
  }

  if (process.env["NODE_ENV"] === "production") {
    throw new Error("PUBLIC_BASE_URL must be configured in production");
  }

  return new URL(requestUrl).origin;
}

export function getPublicOrigin(requestUrl: string): string {
  return new URL(getPublicBaseUrl(requestUrl)).origin;
}
