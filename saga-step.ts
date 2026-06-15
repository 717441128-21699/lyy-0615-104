import {
  SagaStepOptions,
  SagaContext,
  StepStatus,
  OperationResult,
  IdempotencyStore,
  StepExecutionRecord,
  ManualInterventionHandler,
} from './types';

export class SagaStep {
  public readonly id: string;
  public readonly name: string;
  private readonly executeFn: (context: SagaContext) => Promise<unknown>;
  private readonly compensateFn: (context: SagaContext) => Promise<unknown>;
  private readonly checkStatusFn?: (
    context: SagaContext
  ) => Promise<OperationResult>;
  private readonly checkCompensationStatusFn?: (
    context: SagaContext
  ) => Promise<OperationResult>;
  private readonly maxCompensationRetries: number;
  private readonly compensationRetryDelayMs: number;
  private readonly compensationRetryBackoffMultiplier: number;
  private readonly executionTimeoutMs: number;
  private readonly statusCheckIntervalMs: number;
  private readonly maxStatusChecks: number;
  private readonly idempotencyStore: IdempotencyStore;
  private readonly manualInterventionHandler?: ManualInterventionHandler;

  constructor(
    options: SagaStepOptions,
    idempotencyStore: IdempotencyStore,
    manualInterventionHandler?: ManualInterventionHandler
  ) {
    this.id = options.id;
    this.name = options.name;
    this.executeFn = options.execute;
    this.compensateFn = options.compensate;
    this.checkStatusFn = options.checkStatus;
    this.checkCompensationStatusFn = options.checkCompensationStatus;
    this.maxCompensationRetries = options.maxCompensationRetries ?? 5;
    this.compensationRetryDelayMs = options.compensationRetryDelayMs ?? 1000;
    this.compensationRetryBackoffMultiplier =
      options.compensationRetryBackoffMultiplier ?? 2;
    this.executionTimeoutMs = options.executionTimeoutMs ?? 30000;
    this.statusCheckIntervalMs = options.statusCheckIntervalMs ?? 2000;
    this.maxStatusChecks = options.maxStatusChecks ?? 5;
    this.idempotencyStore = idempotencyStore;
    this.manualInterventionHandler = manualInterventionHandler;
  }

  private getIdempotencyKey(context: SagaContext, suffix: string): string {
    return `saga:${context.sagaId}:step:${this.id}:${suffix}`;
  }

  private updateStepRecord(
    context: SagaContext,
    updates: Partial<StepExecutionRecord>
  ): void {
    const record = context.executionRecord.steps.find(
      (s) => s.stepId === this.id
    );
    if (record) {
      Object.assign(record, updates);
    }
  }

  async execute(context: SagaContext): Promise<StepStatus> {
    const executeKey = this.getIdempotencyKey(context, 'execute');
    const record = context.executionRecord.steps.find(
      (s) => s.stepId === this.id
    );

    if (!record) {
      throw new Error(`Step ${this.id} not found in execution record`);
    }

    if (await this.idempotencyStore.has(executeKey)) {
      const cachedResult = await this.idempotencyStore.get(executeKey);
      this.updateStepRecord(context, {
        status: StepStatus.COMPLETED,
        result: cachedResult,
      });
      return StepStatus.COMPLETED;
    }

    this.updateStepRecord(context, { status: StepStatus.EXECUTING });

    try {
      const result = await this.withTimeout(
        this.executeFn(context),
        this.executionTimeoutMs
      );

      await this.idempotencyStore.set(executeKey, result);

      this.updateStepRecord(context, {
        status: StepStatus.COMPLETED,
        result,
        executedAt: Date.now(),
      });

      return StepStatus.COMPLETED;
    } catch (error) {
      if (this.isTimeoutError(error)) {
        return this.handleSuspendedState(context);
      }

      this.updateStepRecord(context, {
        status: StepStatus.FAILED,
        error: error instanceof Error ? error.message : String(error),
        executedAt: Date.now(),
      });

      return StepStatus.FAILED;
    }
  }

