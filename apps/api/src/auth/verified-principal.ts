import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

import type { UserRole } from "../settings/settings.service.ts";

export interface VerifiedPrincipal {
  actorId: string;
  role: UserRole;
}

export interface AdminPrincipalConfig {
  adminToken: string | null;
  adminActorId: string;
}

const VERIFIED_PRINCIPAL = Symbol("verified-api-principal");
const MINIMUM_ADMIN_TOKEN_LENGTH = 32;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function tokenMatches(candidate: string, expected: string): boolean {
  return timingSafeEqual(digest(candidate), digest(expected));
}

export function adminPrincipalConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): AdminPrincipalConfig {
  const configured = environment.ADMIN_API_TOKEN?.trim() || null;
  if (configured && configured.length < MINIMUM_ADMIN_TOKEN_LENGTH) {
    throw new Error("ADMIN_API_TOKEN must contain at least 32 characters");
  }
  return {
    adminToken: configured,
    adminActorId: environment.ADMIN_API_ACTOR_ID?.trim() || "local-admin"
  };
}

export function setVerifiedPrincipal(request: object, principal: VerifiedPrincipal): void {
  Reflect.set(request, VERIFIED_PRINCIPAL, Object.freeze({ ...principal }));
}

export function verifiedPrincipal(request: object): VerifiedPrincipal {
  const principal = Reflect.get(request, VERIFIED_PRINCIPAL) as VerifiedPrincipal | undefined;
  return principal ?? { actorId: "local-operator", role: "OPERATOR" };
}

export function createVerifiedPrincipalMiddleware(config: AdminPrincipalConfig) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    setVerifiedPrincipal(request, { actorId: "local-operator", role: "OPERATOR" });
    const authorization = request.headers.authorization;
    const value = Array.isArray(authorization) ? undefined : authorization;
    const candidate = /^Bearer ([^\s]+)$/i.exec(value ?? "")?.[1];
    if (candidate && config.adminToken && tokenMatches(candidate, config.adminToken)) {
      setVerifiedPrincipal(request, { actorId: config.adminActorId, role: "ADMIN" });
    }
    next();
  };
}
