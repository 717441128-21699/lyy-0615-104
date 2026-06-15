import {
  SagaStepOptions,
  SagaContext,
  SagaStatus,
  OperationResult,
  IdempotencyStore,
  ManualInterventionHandler,
  SagaOptions,
} from './types';
import { SagaOrchestrator } from './saga-orchestrator';

export interface NestedSagaStepOptions
  extends Omit<SagaStepOptions, 'execute' | 'compensate' | 'checkStatus'> {
  nestedSagaFactory: (
    parentContext: SagaContext
  ) => Omit<SagaOptions, 'idempotencyStore' | 'parentSagaId'>;
}

export class NestedSagaStep {
  static create(
    options: NestedSagaStepOptions,
    idempotencyStore: IdempotencyStore,
    manualInterventionHandler?: ManualInterventionHandler
  ): SagaStepOptions {
    let nestedSaga: SagaOrchestrator | null = null;

    const getOrCreateSaga = (context: SagaContext): SagaOrchestrator => {
      if (!nestedSaga) {
        const sagaOptions = options.nestedSagaFactory(context);
        nestedSaga = new SagaOrchestrator({
          ...sagaOptions,
          idempotencyStore,
          parentSagaId: context.sagaId,
        });
      }
      return nestedSaga;
    };

    return {
      id: options.id,
      name: options.name,
      maxCompensationRetries: options.maxCompensationRetries,
      compensationRetryDelayMs: options.compensationRetryDelayMs,
      compensationRetryBackoffMultiplier:
        options.compensationRetryBackoffMultiplier,
      executionTimeoutMs: options.executionTimeoutMs,
      statusCheckIntervalMs: options.statusCheckIntervalMs,
      maxStatusChecks: options.maxStatusChecks,

      execute: async (context: SagaContext): Promise<unknown> => {
        const saga = getOrCreateSaga(context);
        const status = await saga.execute();

        if (
          status === SagaStatus.COMPLETED ||
          status === SagaStatus.SUSPENDED
        ) {
          context.set(`nested_saga_${options.id}`, saga.getExecutionRecord());
          return saga.getExecutionRecord();
        }

        const record = saga.getExecutionRecord();
        const failedStep = record.steps.find(
          (s) => s.error
        );
        throw new Error(
          `Nested saga failed: ${failedStep?.error || 'Unknown error'}`
        );
      },

      compensate: async (context: SagaContext): Promise<unknown> => {
        const saga = getOrCreateSaga(context);
        const currentStatus = saga.getStatus();

        if (
          currentStatus === SagaStatus.COMPLETED ||
          currentStatus === SagaStatus.SUSPENDED
        ) {
          const nestedRecord = saga.getExecutionRecord();
          const completedStepIds = nestedRecord.steps
            .filter((s) => s.status === 'COMPLETED')
            .map((s) => s.stepId);

          for (const stepId of completedStepIds.reverse()) {
            const stepIndex = (saga as unknown as { steps: Array<{ id: string; compensate: (ctx: SagaContext) => Promise<string> }> }).steps.findIndex(
              (s) => s.id === stepId
            );
            if (stepIndex >= 0) {
              const step = (saga as unknown as { steps: Array<{ compensate: (ctx: SagaContext) => Promise<string> }> }).steps[stepIndex];
              await step.compensate(saga.getContext());
            }
          }

          (saga.getContext().executionRecord as { status: SagaStatus }).status = SagaStatus.COMPENSATED;
        }

        return saga.getExecutionRecord();
      },

      checkStatus: async (context: SagaContext): Promise<OperationResult> => {
        const saga = getOrCreateSaga(context);
        const status = saga.getStatus();

        switch (status) {
          case SagaStatus.COMPLETED:
            return OperationResult.SUCCESS;
          case SagaStatus.FAILED:
          case SagaStatus.COMPENSATED:
          case SagaStatus.COMPENSATION_FAILED:
            return OperationResult.FAILURE;
          default:
            return OperationResult.UNKNOWN;
        }
      },
    };
  }
}
