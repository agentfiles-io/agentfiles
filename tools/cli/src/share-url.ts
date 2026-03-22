function sanitizePublicBaseUrl(value: string, envName: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${envName} must use http:// or https://.`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${envName} must not include a path, query, or hash.`);
  }
  return parsed.origin;
}

export function resolveShareBaseUrl(
  apiUrl: string,
  env = process.env,
): string {
  if (env["PUBLIC_APP_URL"]?.trim()) {
    return sanitizePublicBaseUrl(env["PUBLIC_APP_URL"], "PUBLIC_APP_URL");
  }

  if (env["PUBLIC_BASE_URL"]?.trim()) {
    return sanitizePublicBaseUrl(env["PUBLIC_BASE_URL"], "PUBLIC_BASE_URL");
  }

  return new URL(apiUrl).origin;
}

export function buildArtifactShareUrl(
  apiUrl: string,
  artifactId: string,
  env = process.env,
): string {
  return new URL(`/a/${artifactId}`, resolveShareBaseUrl(apiUrl, env)).toString();
}
