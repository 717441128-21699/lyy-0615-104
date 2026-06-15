export enum StepStatus {
  PENDING = 'PENDING',
  EXECUTING = 'EXECUTING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  SUSPENDED = 'SUSPENDED',
  COMPENSATING = 'COMPENSATING',
  COMPENSATED = 'COMPENSATED',
  COMPENSATION_FAILED = 'COMPENSATION_FAILED',
  NEEDS_MANUAL_INTERVENTION = 'NEEDS_MANUAL_INTERVENTION',
}

export enum SagaStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILD',
  COMPENSATING = 'COMPENSATING',
  COMPENSATED = 'COMPENSATED',
  COMPENSATION_FAILED = 'COMPENSATION_FAILED',
  SUSPENDED = 'SUSPENDED',
}

export enum OperationResult {
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
  UNKNOWN = 'UNKNOWN',
}

export interface StepExecutionRecord {
  stepId: string;
  idempotencyKey: string;
  status: StepStatus;
  executedAt: number;
  result?: unknown;
  error?: string;
  compensationAttempts: number;
  lastCompensationAttempt?: number;
}

export interface SagaExecutionRecord {
  sagaId: string;
  status: SagaStatus;
  createdAt: number;
  completedAt?: number;
  failedAt?: number;
  steps: StepExecutionRecord[];
}

export interface IdempotencyStore {
  has(key: string): Promise<boolean>;
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ManualInterventionHandler {
  onCompensationFailed(
    sagaId: string,
    stepId: string,
    error: Error,
    context: SagaContext
  ): Promise<void>;
  onSuspended(
    sagaId: string,
    stepId: string,
    context: SagaContext
  ): Promise<void>;
}

export interface SagaContext {
  sagaId: string;
  data: Map<string, unknown>;
  executionRecord: SagaExecutionRecord;
  parentSagaId?: string;
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  clone(): SagaContext;
}

export interface SagaStepOptions {
  id: string;
  name: string;
  execute: (context: SagaContext) => Promise<unknown>;
  compensate: (context: SagaContext) => Promise<unknown>;
  checkStatus?: (context: SagaContext) => Promise<OperationResult>;
  maxCompensationRetries?: number;
  compensationRetryDelayMs?: number;
  compensationRetryBackoffMultiplier?: number;
  executionTimeoutMs?: number;
  statusCheckIntervalMs?: number;
  maxStatusChecks?: number;
}

export interface SagaOptions {
  id: string;
  name: string;
  steps: SagaStepOptions[];
  idempotencyStore: IdempotencyStore;
  manualInterventionHandler?: ManualInterventionHandler;
  parentSagaId?: string;
}
