import { getCache } from "@/server/cache";

/**
 * Microsoft Graph client for OneDrive video streaming.
 *
 * Two auth modes are supported (pick one via env):
 *
 * 1. Personal OneDrive (consumer) — delegated refresh-token flow:
 *    MS_CLIENT_ID + MS_REFRESH_TOKEN (+ optional MS_CLIENT_SECRET)
 *    Items are resolved against /me/drive.
 *
 * 2. OneDrive for Business — app-only client-credentials flow:
 *    MS_TENANT_ID + MS_CLIENT_ID + MS_CLIENT_SECRET + ONEDRIVE_DRIVE_ID
 *    Items are resolved against /drives/{ONEDRIVE_DRIVE_ID}.
 *
 * Streaming strategy (why this is fast for 4K):
 * `@microsoft.graph.downloadUrl` is a pre-authenticated, short-lived URL served
 * by Microsoft's CDN with full HTTP Range support. We cache it (~45 min) and
 * 302-redirect the player to it, so video bytes flow OneDrive → viewer directly
 * and never pass through our serverless function.
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_CACHE_KEY = "msgraph:access-token";

export function isOneDriveConfigured(): boolean {
  return Boolean(
    process.env.MS_CLIENT_ID && (process.env.MS_REFRESH_TOKEN || process.env.MS_TENANT_ID),
  );
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function fetchAccessToken(): Promise<string> {
  const clientId = process.env.MS_CLIENT_ID;
  if (!clientId) throw new Error("MS_CLIENT_ID is not set");

  let tokenUrl: string;
  let body: URLSearchParams;

  if (process.env.MS_REFRESH_TOKEN) {
    // Personal OneDrive — delegated refresh-token flow.
    tokenUrl = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
    body = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: process.env.MS_REFRESH_TOKEN,
      // ReadWrite so the `npm run encode` pipeline can upload renditions.
      scope: "Files.ReadWrite.All offline_access",
    });
    if (process.env.MS_CLIENT_SECRET) body.set("client_secret", process.env.MS_CLIENT_SECRET);
  } else {
    // OneDrive for Business — app-only client-credentials flow.
    const tenant = process.env.MS_TENANT_ID;
    const secret = process.env.MS_CLIENT_SECRET;
    if (!tenant || !secret) {
      throw new Error("OneDrive business mode requires MS_TENANT_ID and MS_CLIENT_SECRET");
    }
    tokenUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
    body = new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default",
    });
  }

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Microsoft token request failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as TokenResponse;

  // Cache slightly under the real expiry so we never serve a stale token.
  const ttl = Math.max(60, (data.expires_in ?? 3600) - 300);
  await getCache().set(TOKEN_CACHE_KEY, data.access_token, ttl);
  return data.access_token;
}

export async function getAccessToken(): Promise<string> {
  const cachedToken = await getCache().get<string>(TOKEN_CACHE_KEY);
  if (cachedToken) return cachedToken;
  return fetchAccessToken();
}

/** Graph URL prefix of the configured drive (business drive or personal /me/drive). */
export function driveBase(): string {
  if (process.env.ONEDRIVE_DRIVE_ID) return `${GRAPH_BASE}/drives/${process.env.ONEDRIVE_DRIVE_ID}`;
  return `${GRAPH_BASE}/me/drive`;
}

export interface DriveItemDownload {
  id: string;
  size: number;
  downloadUrl: string;
}

/**
 * Resolve a drive item (by id or by path) to its pre-authenticated download URL.
 */
export async function getDownloadInfo(ref: {
  itemId?: string | null;
  path?: string | null;
}): Promise<DriveItemDownload> {
  const token = await getAccessToken();
  const select = "id,size,content.downloadUrl";

  let url: string;
  if (ref.itemId) {
    url = `${driveBase()}/items/${encodeURIComponent(ref.itemId)}?select=${select}`;
  } else if (ref.path) {
    const cleanPath = ref.path.replace(/^\/+/, "");
    const encodedPath = cleanPath.split("/").map(encodeURIComponent).join("/");
    url = `${driveBase()}/root:/${encodedPath}?select=${select}`;
  } else {
    throw new Error("Episode has no OneDrive itemId or path");
  }

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Graph item lookup failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const item = (await res.json()) as {
    id: string;
    size: number;
    "@microsoft.graph.downloadUrl"?: string;
  };
  const downloadUrl = item["@microsoft.graph.downloadUrl"];
  if (!downloadUrl) throw new Error("Drive item has no downloadUrl (is it a folder?)");
  return { id: item.id, size: item.size, downloadUrl };
}
