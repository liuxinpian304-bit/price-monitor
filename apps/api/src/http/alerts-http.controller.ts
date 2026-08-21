import { Body, Controller, Get, NotFoundException, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";

import type { AlertActionInput } from "../alerts/alert-action.dto.ts";
import { alertController, operationsQuery } from "../runtime.ts";
import { requestIdentity } from "./identity.ts";

function respond(response: Response, result: { status: number; body: unknown }) {
  response.status(result.status);
  return result.body;
}

@Controller("alerts")
export class AlertsHttpController {
  @Get()
  async list(@Query("type") type?: string) {
    return operationsQuery.listAlerts(type === "BARE" || type === "BUNDLE" ? type : undefined);
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    const alert = await operationsQuery.getAlert(id);
    if (!alert) {
      throw new NotFoundException(`预警“${id}”不存在`);
    }
    return alert;
  }

  @Get(":id/actions")
  async actions(@Param("id") id: string, @Res({ passthrough: true }) response: Response) {
    return respond(response, await alertController.getActions(id));
  }

  @Post(":id/actions")
  async applyAction(
    @Param("id") id: string,
    @Body() body: AlertActionInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return respond(
      response,
      await alertController.postAction(id, body, requestIdentity(request).actorId)
    );
  }
}
