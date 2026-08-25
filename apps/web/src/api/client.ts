import { useCallback, useEffect, useState } from "react";

import { getAdminSessionToken, requireAdminUnlock } from "../auth/admin-session.ts";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ApiRequestOptions extends RequestInit {
  role?: "ADMIN" | "OPERATOR";
}

export interface UseApiDataOptions {
  role?: "ADMIN" | "OPERATOR";
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { role = "OPERATOR", ...requestOptions } = options;
  const headers = new Headers(options.headers);
  headers.delete("authorization");
  headers.delete("x-role");
  headers.delete("x-actor-id");
  const adminToken = role === "ADMIN" ? getAdminSessionToken() : null;
  if (adminToken) headers.set("authorization", `Bearer ${adminToken}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, { ...requestOptions, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const body: unknown = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    if (role === "ADMIN" && (response.status === 401 || response.status === 403)) {
      requireAdminUnlock();
    }
    const message = typeof body === "object" && body !== null
      ? String((body as { message?: unknown; error?: unknown }).message ?? (body as { error?: unknown }).error ?? `请求失败 (${response.status})`)
      : String(body || `请求失败 (${response.status})`);
    throw new ApiError(response.status, message);
  }
  return body as T;
}

export function useApiData<T>(path: string, initialValue: T, options: UseApiDataOptions = {}) {
  const [data, setData] = useState<T>(initialValue);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const role = options.role ?? "OPERATOR";

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiRequest<T>(path, { role }));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法连接后台接口");
    } finally {
      setLoading(false);
    }
  }, [path, role]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, error, refresh, setData };
}