  private async handleSuspendedState(
    context: SagaContext
  ): Promise<StepStatus> {
    if (!this.checkStatusFn) {
      this.updateStepRecord(context, {
        status: StepStatus.NEEDS_MANUAL_INTERVENTION,
        error: 'Operation timed out with no status check available',
      });

      if (this.manualInterventionHandler) {
        await this.manualInterventionHandler.onSuspended(
          context.sagaId,
          this.id,
          context
        );
      }

      return StepStatus.NEEDS_MANUAL_INTERVENTION;
    }

    this.updateStepRecord(context, { status: StepStatus.SUSPENDED });

    let consecutiveUnknownCount = 0;

    for (let i = 0; i < this.maxStatusChecks; i++) {
      await this.delay(this.statusCheckIntervalMs);

      try {
        const status = await this.checkStatusFn(context);

        switch (status) {
          case OperationResult.SUCCESS: {
            const executeKey = this.getIdempotencyKey(context, 'execute');
            await this.idempotencyStore.set(executeKey, 'confirmed');
            this.updateStepRecord(context, {
              status: StepStatus.COMPLETED,
              result: 'confirmed',
            });
            return StepStatus.COMPLETED;
          }
          case OperationResult.FAILURE: {
            this.updateStepRecord(context, {
              status: StepStatus.FAILED,
              error: 'Status check confirmed failure',
            });
            return StepStatus.FAILED;
          }
          case OperationResult.UNKNOWN: {
            consecutiveUnknownCount++;
            continue;
          }
        }
      } catch (checkError) {
        consecutiveUnknownCount++;
        continue;
      }
    }

    this.updateStepRecord(context, {
      status: StepStatus.NEEDS_MANUAL_INTERVENTION,
      error: `Status check timed out after ${this.maxStatusChecks} consecutive unknown results`,
    });

    if (this.manualInterventionHandler) {
      await this.manualInterventionHandler.onSuspended(
        context.sagaId,
        this.id,
        context
      );
    }

    return StepStatus.NEEDS_MANUAL_INTERVENTION;
  }

  async compensate(context: SagaContext): Promise<StepStatus> {
    const compensateKey = this.getIdempotencyKey(context, 'compensate');
    const record = context.executionRecord.steps.find(
      (s) => s.stepId === this.id
    );

    if (!record) {
      throw new Error(`Step ${this.id} not found in execution record`);
    }

    if (await this.idempotencyStore.has(compensateKey)) {
      this.updateStepRecord(context, { status: StepStatus.COMPENSATED });
      return StepStatus.COMPENSATED;
    }

    this.updateStepRecord(context, { status: StepStatus.COMPENSATING });

    let lastError: Error | undefined;
    let actuallyCompensated = false;

    for (
      let attempt = 0;
      attempt <= this.maxCompensationRetries;
      attempt++
    ) {
      try {
        const result = await this.compensateFn(context);

        await this.idempotencyStore.set(compensateKey, result);

        this.updateStepRecord(context, {
          status: StepStatus.COMPENSATED,
          compensationAttempts: attempt + 1,
          lastCompensationAttempt: Date.now(),
        });

        return StepStatus.COMPENSATED;
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error));

        if (this.checkCompensationStatusFn) {
          try {
            const compensationStatus = await this.checkCompensationStatusFn(
              context
            );

            if (compensationStatus === OperationResult.SUCCESS) {
              actuallyCompensated = true;
              await this.idempotencyStore.set(
                compensateKey,
                'confirmed-by-status-check'
              );
              this.updateStepRecord(context, {
                status: StepStatus.COMPENSATED,
                compensationAttempts: attempt + 1,
                lastCompensationAttempt: Date.now(),
              });
              return StepStatus.COMPENSATED;
            }
          } catch (_checkError) {
            // 状态检查本身失败，继续重试逻辑
          }
        }

        this.updateStepRecord(context, {
          status: StepStatus.COMPENSATION_FAILED,
          error: lastError.message,
          compensationAttempts: attempt + 1,
          lastCompensationAttempt: Date.now(),
        });

        if (attempt < this.maxCompensationRetries) {
          const delayMs =
            this.compensationRetryDelayMs *
            Math.pow(this.compensationRetryBackoffMultiplier, attempt);
          await this.delay(delayMs);
        }
      }
    }

    this.updateStepRecord(context, {
      status: StepStatus.NEEDS_MANUAL_INTERVENTION,
      error: `Compensation failed after ${this.maxCompensationRetries + 1} attempts: ${lastError?.message}`,
    });

    if (this.manualInterventionHandler && lastError) {
      await this.manualInterventionHandler.onCompensationFailed(
        context.sagaId,
        this.id,
        lastError,
        context
      );
    }

    return StepStatus.NEEDS_MANUAL_INTERVENTION;
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  private isTimeoutError(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.message.includes('Operation timed out')
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
