import { BadRequestException, Body, Controller, Get, Patch, Put, Req } from "@nestjs/common";
import type { Request } from "express";

import { Roles } from "../auth/roles.guard.ts";
import { settingsService } from "../runtime.ts";
import { RoleForbiddenError, SettingsValidationError } from "../settings/settings.service.ts";
import { requestIdentity } from "./identity.ts";

async function asSettingsMutation(operation: () => Promise<void>) {
  try {
    await operation();
    return { saved: true };
  } catch (error) {
    if (error instanceof SettingsValidationError || error instanceof TypeError) {
      throw new BadRequestException(error.message);
    }
    if (error instanceof RoleForbiddenError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}

@Controller("settings")
export class SettingsHttpController {
  @Get()
  getSettings(@Req() request: Request) {
    return settingsService.getPublicSettings(requestIdentity(request).role);
  }

  @Patch("schedule")
  @Roles("ADMIN")
  updateSchedule(
    @Body() body: { enabled: boolean; checkTimes: string[] },
    @Req() request: Request
  ) {
    const identity = requestIdentity(request);
    return asSettingsMutation(() => settingsService.updateSchedule(body, identity.actorId, identity.role));
  }

  @Patch("provider")
  @Roles("ADMIN")
  updateProvider(@Body() body: { provider: "manual" | "external" }, @Req() request: Request) {
    const identity = requestIdentity(request);
    if (body.provider !== "manual" && body.provider !== "external") {
      throw new BadRequestException("数据源类型无效");
    }
    return asSettingsMutation(() => settingsService.updateProvider(body.provider, identity.actorId, identity.role));
  }

  @Put("secrets/wecom")
  @Roles("ADMIN")
  updateWecom(@Body() body: { value: string }, @Req() request: Request) {
    const identity = requestIdentity(request);
    return asSettingsMutation(() => settingsService.updateSecret("WECOM_WEBHOOK", body.value, identity.actorId, identity.role));
  }

  @Put("secrets/commerce-api")
  @Roles("ADMIN")
  updateCommerceApi(@Body() body: { value: string }, @Req() request: Request) {
    const identity = requestIdentity(request);
    return asSettingsMutation(() => settingsService.updateSecret("COMMERCE_API_KEY", body.value, identity.actorId, identity.role));
  }
}
