import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  getAdminSessionServerSnapshot,
  getAdminSessionSnapshot,
  getAdminSessionToken,
  requireAdminUnlock,
  subscribeAdminSessionStore
} from "../auth/admin-session.ts";

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

export interface UseApiDataResult<T> {
  data: T;
  loading: boolean;
  error: string | null;
  errorStatus: number | null;
  hasSuccessfulData: boolean;
  refresh: () => Promise<void>;
  setData: (data: Exclude<T, null>) => void;
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

export function useApiData<T>(path: string, initialValue: null, options?: UseApiDataOptions): UseApiDataResult<T | null>;
export function useApiData<T>(path: string, initialValue: T, options?: UseApiDataOptions): UseApiDataResult<T>;
export function useApiData<T>(
  path: string,
  initialValue: T | null,
  options: UseApiDataOptions = {}
): UseApiDataResult<T | null> {
  const role = options.role ?? "OPERATOR";
  const adminSession = useSyncExternalStore(
    subscribeAdminSessionStore,
    getAdminSessionSnapshot,
    getAdminSessionServerSnapshot
  );
  const [success, setSuccess] = useState<{ path: string; data: T } | null>(null);
  const [requestState, setRequestState] = useState<{
    path: string;
    loading: boolean;
    error: string | null;
    errorStatus: number | null;
  }>({ path, loading: true, error: null, errorStatus: null });
  const requestSequence = useRef(0);
  const lastRetriedUnlockRevision = useRef(adminSession.unlocked ? adminSession.revision : -1);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setRequestState({ path, loading: true, error: null, errorStatus: null });
    try {
      const data = await apiRequest<T>(path, { role });
      if (requestSequence.current !== sequence) return;
      setSuccess({ path, data });
      setRequestState({ path, loading: false, error: null, errorStatus: null });
    } catch (requestError) {
      if (requestSequence.current !== sequence) return;
      setRequestState({
        path,
        loading: false,
        error: requestError instanceof Error ? requestError.message : "无法连接后台接口",
        errorStatus: requestError instanceof ApiError ? requestError.status : 0
      });
    }
  }, [path, role]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (role !== "ADMIN" || !adminSession.unlocked) return;
    if (lastRetriedUnlockRevision.current === adminSession.revision) return;
    lastRetriedUnlockRevision.current = adminSession.revision;
    void refresh();
  }, [adminSession.revision, adminSession.unlocked, refresh, role]);

  const hasSuccessfulData = success?.path === path;
  const currentRequest = requestState.path === path
    ? requestState
    : { path, loading: true, error: null, errorStatus: null };
  const setData = useCallback((data: T) => setSuccess({ path, data }), [path]);

  return {
    data: hasSuccessfulData ? success.data : initialValue,
    loading: currentRequest.loading,
    error: currentRequest.error,
    errorStatus: currentRequest.errorStatus,
    hasSuccessfulData,
    refresh,
    setData
  };
}
