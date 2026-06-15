import {
  SagaContext as ISagaContext,
  SagaExecutionRecord,
} from './types';

export class SagaContext implements ISagaContext {
  public readonly sagaId: string;
  public readonly data: Map<string, unknown>;
  public executionRecord: SagaExecutionRecord;
  public parentSagaId?: string;

  constructor(
    sagaId: string,
    executionRecord: SagaExecutionRecord,
    parentSagaId?: string
  ) {
    this.sagaId = sagaId;
    this.data = new Map<string, unknown>();
    this.executionRecord = executionRecord;
    this.parentSagaId = parentSagaId;
  }

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.data.set(key, value);
  }

  clone(): SagaContext {
    const clonedRecord: SagaExecutionRecord = JSON.parse(
      JSON.stringify(this.executionRecord)
    );
    const cloned = new SagaContext(this.sagaId, clonedRecord, this.parentSagaId);
    this.data.forEach((value, key) => {
      cloned.data.set(key, JSON.parse(JSON.stringify(value)));
    });
    return cloned;
  }
}
