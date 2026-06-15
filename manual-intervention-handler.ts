import {
  ManualInterventionHandler,
  SagaContext,
} from './types';

export interface ManualTask {
  id: string;
  sagaId: string;
  stepId: string;
  type: 'compensation_failed' | 'suspended';
  error?: string;
  createdAt: number;
  resolved: boolean;
  resolution?: 'compensate' | 'continue' | 'retry';
  resolvedAt?: number;
}

export class InMemoryManualInterventionHandler
  implements ManualInterventionHandler
{
  private readonly tasks: Map<string, ManualTask> = new Map();
  private readonly onTaskCreated?: (task: ManualTask) => void;

  constructor(onTaskCreated?: (task: ManualTask) => void) {
    this.onTaskCreated = onTaskCreated;
  }

  async onCompensationFailed(
    sagaId: string,
    stepId: string,
    error: Error,
    _context: SagaContext
  ): Promise<void> {
    const task: ManualTask = {
      id: `manual-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      sagaId,
      stepId,
      type: 'compensation_failed',
      error: error.message,
      createdAt: Date.now(),
      resolved: false,
    };

    this.tasks.set(task.id, task);

    console.error(
      `[MANUAL INTERVENTION NEEDED] Compensation failed for saga ${sagaId}, step ${stepId}: ${error.message}`
    );
    console.error(`  Task ID: ${task.id}`);
    console.error(
      `  Action required: Manually verify the system state and decide whether to retry compensation, force continue, or accept the inconsistency.`
    );

    if (this.onTaskCreated) {
      this.onTaskCreated(task);
    }
  }

  async onSuspended(
    sagaId: string,
    stepId: string,
    _context: SagaContext
  ): Promise<void> {
    const task: ManualTask = {
      id: `manual-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      sagaId,
      stepId,
      type: 'suspended',
      createdAt: Date.now(),
      resolved: false,
    };

    this.tasks.set(task.id, task);

    console.warn(
      `[MANUAL INTERVENTION NEEDED] Saga ${sagaId} suspended at step ${stepId} due to unknown operation status`
    );
    console.warn(`  Task ID: ${task.id}`);
    console.warn(
      `  Action required: Manually check if the operation actually succeeded or failed, then resume the saga with the correct decision.`
    );

    if (this.onTaskCreated) {
      this.onTaskCreated(task);
    }
  }

  getPendingTasks(): ManualTask[] {
    return Array.from(this.tasks.values()).filter((t) => !t.resolved);
  }

  getAllTasks(): ManualTask[] {
    return Array.from(this.tasks.values());
  }

  resolveTask(
    taskId: string,
    resolution: 'compensate' | 'continue' | 'retry'
  ): ManualTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    task.resolved = true;
    task.resolution = resolution;
    task.resolvedAt = Date.now();

    console.log(
      `[MANUAL TASK RESOLVED] Task ${taskId} resolved with: ${resolution}`
    );

    return task;
  }

  clear(): void {
    this.tasks.clear();
  }
}
