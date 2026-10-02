export const RESEARCH_HOST_ORIGINS = ["http://*/*", "https://*/*"] as const;

export interface HostPermissionsApi {
  contains(permissions: { origins: string[] }): Promise<boolean>;
  request(permissions: { origins: string[] }): Promise<boolean>;
}

/** Creates the smallest host patterns needed to fetch a set of result URLs. */
export function researchHostOrigins(urls: string[]): string[] {
  return [...new Set(urls.flatMap((rawUrl) => {
    try {
      const url = new URL(rawUrl);
      return url.protocol === "http:" || url.protocol === "https:" ? [`${url.protocol}//${url.hostname}/*`] : [];
    } catch { return []; }
  }))].sort();
}

/** Checks only the result sites needed by this run, so existing site grants are respected. */
export async function hasResearchHostPermission(
  api: Pick<HostPermissionsApi, "contains">,
  origins: string[] = [...RESEARCH_HOST_ORIGINS]
): Promise<boolean> {
  if (!origins.length) return false;
  const permission = { origins: [...origins] };
  return api.contains(permission);
}

/** Must be called directly by a user-gesture handler; do not await before calling. */
export function requestResearchHostPermission(
  api: Pick<HostPermissionsApi, "request">,
  origins: string[] = [...RESEARCH_HOST_ORIGINS]
): Promise<boolean> {
  return api.request({ origins: [...origins] });
}
