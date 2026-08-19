import { Controller, Get } from "@nestjs/common";

import { healthService } from "../runtime.ts";

@Controller("health")
export class HealthHttpController {
  @Get()
  health() {
    return healthService.getHealth();
  }

  @Get("collection")
  async collection() {
    const result = await healthService.getHealth();
    return result.collection;
  }
}
