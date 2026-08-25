const adminCredentialStorageKey = "stau.admin-api-token";

export type AdminSessionEvent =
  | { type: "changed"; unlocked: boolean }
  | { type: "authorization-required" };

type AdminSessionListener = (event: AdminSessionEvent) => void;

const listeners = new Set<AdminSessionListener>();
let memoryToken: string | null | undefined;

function sessionStorageOrNull(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function emit(event: AdminSessionEvent): void {
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
