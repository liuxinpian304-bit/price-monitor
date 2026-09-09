import type {
  CollectorClaimInput,
  CollectorJob,
  CollectorRunReleaseInput
} from "../../../../packages/contracts/src/index.ts";

import { createCollectorToken } from "./collector-token.ts";
export interface CollectorAgentRepository {
  createAgent(input: {
    name: string;
    platform: "MACOS" | "WINDOWS";
    tokenHash: string;
    actorId: string;
  }): Promise<{ id: string; name: string }>;
  authenticate(token: string): Promise<{ id: string; enabled: boolean } | null>;
  claimNext(
    agentId: string,
    input: CollectorClaimInput
  ): Promise<CollectorJob | null>;
  heartbeat(
    agentId: string,
    runId: string,
    input: { discoveredCount: number; skuCount: number }
  ): Promise<boolean>;
  pause(
    agentId: string,
    runId: string,
    status: "PAUSED_LOGIN" | "PAUSED_CHALLENGE",
    code: "LOGIN_REQUIRED" | "PLATFORM_CHALLENGE",
    message: string,
    observedAt: Date
  ): Promise<boolean>;
  release(agentId: string, runId: string, input: CollectorRunReleaseInput): Promise<boolean>;
  ownsRun(agentId: string, runId: string): Promise<boolean>;
}

export class CollectorAgentAuthenticationError extends Error {
  constructor() {
    super("Collector authentication failed");
    this.name = "CollectorAgentAuthenticationError";
  }
}

export class CollectorAgentRunOwnershipError extends Error {
  constructor() {
    super("Collector does not own this run");
    this.name = "CollectorAgentRunOwnershipError";
  }
}

export interface CollectorSessionIncidentNotificationTrigger {
  notifyPending(agentId: string): Promise<void>;
}

export class CollectorAgentService {
  private readonly repository: CollectorAgentRepository;
  private readonly sessionNotifier: CollectorSessionIncidentNotificationTrigger | null;
  private readonly now: () => Date;

  constructor(
    repository: CollectorAgentRepository,
    sessionNotifier: CollectorSessionIncidentNotificationTrigger | null = null,
    now: () => Date = () => new Date()
  ) {
    this.repository = repository;
    this.sessionNotifier = sessionNotifier;
    this.now = now;
  }

  async register(
    input: { name: string; platform: "MACOS" | "WINDOWS" },
    actorId: string
  ): Promise<{ id: string; name: string; token: string }> {
    const token = createCollectorToken();
    const agent = await this.repository.createAgent({
      ...input,
      tokenHash: token.hash,
      actorId
    });
    return { ...agent, token: token.plaintext };
  }

  async claimNext(
    token: string,
    input: CollectorClaimInput
  ): Promise<CollectorJob | null> {
    const agent = await this.authenticate(token);
    const job = await this.repository.claimNext(agent.id, input);
    if (input.session.state === "LOGIN_REQUIRED" || input.session.state === "CHALLENGE_REQUIRED") {
      await this.notifyBlockedSession(agent.id);
    }
    return job;
  }

  async heartbeat(
    token: string,
    runId: string,
    input: { discoveredCount: number; skuCount: number }
  ): Promise<void> {
    const agent = await this.authenticate(token);
    if (!await this.repository.heartbeat(agent.id, runId, input)) {
      throw new CollectorAgentRunOwnershipError();
    }
  }

  async pause(
    token: string,
    runId: string,
    code: "LOGIN_REQUIRED" | "PLATFORM_CHALLENGE",
    message: string
  ): Promise<void> {
    const agent = await this.authenticate(token);
    const status = code === "LOGIN_REQUIRED" ? "PAUSED_LOGIN" : "PAUSED_CHALLENGE";
    const observedAt = this.now();
    if (!await this.repository.pause(agent.id, runId, status, code, message, observedAt)) {
      throw new CollectorAgentRunOwnershipError();
    }
    await this.notifyBlockedSession(agent.id);
  }

  async release(
    token: string,
    runId: string,
    input: CollectorRunReleaseInput = { disposition: "REQUEUE" }
  ): Promise<void> {
    const agent = await this.authenticate(token);
    if (!await this.repository.release(agent.id, runId, input)) {
      throw new CollectorAgentRunOwnershipError();
    }
  }

  async assertRunOwnership(
    token: string,
    runId: string
  ): Promise<{ agentId: string; runId: string }> {
    const agent = await this.authenticate(token);
    if (!await this.repository.ownsRun(agent.id, runId)) {
      throw new CollectorAgentRunOwnershipError();
    }
    return { agentId: agent.id, runId };
  }

  async assertAuthenticated(token: string): Promise<void> {
    await this.authenticate(token);
  }

  private async authenticate(token: string): Promise<{ id: string; enabled: boolean }> {
    const agent = await this.repository.authenticate(token);
    if (!agent?.enabled) {
      throw new CollectorAgentAuthenticationError();
    }
    return agent;
  }

  private async notifyBlockedSession(agentId: string): Promise<void> {
    try {
      await this.sessionNotifier?.notifyPending(agentId);
    } catch {
      // The durable agent gate already stopped collection; notification is best effort.
    }
  }
}
