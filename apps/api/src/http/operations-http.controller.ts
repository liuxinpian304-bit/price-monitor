import { Body, Controller, Get, Param, Patch, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";

import {
  ManualCandidateNotFoundError,
  ManualClassificationValidationError,
  type ManualClassificationDecision
} from "../operations/manual-classification.service.ts";
import { manualClassificationService, operationsQuery } from "../runtime.ts";
import { requestIdentity } from "./identity.ts";

@Controller("operations")
export class OperationsHttpController {
  @Get("dashboard")
  dashboard() {
    return operationsQuery.getDashboard();
  }

  @Get("comparisons")
  comparisons(@Query("type") type?: string) {
    return operationsQuery.listComparisons(type === "BUNDLE" ? "BUNDLE" : "BARE");
  }

  @Get("manual-candidates")
  manualCandidates() {
    return operationsQuery.listManualCandidates();
  }

  @Patch("manual-candidates/:id")
  async classifyManualCandidate(
    @Param("id") id: string,
    @Body() body: { decision?: ManualClassificationDecision },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    try {
      return await manualClassificationService.classify(
        id,
        body.decision as ManualClassificationDecision,
        requestIdentity(request).actorId
      );
    } catch (error) {
      if (error instanceof ManualCandidateNotFoundError) {
        response.status(404);
        return { error: error.message };
      }
      if (error instanceof ManualClassificationValidationError) {
        response.status(400);
        return { error: error.message };
      }
      throw error;
    }
  }

  @Get("history")
  history(@Query("limit") limit?: string) {
    return operationsQuery.listHistory(Number(limit ?? 200));
  }
}
