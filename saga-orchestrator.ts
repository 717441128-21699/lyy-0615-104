import {
  SagaOptions,
  SagaContext,
  SagaStatus,
  StepStatus,
  SagaExecutionRecord,
  StepExecutionRecord,
  IdempotencyStore,
  SagaStepOptions,
  ManualInterventionHandler,
} from './types';
import { SagaStep } from './saga-step';
import { SagaContext as SagaContextImpl } from './saga-context';

export class SagaOrchestrator {
  public readonly id: string;
  public readonly name: string;
  private readonly steps: SagaStep[];
  private readonly idempotencyStore: IdempotencyStore;
  private readonly manualInterventionHandler?: ManualInterventionHandler;
  private readonly parentSagaId?: string;
  private context: SagaContext;

  constructor(options: SagaOptions) {
    this.id = options.id;
    this.name = options.name;
    this.idempotencyStore = options.idempotencyStore;
    this.manualInterventionHandler = options.manualInterventionHandler;
    this.parentSagaId = options.parentSagaId;

    const executionRecord = this.createExecutionRecord(options.steps);

    this.context = new SagaContextImpl(
      this.id,
      executionRecord,
      this.parentSagaId
    );

    this.steps = options.steps.map(
      (stepOptions) =>
        new SagaStep(
          stepOptions,
          this.idempotencyStore,
          this.manualInterventionHandler
        )
    );
  }

  private createExecutionRecord(
    stepOptions: SagaStepOptions[]
  ): SagaExecutionRecord {
    const steps: StepExecutionRecord[] = stepOptions.map((opt) => ({
      stepId: opt.id,
      idempotencyKey: '',
      status: StepStatus.PENDING,
      executedAt: 0,
      compensationAttempts: 0,
    }));

    return {
      sagaId: this.id,
      status: SagaStatus.RUNNING,
      createdAt: Date.now(),
      steps,
    };
  }

  async execute(): Promise<SagaStatus> {
    this.context.executionRecord.status = SagaStatus.RUNNING;

    const completedStepIds: string[] = [];

    try {
      for (const step of this.steps) {
        const status = await step.execute(this.context);

        if (status === StepStatus.COMPLETED) {
          completedStepIds.push(step.id);
        } else if (status === StepStatus.FAILED) {
          await this.compensate(completedStepIds);
          return this.context.executionRecord.status;
        } else if (status === StepStatus.NEEDS_MANUAL_INTERVENTION) {
          this.context.executionRecord.status = SagaStatus.SUSPENDED;
          return SagaStatus.SUSPENDED;
        } else if (status === StepStatus.SUSPENDED) {
          this.context.executionRecord.status = SagaStatus.SUSPENDED;
          return SagaStatus.SUSPENDED;
        }
      }

      this.context.executionRecord.status = SagaStatus.COMPLETED;
      this.context.executionRecord.completedAt = Date.now();
      return SagaStatus.COMPLETED;
    } catch (error) {
      this.context.executionRecord.status = SagaStatus.FAILED;
      this.context.executionRecord.failedAt = Date.now();
      throw error;
    }
  }

  private async compensate(completedStepIds: string[]): Promise<void> {
    this.context.executionRecord.status = SagaStatus.COMPENSATING;

    const completedSteps = this.steps.filter((step) =>
      completedStepIds.includes(step.id)
    );

    const reversedSteps = [...completedSteps].reverse();

    let hasManualIntervention = false;

    for (const step of reversedSteps) {
      const status = await step.compensate(this.context);

      if (status === StepStatus.NEEDS_MANUAL_INTERVENTION) {
        hasManualIntervention = true;
      }
    }

    if (hasManualIntervention) {
      this.context.executionRecord.status = SagaStatus.COMPENSATION_FAILED;
    } else {
      this.context.executionRecord.status = SagaStatus.COMPENSATED;
    }
  }

