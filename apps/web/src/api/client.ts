import { useCallback, useEffect, useState } from "react";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ApiRequestOptions extends RequestInit {
  role?: "ADMIN" | "OPERATOR";
  actorId?: string;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("x-role", options.role ?? "OPERATOR");
  const actorId = options.actorId ?? "local-operator";
  headers.set("x-actor-id", `uri:${encodeURIComponent(actorId)}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const body: unknown = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message = typeof body === "object" && body !== null
      ? String((body as { message?: unknown; error?: unknown }).message ?? (body as { error?: unknown }).error ?? `请求失败 (${response.status})`)
      : String(body || `请求失败 (${response.status})`);
    throw new ApiError(response.status, message);
  }
  return body as T;
}

export function useApiData<T>(path: string, initialValue: T) {
  const [data, setData] = useState<T>(initialValue);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiRequest<T>(path));
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "无法连接后台接口");
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, loading, error, refresh, setData };
}
