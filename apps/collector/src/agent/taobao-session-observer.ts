import type { CollectorSessionObservation } from "@stau-price-monitor/contracts";

import { LoginRequiredError, PlatformChallengeError } from "../core/desktop-driver.ts";
import type { AxHelperClient } from "../drivers/macos/ax-helper-client.ts";
import {
  assertNoStopState,
  hasDesktopAccountLogin
} from "../drivers/macos/taobao-selectors.ts";

export class TaobaoSessionObserver {
  private readonly client: Pick<AxHelperClient, "diagnose" | "snapshot" | "close">;
  private readonly capturedAt: () => string;

  constructor(
    client: Pick<AxHelperClient, "diagnose" | "snapshot" | "close">,
    capturedAt: () => string = () => new Date().toISOString()
  ) {
    this.client = client;
    this.capturedAt = capturedAt;
  }

  async observe(): Promise<CollectorSessionObservation> {
    try {
      const diagnostic = await this.client.diagnose();
      if (!diagnostic.appInstalled || !diagnostic.appRunning || !diagnostic.trusted
        || !diagnostic.screenRecordingTrusted || !diagnostic.frontWindowAvailable
        || diagnostic.shortVersion !== "2.4.5" || diagnostic.build !== "15") {
        return { state: "UNAVAILABLE", observedAt: this.capturedAt() };
      }
      const root = await this.client.snapshot();
      try {
        assertNoStopState(root);
        return {
          state: hasDesktopAccountLogin(root) ? "LOGIN_REQUIRED" : "READY",
          observedAt: this.capturedAt()
        };
      } catch (error) {
        if (error instanceof LoginRequiredError) {
          return { state: "LOGIN_REQUIRED", observedAt: this.capturedAt() };
        }
        if (error instanceof PlatformChallengeError) {
          return { state: "CHALLENGE_REQUIRED", observedAt: this.capturedAt() };
        }
        return { state: "UNAVAILABLE", observedAt: this.capturedAt() };
      }
    } catch {
      return { state: "UNAVAILABLE", observedAt: this.capturedAt() };
    }
  }

  close(): void {
    this.client.close();
  }
}