  async resume(): Promise<SagaStatus> {
    const record = this.context.executionRecord;

    if (
      record.status !== SagaStatus.SUSPENDED &&
      record.status !== SagaStatus.COMPENSATION_FAILED
    ) {
      return record.status;
    }

    const suspendedStep = record.steps.find(
      (s) =>
        s.status === StepStatus.SUSPENDED ||
        s.status === StepStatus.NEEDS_MANUAL_INTERVENTION
    );

    if (!suspendedStep) {
      return this.continueFromLastCompletedStep();
    }

    const stepIndex = this.steps.findIndex(
      (s) => s.id === suspendedStep.stepId
    );
    const step = this.steps[stepIndex];

    if (suspendedStep.status === StepStatus.SUSPENDED) {
      const status = await step.execute(this.context);

      if (status === StepStatus.COMPLETED) {
        return this.continueFromStep(stepIndex + 1);
      } else if (
        status === StepStatus.FAILED ||
        status === StepStatus.NEEDS_MANUAL_INTERVENTION
      ) {
        const completedBefore = record.steps
          .slice(0, stepIndex)
          .filter((s) => s.status === StepStatus.COMPLETED)
          .map((s) => s.stepId);

        await this.compensate(completedBefore);

        if (status === StepStatus.NEEDS_MANUAL_INTERVENTION) {
          record.status = SagaStatus.SUSPENDED;
        } else {
          record.status = SagaStatus.COMPENSATED;
        }

        return record.status;
      }
    } else if (suspendedStep.status === StepStatus.NEEDS_MANUAL_INTERVENTION) {
      const executeKey = `saga:${record.sagaId}:step:${suspendedStep.stepId}:execute`;
      const hasCompleted = await this.idempotencyStore.has(executeKey);

      if (hasCompleted) {
        const executeStatus = await step.execute(this.context);

        if (executeStatus === StepStatus.COMPLETED) {
          return this.continueFromStep(stepIndex + 1);
        } else if (
          executeStatus === StepStatus.FAILED ||
          executeStatus === StepStatus.NEEDS_MANUAL_INTERVENTION
        ) {
          const completedBefore = record.steps
            .slice(0, stepIndex)
            .filter((s) => s.status === StepStatus.COMPLETED)
            .map((s) => s.stepId);

          await this.compensate(completedBefore);
          return record.status;
        }
      }

      const compensateStatus = await step.compensate(this.context);

      if (compensateStatus === StepStatus.COMPENSATED) {
        const earlierCompleted = record.steps
          .slice(0, stepIndex)
          .filter(
            (s) =>
              s.status === StepStatus.COMPLETED ||
              s.status === StepStatus.COMPENSATED
          )
          .map((s) => s.stepId);

        await this.compensate(earlierCompleted);
        record.status = SagaStatus.COMPENSATED;
        return SagaStatus.COMPENSATED;
      } else {
        record.status = SagaStatus.COMPENSATION_FAILED;
        return SagaStatus.COMPENSATION_FAILED;
      }
    }

    return record.status;
  }

  private async continueFromStep(startIndex: number): Promise<SagaStatus> {
    const completedStepIds = this.context.executionRecord.steps
      .slice(0, startIndex)
      .filter((s) => s.status === StepStatus.COMPLETED)
      .map((s) => s.stepId);

    for (let i = startIndex; i < this.steps.length; i++) {
      const step = this.steps[i];
      const status = await step.execute(this.context);

      if (status === StepStatus.COMPLETED) {
        completedStepIds.push(step.id);
      } else if (
        status === StepStatus.FAILED ||
        status === StepStatus.NEEDS_MANUAL_INTERVENTION
      ) {
        await this.compensate(completedStepIds);

        if (status === StepStatus.NEEDS_MANUAL_INTERVENTION) {
          this.context.executionRecord.status = SagaStatus.SUSPENDED;
        } else {
          this.context.executionRecord.status = SagaStatus.COMPENSATED;
        }

        return this.context.executionRecord.status;
      }
    }

    this.context.executionRecord.status = SagaStatus.COMPLETED;
    this.context.executionRecord.completedAt = Date.now();
    return SagaStatus.COMPLETED;
  }

  private async continueFromLastCompletedStep(): Promise<SagaStatus> {
    const lastCompletedIndex = this.context.executionRecord.steps.reduce(
      (lastIndex, step, index) => {
        if (step.status === StepStatus.COMPLETED) {
          return index;
        }
        return lastIndex;
      },
      -1
    );

    return this.continueFromStep(lastCompletedIndex + 1);
  }

  getContext(): SagaContext {
    return this.context;
  }

  getExecutionRecord(): SagaExecutionRecord {
    return JSON.parse(JSON.stringify(this.context.executionRecord));
  }

  getStatus(): SagaStatus {
    return this.context.executionRecord.status;
  }

