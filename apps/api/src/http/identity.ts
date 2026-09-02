import type { Request } from "express";

import { verifiedPrincipal } from "../auth/verified-principal.ts";

export function requestIdentity(request: Request) {
  return verifiedPrincipal(request);
}
