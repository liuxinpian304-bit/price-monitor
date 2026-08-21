export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface AuditEntryInput {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before: JsonValue;
  after: JsonValue;
}

export interface AuditRepository {
  create(entry: AuditEntryInput): Promise<void>;
}

export class AuditService {
  private readonly repository: AuditRepository;

  constructor(repository: AuditRepository) {
    this.repository = repository;
  }

  async record(entry: AuditEntryInput): Promise<void> {
    if (entry.actorId.trim() === "") {
      throw new TypeError("actorId is required");
    }

    await this.repository.create(entry);
  }
}
