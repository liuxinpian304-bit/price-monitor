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
const minimumAdminCredentialLength = 32;
const weakAdminCredentialMarkers = ["change-me", "changeme", "password", "replace-with", "example-token"];
const productionAdminCredentialPattern = /^[0-9a-f]{64}$/i;
const maximumRejectedPatternLength = 16;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function tokenMatches(candidate: string, expected: string): boolean {
  return timingSafeEqual(digest(candidate), digest(expected));
}

function tokenMeetsDevelopmentMinimum(token: string): boolean {
  const normalized = token.toLowerCase();
  return token.length >= minimumAdminCredentialLength
    && new Set(token).size >= 10
    && weakAdminCredentialMarkers.every((marker) => !normalized.includes(marker));
}

function hasShortRepeatedPattern(token: string): boolean {
  for (let period = 1; period <= maximumRejectedPatternLength; period += 1) {
    if (token.length <= period) break;
    if ([...token].every((character, index) => character === token[index % period])) {
      return true;
    }
  }
  return false;
}

function tokenMeetsProductionFormat(token: string): boolean {
  return productionAdminCredentialPattern.test(token) && !hasShortRepeatedPattern(token.toLowerCase());
}

export function normalizeNodeEnvironment(value: string | undefined): string {
  return value?.trim().toLowerCase() || "development";
}

export function adminPrincipalConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  nodeEnvironment = normalizeNodeEnvironment(environment.NODE_ENV)
): AdminPrincipalConfig {
  const configured = environment.ADMIN_API_TOKEN?.trim() || null;
  if (!configured && nodeEnvironment === "production") {
    throw new Error("ADMIN_API_TOKEN is required in production");
  }
  if (configured && nodeEnvironment === "production" && !tokenMeetsProductionFormat(configured)) {
    throw new Error("ADMIN_API_TOKEN must be exactly 64 hexadecimal characters without predictable patterns in production");
  }
  if (configured && nodeEnvironment !== "production" && !tokenMeetsDevelopmentMinimum(configured)) {
    throw new Error("ADMIN_API_TOKEN must contain at least 32 characters, 10 distinct characters, and no placeholder markers outside production");
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
