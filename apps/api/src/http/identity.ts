import type { Request } from "express";

import { roleFromHeaders } from "../auth/roles.guard.ts";

export function requestIdentity(request: Request) {
  const rawActor = request.headers["x-actor-id"];
  const actorId = (Array.isArray(rawActor) ? rawActor[0] : rawActor)?.trim() || "local-operator";
  return {
    actorId,
    role: roleFromHeaders(request.headers["x-role"])
  };
}
