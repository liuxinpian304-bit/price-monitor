import { SetMetadata } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { UserRole } from "../settings/settings.service.ts";

export const ROLES_METADATA_KEY = "allowed_roles";
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_METADATA_KEY, roles);

export function roleFromHeaders(value: string | string[] | undefined): UserRole {
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalized?.toLocaleUpperCase() === "ADMIN" ? "ADMIN" : "OPERATOR";
}

export function roleIsAllowed(role: UserRole, allowed: readonly UserRole[]): boolean {
  return allowed.length === 0 || allowed.includes(role);
}

export class RolesGuard implements CanActivate {
  private readonly reflector: Reflector;

  constructor(reflector: Reflector) {
    this.reflector = reflector;
  }

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<UserRole[]>(ROLES_METADATA_KEY, [
      context.getHandler(),
      context.getClass()
    ]) ?? [];
    if (allowed.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    return roleIsAllowed(roleFromHeaders(request.headers["x-role"]), allowed);
  }
}
