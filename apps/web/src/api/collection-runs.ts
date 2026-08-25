import { apiRequest } from "./client.ts";

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
