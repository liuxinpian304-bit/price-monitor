const adminCredentialStorageKey = "stau.admin-api-token";

export type AdminSessionEvent =
  | { type: "changed"; unlocked: boolean }
  | { type: "authorization-required" };

type AdminSessionListener = (event: AdminSessionEvent) => void;

export interface AdminSessionSnapshot {
  unlocked: boolean;
  revision: number;
}

const listeners = new Set<AdminSessionListener>();
let memoryToken: string | null | undefined;
let snapshot: AdminSessionSnapshot | undefined;
const serverSnapshot: AdminSessionSnapshot = { unlocked: false, revision: 0 };

function sessionStorageOrNull(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function emit(event: AdminSessionEvent): void {
  snapshot = {
    unlocked: event.type === "changed" ? event.unlocked : false,
    revision: (snapshot?.revision ?? 0) + 1
  };
  for (const listener of listeners) listener(event);
}

export function getAdminSessionToken(): string | null {
  if (memoryToken !== undefined) return memoryToken;
  memoryToken = sessionStorageOrNull()?.getItem(adminCredentialStorageKey) || null;
  return memoryToken;
}

export function isAdminSessionUnlocked(): boolean {
  return getAdminSessionToken() !== null;
}

export function unlockAdminSession(token: string): void {
  const normalized = token.trim();
  if (!normalized) throw new TypeError("管理员凭证不能为空");
  memoryToken = normalized;
  sessionStorageOrNull()?.setItem(adminCredentialStorageKey, normalized);
  emit({ type: "changed", unlocked: true });
}

export function lockAdminSession(): void {
  memoryToken = null;
  sessionStorageOrNull()?.removeItem(adminCredentialStorageKey);
  emit({ type: "changed", unlocked: false });
}

export function requireAdminUnlock(): void {
  memoryToken = null;
  sessionStorageOrNull()?.removeItem(adminCredentialStorageKey);
  emit({ type: "authorization-required" });
}

export function subscribeAdminSession(listener: AdminSessionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAdminSessionSnapshot(): AdminSessionSnapshot {
  snapshot ??= { unlocked: isAdminSessionUnlocked(), revision: 0 };
  return snapshot;
}

export function getAdminSessionServerSnapshot(): AdminSessionSnapshot {
  return serverSnapshot;
}

export function subscribeAdminSessionStore(listener: () => void): () => void {
  return subscribeAdminSession(() => listener());
}
