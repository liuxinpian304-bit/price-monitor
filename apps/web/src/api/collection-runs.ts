import { ApiError, apiRequest } from "./client.ts";
import type {
  CollectionRunReportDetail,
  CollectionRunReportFilters,
  CollectionRunReportList
} from "./types.ts";
import { getAdminSessionToken, requireAdminUnlock } from "../auth/admin-session.ts";

export interface CreateCollectionRunInput {
  monitoredModelId: string;
  searchLimit?: number;
}

export interface CollectionRunAccepted {
  runId: string;
  coalesced: boolean;
}

export function createCollectionRun(input: CreateCollectionRunInput): Promise<CollectionRunAccepted> {
  return apiRequest<CollectionRunAccepted>("/api/collection-runs", {
    method: "POST",
    role: "ADMIN",
    body: JSON.stringify(input)
  });
}

export function requeueCollectionRun(runId: string): Promise<{ runId: string }> {
  return apiRequest<{ runId: string }>(`/api/collection-runs/${encodeURIComponent(runId)}/requeue`, {
    method: "POST",
    role: "ADMIN"
  });
}

export function listCollectionRuns(): Promise<CollectionRunReportList> {
  return apiRequest<CollectionRunReportList>("/api/operations/collection-runs", { role: "ADMIN" });
}

export function getCollectionRun(
  runId: string,
  filters: CollectionRunReportFilters = {}
): Promise<CollectionRunReportDetail> {
  const query = new URLSearchParams();
  if (filters.source) query.set("source", filters.source);
  if (filters.match) query.set("match", filters.match);
  if (filters.price) query.set("price", filters.price);
  if (filters.confidence) query.set("confidence", filters.confidence);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return apiRequest<CollectionRunReportDetail>(
    `/api/operations/collection-runs/${encodeURIComponent(runId)}${suffix}`,
    { role: "ADMIN" }
  );
}

export async function fetchCollectionEvidence(runId: string, sha256: string): Promise<Blob> {
  const token = getAdminSessionToken();
  if (!token) {
    requireAdminUnlock();
    throw new ApiError(403, "请先解锁管理员操作后查看证据");
  }
  const response = await fetch(
    `/api/operations/collection-runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(sha256)}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) requireAdminUnlock();
    throw new ApiError(response.status, `证据读取失败 (${response.status})`);
  }
  if (!response.headers.get("content-type")?.startsWith("image/png")) {
    throw new ApiError(502, "证据响应不是 PNG 图像");
  }
  return response.blob();
}