  async markStepCompleted(stepId: string): Promise<SagaStatus> {
    const stepIndex = this.steps.findIndex((s) => s.id === stepId);
    if (stepIndex === -1) {
      throw new Error(`Step ${stepId} not found`);
    }

    const record = this.context.executionRecord.steps[stepIndex];
    if (record.status !== StepStatus.SUSPENDED &&
        record.status !== StepStatus.NEEDS_MANUAL_INTERVENTION &&
        record.status !== StepStatus.EXECUTING) {
      return this.context.executionRecord.status;
    }

    const executeKey = `saga:${this.id}:step:${stepId}:execute`;
    await this.idempotencyStore.set(executeKey, 'manually-confirmed');

    record.status = StepStatus.COMPLETED;
    record.result = 'manually-confirmed';

    return this.continueFromStep(stepIndex + 1);
  }

  async markStepFailed(stepId: string): Promise<SagaStatus> {
    const stepIndex = this.steps.findIndex((s) => s.id === stepId);
    if (stepIndex === -1) {
      throw new Error(`Step ${stepId} not found`);
    }

    const record = this.context.executionRecord.steps[stepIndex];
    if (record.status !== StepStatus.SUSPENDED &&
        record.status !== StepStatus.NEEDS_MANUAL_INTERVENTION &&
        record.status !== StepStatus.EXECUTING) {
      return this.context.executionRecord.status;
    }

    record.status = StepStatus.FAILED;
    record.error = 'Manually marked as failed';

    const completedBefore = this.context.executionRecord.steps
      .slice(0, stepIndex)
      .filter((s) => s.status === StepStatus.COMPLETED)
      .map((s) => s.stepId);

    await this.compensate(completedBefore);
    return this.context.executionRecord.status;
  }

  async retryStep(stepId: string): Promise<SagaStatus> {
    const stepIndex = this.steps.findIndex((s) => s.id === stepId);
    if (stepIndex === -1) {
      throw new Error(`Step ${stepId} not found`);
    }

    const record = this.context.executionRecord.steps[stepIndex];
    if (record.status !== StepStatus.SUSPENDED &&
        record.status !== StepStatus.NEEDS_MANUAL_INTERVENTION &&
        record.status !== StepStatus.COMPENSATION_FAILED) {
      return this.context.executionRecord.status;
    }

    const step = this.steps[stepIndex];

    if (record.status === StepStatus.COMPENSATION_FAILED) {
      const status = await step.compensate(this.context);
      if (status === StepStatus.COMPENSATED) {
        const earlierStepIds = this.context.executionRecord.steps
          .slice(0, stepIndex)
          .filter((s) => s.status === StepStatus.COMPLETED)
          .map((s) => s.stepId);

        if (earlierStepIds.length > 0) {
          await this.compensate(earlierStepIds);
        } else {
          this.context.executionRecord.status = SagaStatus.COMPENSATED;
        }
      } else {
        this.context.executionRecord.status = SagaStatus.COMPENSATION_FAILED;
      }
      return this.context.executionRecord.status;
    }

    const completedBefore = this.context.executionRecord.steps
      .slice(0, stepIndex)
      .filter((s) => s.status === StepStatus.COMPLETED)
      .map((s) => s.stepId);

    const status = await step.execute(this.context);

    if (status === StepStatus.COMPLETED) {
      return this.continueFromStep(stepIndex + 1);
    } else if (status === StepStatus.FAILED) {
      await this.compensate(completedBefore);
      return this.context.executionRecord.status;
    } else if (status === StepStatus.NEEDS_MANUAL_INTERVENTION) {
      this.context.executionRecord.status = SagaStatus.SUSPENDED;
      return SagaStatus.SUSPENDED;
    }

    return this.context.executionRecord.status;
  }

  async markCompensationCompleted(stepId: string): Promise<SagaStatus> {
    const stepIndex = this.steps.findIndex((s) => s.id === stepId);
    if (stepIndex === -1) {
      throw new Error(`Step ${stepId} not found`);
    }

    const record = this.context.executionRecord.steps[stepIndex];
    if (record.status !== StepStatus.COMPENSATION_FAILED &&
        record.status !== StepStatus.NEEDS_MANUAL_INTERVENTION &&
        record.status !== StepStatus.COMPENSATING) {
      return this.context.executionRecord.status;
    }

    const compensateKey = `saga:${this.id}:step:${stepId}:compensate`;
    await this.idempotencyStore.set(compensateKey, 'manually-confirmed');

    record.status = StepStatus.COMPENSATED;

    const earlierStepIds = this.context.executionRecord.steps
      .slice(0, stepIndex)
      .filter((s) => s.status === StepStatus.COMPLETED)
      .map((s) => s.stepId);

    if (earlierStepIds.length > 0) {
      await this.compensate(earlierStepIds);
    } else {
      this.context.executionRecord.status = SagaStatus.COMPENSATED;
    }

    return this.context.executionRecord.status;
  }
}
