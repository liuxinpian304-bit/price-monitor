export interface RuntimeLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createRuntimeLifecycle(input: {
  scheduler: { registerSchedules(): Promise<void> };
  worker: { close(): Promise<void> };
  queue: { close(): Promise<void> };
  redis: { disconnect(): void; status: string };
  prisma: { $disconnect(): Promise<void> };
}): RuntimeLifecycle {
  let started = false;
  let closed = false;
  return {
    async start() {
      if (started) return;
      await input.scheduler.registerSchedules();
      started = true;
    },
    async close() {
      if (closed) return;
      closed = true;
      await input.worker.close();
      await input.queue.close();
      if (input.redis.status !== "end") input.redis.disconnect();
      await input.prisma.$disconnect();
    }
  };
}
