import type { Request } from "express";

import { roleFromHeaders } from "../auth/roles.guard.ts";

const URI_ACTOR_PREFIX = "uri:";

export function decodeActorId(rawActor: string | undefined): string {
  const value = rawActor?.trim();
  if (!value) {
    return "local-operator";
  }
  if (!value.startsWith(URI_ACTOR_PREFIX)) {
    return value;
  }
  try {
    return decodeURIComponent(value.slice(URI_ACTOR_PREFIX.length)).trim() || "local-operator";
  } catch {
    return "local-operator";
  }
}

export function requestIdentity(request: Request) {
  const rawActor = request.headers["x-actor-id"];
  const actorId = decodeActorId(Array.isArray(rawActor) ? rawActor[0] : rawActor);
  return {
    actorId,
    role: roleFromHeaders(request.headers["x-role"])
  };
}
