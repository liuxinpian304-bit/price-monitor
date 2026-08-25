export interface RuntimeLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createRuntimeLifecycle(input: {
  scheduler: { registerSchedules(): Promise<void> };
  reconciliation?: { start(): Promise<void>; close(): Promise<void> };
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
      await input.reconciliation?.start();
      started = true;
    },
    async close() {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      const closeStep = async (step: () => void | Promise<void>) => {
        try {
          await step();
        } catch (error) {
          errors.push(error);
        }
      };

      if (input.reconciliation) await closeStep(() => input.reconciliation!.close());
      await closeStep(() => input.worker.close());
      await closeStep(() => input.queue.close());
      await closeStep(() => {
        if (input.redis.status !== "end") input.redis.disconnect();
      });
      await closeStep(() => input.prisma.$disconnect());

      if (errors.length > 0) {
        throw new AggregateError(errors, "runtime resource cleanup failed");
      }
    }
  };
}
