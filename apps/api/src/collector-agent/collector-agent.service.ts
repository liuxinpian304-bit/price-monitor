import type { CollectorJob } from "../../../../packages/contracts/src/index.ts";

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
    input: { appVersion: string; capabilities: string[] }
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
    message: string
  ): Promise<boolean>;
  release(agentId: string, runId: string): Promise<boolean>;
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

export class CollectorAgentService {
  private readonly repository: CollectorAgentRepository;

  constructor(repository: CollectorAgentRepository) {
    this.repository = repository;
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
    input: { appVersion: string; capabilities: string[] }
  ): Promise<CollectorJob | null> {
    const agent = await this.authenticate(token);
    return this.repository.claimNext(agent.id, input);
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
    if (!await this.repository.pause(agent.id, runId, status, code, message)) {
      throw new CollectorAgentRunOwnershipError();
    }
  }

  async release(token: string, runId: string): Promise<void> {
    const agent = await this.authenticate(token);
    if (!await this.repository.release(agent.id, runId)) {
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
}
