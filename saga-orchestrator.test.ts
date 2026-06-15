import {
  SagaOrchestrator,
  InMemoryIdempotencyStore,
  InMemoryManualInterventionHandler,
  SagaStatus,
  StepStatus,
  OperationResult,
  NestedSagaStep,
} from './index';

describe('SagaOrchestrator', () => {
  let idempotencyStore: InMemoryIdempotencyStore;
  let manualHandler: InMemoryManualInterventionHandler;

  beforeEach(() => {
    idempotencyStore = new InMemoryIdempotencyStore();
    manualHandler = new InMemoryManualInterventionHandler();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    idempotencyStore.clear();
    manualHandler.clear();
    jest.restoreAllMocks();
  });

  describe('Basic Execution', () => {
    it('should execute all steps successfully', async () => {
      const executeOrder: string[] = [];
      const compensateOrder: string[] = [];

      const saga = new SagaOrchestrator({
        id: 'test-saga-1',
        name: 'Test Saga',
        idempotencyStore,
        manualInterventionHandler: manualHandler,
        steps: [
          {
            id: 'step-1',
            name: 'Step 1',
            execute: async (ctx) => {
              executeOrder.push('step-1');
              ctx.set('step1-data', 'value1');
              return 'result1';
            },
            compensate: async () => {
              compensateOrder.push('step-1');
            },
          },
          {
            id: 'step-2',
            name: 'Step 2',
            execute: async (ctx) => {
              executeOrder.push('step-2');
              expect(ctx.get('step1-data')).toBe('value1');
              return 'result2';
            },
            compensate: async () => {
              compensateOrder.push('step-2');
            },
          },
        ],
      });

      const status = await saga.execute();

      expect(status).toBe(SagaStatus.COMPLETED);
      expect(executeOrder).toEqual(['step-1', 'step-2']);
      expect(compensateOrder).toEqual([]);

      const record = saga.getExecutionRecord();
      expect(record.status).toBe(SagaStatus.COMPLETED);
      expect(record.steps[0].status).toBe(StepStatus.COMPLETED);
      expect(record.steps[1].status).toBe(StepStatus.COMPLETED);
    });

    it('should compensate in reverse order when a step fails', async () => {
      const executeOrder: string[] = [];
      const compensateOrder: string[] = [];

      const saga = new SagaOrchestrator({
        id: 'test-saga-2',
        name: 'Test Saga',
        idempotencyStore,
        manualInterventionHandler: manualHandler,
        steps: [
          {
            id: 'step-1',
            name: 'Step 1',
            execute: async () => {
              executeOrder.push('step-1');
            },
            compensate: async () => {
              compensateOrder.push('step-1');
            },
          },
          {
            id: 'step-2',
            name: 'Step 2',
            execute: async () => {
              executeOrder.push('step-2');
            },
            compensate: async () => {
              compensateOrder.push('step-2');
            },
          },
          {
            id: 'step-3',
            name: 'Step 3',
            execute: async () => {
              executeOrder.push('step-3');
              throw new Error('Step 3 failed');
            },
            compensate: async () => {
              compensateOrder.push('step-3');
            },
          },
        ],
      });

      const status = await saga.execute();

      expect(status).toBe(SagaStatus.COMPENSATED);
      expect(executeOrder).toEqual(['step-1', 'step-2', 'step-3']);
      expect(compensateOrder).toEqual(['step-2', 'step-1']);

      const record = saga.getExecutionRecord();
      expect(record.steps[0].status).toBe(StepStatus.COMPENSATED);
      expect(record.steps[1].status).toBe(StepStatus.COMPENSATED);
      expect(record.steps[2].status).toBe(StepStatus.FAILED);
    });
  });

  describe('Idempotency', () => {
    it('should not re-execute a step that has already been executed', async () => {
      let executeCount = 0;
      let compensateCount = 0;

      const saga = new SagaOrchestrator({
        id: 'test-saga-idem-1',
        name: 'Test Saga',
        idempotencyStore,
        manualInterventionHandler: manualHandler,
        steps: [
          {
            id: 'step-1',
            name: 'Step 1',
            execute: async () => {
              executeCount++;
              return `result-${executeCount}`;
            },
            compensate: async () => {
              compensateCount++;
            },
          },
        ],
      });

      await saga.execute();
      expect(executeCount).toBe(1);

      const saga2 = new SagaOrchestrator({
        id: 'test-saga-idem-1',
        name: 'Test Saga',
        idempotencyStore,
        manualInterventionHandler: manualHandler,
        steps: [
          {
            id: 'step-1',
            name: 'Step 1',
            execute: async () => {
              executeCount++;
              return `result-${executeCount}`;
            },
            compensate: async () => {
              compensateCount++;
            },
          },
        ],
      });

      await saga2.execute();
      expect(executeCount).toBe(1);
    });

    it('should not re-compensate a step that has already been compensated', async () => {
      let compensateCount = 0;

      const saga = new SagaOrchestrator({
        id: 'test-saga-idem-2',
        name: 'Test Saga',
        idempotencyStore,
        manualInterventionHandler: manualHandler,
        steps: [
          {
            id: 'step-1',
            name: 'Step 1',
            execute: async () => {},
            compensate: async () => {
              compensateCount++;
            },
          },
          {
            id: 'step-2',
            name: 'Step 2',
            execute: async () => {
              throw new Error('Fail');
            },
            compensate: async () => {},
          },
        ],
      });

      await saga.execute();
      expect(compensateCount).toBe(1);

      const saga2 = new SagaOrchestrator({
        id: 'test-saga-idem-2',
        name: 'Test Saga',
        idempotencyStore,
        manualInterventionHandler: manualHandler,
        steps: [
          {
            id: 'step-1',
            name: 'Step 1',
            execute: async () => {},
            compensate: async () => {
              compensateCount++;
            },
          },
          {
            id: 'step-2',
            name: 'Step 2',
            execute: async () => {
              throw new Error('Fail');
            },
            compensate: async () => {},
          },
        ],
      });

      await saga2.execute();
      expect(compensateCount).toBe(1);
    });
  });

  describe('Compensation Failure Handling', () => {
    it('should retry compensation with exponential backoff', async () => {
      let compensateAttempts = 0;
      const compensateDelays: number[] = [];
      let lastCompensateTime = 0;

      const saga = new SagaOrchestrator({
        id: 'test-saga-comp-1',
        name: 'Test Saga',
        idempotencyStore,
        manualInterventionHandler: manualHandler,
        steps: [
          {
            id: 'step-1',
            name: 'Step 1',
            execute: async () => {},
            compensate: async () => {
              compensateAttempts++;
              const now = Date.now();
              if (lastCompensateTime > 0) {
                compensateDelays.push(now - lastCompensateTime);
              }
              lastCompensateTime = now;
              throw new Error('Compensation failed');
            },
            maxCompensationRetries: 2,
            compensationRetryDelayMs: 10,
            compensationRetryBackoffMultiplier: 2,
          },
          {
            id: 'step-2',
            name: 'Step 2',
            execute: async () => {
              throw new Error('Step 2 failed');
            },
            compensate: async () => {},
          },
        ],
      });

      const status = await saga.execute();

      expect(status).toBe(SagaStatus.COMPENSATION_FAILED);
      expect(compensateAttempts).toBe(3);
      expect(compensateDelays.length).toBe(2);
      expect(compensateDelays[0]).toBeGreaterThanOrEqual(10);
      expect(compensateDelays[1]).toBeGreaterThanOrEqual(20);

      const record = saga.getExecutionRecord();
      expect(record.steps[0].status).toBe(
        StepStatus.NEEDS_MANUAL_INTERVENTION
      );
      expect(record.steps[0].compensationAttempts).toBe(3);

      const pendingTasks = manualHandler.getPendingTasks();
      expect(pendingTasks.length).toBe(1);
      expect(pendingTasks[0].type).toBe('compensation_failed');
    });

    it('should stop retrying after max retries and create manual task', async () => {
      const saga = new SagaOrchestrator({
        id: 'test-saga-comp-2',
        name: 'Test Saga',
        idempotencyStore,
        manualInterventionHandler: manualHandler,
        steps: [
          {
            id: 'step-1',
            name: 'Step 1',
            execute: async () => {},
            compensate: async () => {
              throw new Error('Always fails');
            },
            maxCompensationRetries: 1,
            compensationRetryDelayMs: 5,
          },
          {
            id: 'step-2',
            name: 'Step 2',
            execute: async () => {
              throw new Error('Step 2 failed');
            },
            compensate: async () => {},
          },
        ],
      });

      await saga.execute();

      const pendingTasks = manualHandler.getPendingTasks();
      expect(pendingTasks.length).toBe(1);
      expect(pendingTasks[0].stepId).toBe('step-1');
    });
  });

  describe('Suspended State Handling', () => {
    it('should detect timeout and check status', async () => {
      let statusCheckCount = 0;

      const saga = new SagaOrchestrator({
        id: 'test-saga-suspend-1',
        name: 'Test Saga',
        idempotencyStore,
        manualInterventionHandler: manualHandler,
        steps: [
          {
            id: 'step-1',
            name: 'Step 1',
            execute: async () => {
              await new Promise((resolve) => setTimeout(resolve, 100));
              return 'done';
            },
            compensate: async () => {},
            checkStatus: async () => {
              statusCheckCount++;
              return OperationResult.SUCCESS;
            },
            executionTimeoutMs: 10,
            statusCheckIntervalMs: 5,
            maxStatusChecks: 3,
          },
        ],
      });

      const status = await saga.execute();

      expect(status).toBe(SagaStatus.COMPLETED);
      expect(statusCheckCount).toBeGreaterThan(0);
    });

    it('should escalate to manual intervention when status remains unknown', async () => {
      let statusCheckCount = 0;

      const saga = new SagaOrchestrator({
        id: 'test-saga-suspend-2',
        name: 'Test Saga',
        idempotencyStore,
        manualInterventionHandler: manualHandler,
        steps: [
          {
            id: 'step-1',
            name: 'Step 1',
            execute: async () => {
              await new Promise((resolve) => setTimeout(resolve, 100));
            },
            compensate: async () => {},
            checkStatus: async () => {
              statusCheckCount++;
              return OperationResult.UNKNOWN;
            },
            executionTimeoutMs: 10,
            statusCheckIntervalMs: 5,
            maxStatusChecks: 3,
          },
        ],
      });

      const status = await saga.execute();

      expect(status).toBe(SagaStatus.SUSPENDED);
      expect(statusCheckCount).toBe(3);

      const record = saga.getExecutionRecord();
      expect(record.steps[0].status).toBe(
        StepStatus.NEEDS_MANUAL_INTERVENTION
      );

      const pendingTasks = manualHandler.getPendingTasks();
      expect(pendingTasks.length).toBe(1);
      expect(pendingTasks[0].type).toBe('suspended');
    });

    it('should treat as failure when status check returns failure', async () => {
      const saga = new SagaOrchestrator({
        id: 'test-saga-suspend-3',
        name: 'Test Saga',
        idempotencyStore,
        manualInterventionHandler: manualHandler,
        steps: [
          {
            id: 'step-1',
            name: 'Step 1',
            execute: async () => {
              await new Promise((resolve) => setTimeout(resolve, 100));
            },
            compensate: async () => {},
            checkStatus: async () => OperationResult.FAILURE,
            executionTimeoutMs: 10,
            statusCheckIntervalMs: 5,
            maxStatusChecks: 3,
          },
        ],
      });

      const status = await saga.execute();

      expect(status).toBe(SagaStatus.COMPENSATED);
      const record = saga.getExecutionRecord();
      expect(record.steps[0].status).toBe(StepStatus.FAILED);
    });
  });

  describe('Nested Saga', () => {
    it('should execute nested saga successfully', async () => {
      const executionOrder: string[] = [];

      const nestedStep = NestedSagaStep.create(
        {
          id: 'nested-saga',
          name: 'Nested Saga',
          nestedSagaFactory: () => ({
            id: 'nested-1',
            name: 'Nested Saga 1',
            steps: [
              {
                id: 'nested-step-1',
                name: 'Nested Step 1',
                execute: async () => {
                  executionOrder.push('nested-step-1');
                },
                compensate: async () => {
                  executionOrder.push('compensate-nested-step-1');
                },
              },
              {
                id: 'nested-step-2',
                name: 'Nested Step 2',
                execute: async () => {
                  executionOrder.push('nested-step-2');
                },
                compensate: async () => {
                  executionOrder.push('compensate-nested-step-2');
                },
              },
            ],
          }),
        },
        idempotencyStore,
        manualHandler
      );

      const saga = new SagaOrchestrator({
        id: 'parent-saga-1',
        name: 'Parent Saga',
        idempotencyStore,
        manualInterventionHandler: manualHandler,
        steps: [
          {
            id: 'parent-step-1',
            name: 'Parent Step 1',
            execute: async () => {
              executionOrder.push('parent-step-1');
            },
            compensate: async () => {
              executionOrder.push('compensate-parent-step-1');
            },
          },
          nestedStep,
          {
            id: 'parent-step-2',
            name: 'Parent Step 2',
            execute: async () => {
              executionOrder.push('parent-step-2');
            },
            compensate: async () => {
              executionOrder.push('compensate-parent-step-2');
            },
          },
        ],
      });

      const status = await saga.execute();

      expect(status).toBe(SagaStatus.COMPLETED);
      expect(executionOrder).toEqual([
        'parent-step-1',
        'nested-step-1',
        'nested-step-2',
        'parent-step-2',
      ]);
    });

    it('should compensate nested saga in reverse order when parent fails', async () => {
      const executionOrder: string[] = [];

      const nestedStep = NestedSagaStep.create(
        {
          id: 'nested-saga',
          name: 'Nested Saga',
          nestedSagaFactory: () => ({
            id: 'nested-2',
            name: 'Nested Saga 2',
            steps: [
              {
                id: 'nested-step-1',
                name: 'Nested Step 1',
                execute: async () => {
                  executionOrder.push('nested-step-1');
                },
                compensate: async () => {
                  executionOrder.push('compensate-nested-step-1');
                },
              },
              {
                id: 'nested-step-2',
                name: 'Nested Step 2',
                execute: async () => {
                  executionOrder.push('nested-step-2');
                },
                compensate: async () => {
                  executionOrder.push('compensate-nested-step-2');
                },
              },
            ],
          }),
        },
        idempotencyStore,
        manualHandler
      );

      const saga = new SagaOrchestrator({
        id: 'parent-saga-2',
        name: 'Parent Saga',
        idempotencyStore,
        manualInterventionHandler: manualHandler,
        steps: [
          {
            id: 'parent-step-1',
            name: 'Parent Step 1',
            execute: async () => {
              executionOrder.push('parent-step-1');
            },
            compensate: async () => {
              executionOrder.push('compensate-parent-step-1');
            },
          },
          nestedStep,
          {
            id: 'parent-step-2',
            name: 'Parent Step 2',
            execute: async () => {
              executionOrder.push('parent-step-2');
              throw new Error('Parent step 2 failed');
            },
            compensate: async () => {
              executionOrder.push('compensate-parent-step-2');
            },
          },
        ],
      });

      const status = await saga.execute();

      expect(status).toBe(SagaStatus.COMPENSATED);
      expect(executionOrder).toEqual([
        'parent-step-1',
        'nested-step-1',
        'nested-step-2',
        'parent-step-2',
        'compensate-nested-step-2',
        'compensate-nested-step-1',
        'compensate-parent-step-1',
      ]);
    });
  });

  describe('Resume Functionality', () => {
    it('should resume from suspended state', async () => {
      let executeAttempts = 0;

      const saga = new SagaOrchestrator({
        id: 'test-saga-resume-1',
        name: 'Test Saga',
        idempotencyStore,
        manualInterventionHandler: manualHandler,
        steps: [
          {
            id: 'step-1',
            name: 'Step 1',
            execute: async () => {
              executeAttempts++;
              if (executeAttempts === 1) {
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              return 'success';
            },
            compensate: async () => {},
            checkStatus: async () => {
              return OperationResult.UNKNOWN;
            },
            executionTimeoutMs: 10,
            statusCheckIntervalMs: 5,
            maxStatusChecks: 2,
          },
        ],
      });

      const initialStatus = await saga.execute();
      expect(initialStatus).toBe(SagaStatus.SUSPENDED);
      expect(executeAttempts).toBe(1);

      const key = `saga:test-saga-resume-1:step:step-1:execute`;
      await idempotencyStore.set(key, 'confirmed');

      const resumeStatus = await saga.resume();
      expect(resumeStatus).toBe(SagaStatus.COMPLETED);
    });
  });

  describe('Manual Intervention', () => {
    it('should create manual task when compensation fails repeatedly', async () => {
      const createdTasks: any[] = [];
      const handler = new InMemoryManualInterventionHandler((task) => {
        createdTasks.push(task);
      });

      const saga = new SagaOrchestrator({
        id: 'test-saga-manual-1',
        name: 'Test Saga',
        idempotencyStore,
        manualInterventionHandler: handler,
        steps: [
          {
            id: 'step-1',
            name: 'Step 1',
            execute: async () => {},
            compensate: async () => {
              throw new Error('Compensation failed');
            },
            maxCompensationRetries: 1,
            compensationRetryDelayMs: 5,
          },
          {
            id: 'step-2',
            name: 'Step 2',
            execute: async () => {
              throw new Error('Step 2 failed');
            },
            compensate: async () => {},
          },
        ],
      });

      await saga.execute();

      expect(createdTasks.length).toBe(1);
      expect(createdTasks[0].type).toBe('compensation_failed');
      expect(createdTasks[0].sagaId).toBe('test-saga-manual-1');
      expect(createdTasks[0].stepId).toBe('step-1');

      const resolved = handler.resolveTask(createdTasks[0].id, 'retry');
      expect(resolved?.resolution).toBe('retry');
      expect(resolved?.resolved).toBe(true);
    });
  });
});
