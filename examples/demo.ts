import {
  SagaOrchestrator,
  InMemoryIdempotencyStore,
  InMemoryManualInterventionHandler,
  SagaStatus,
  OperationResult,
  NestedSagaStep,
  SagaContext,
} from '../index';

const idempotencyStore = new InMemoryIdempotencyStore();
const manualHandler = new InMemoryManualInterventionHandler();

interface OrderData {
  orderId: string;
  userId: string;
  amount: number;
  items: string[];
}

const createOrderStep = {
  id: 'create-order',
  name: 'Create Order',
  execute: async (ctx: SagaContext) => {
    const orderData = ctx.get<OrderData>('orderData')!;
    console.log(`[Step] Creating order ${orderData.orderId}...`);
    await new Promise((r) => setTimeout(r, 100));
    ctx.set('orderId', orderData.orderId);
    console.log(`[Step] Order ${orderData.orderId} created successfully`);
    return { orderId: orderData.orderId, status: 'CREATED' };
  },
  compensate: async (ctx: SagaContext) => {
    const orderId = ctx.get<string>('orderId')!;
    console.log(`[Compensate] Cancelling order ${orderId}...`);
    await new Promise((r) => setTimeout(r, 100));
    console.log(`[Compensate] Order ${orderId} cancelled`);
    return { orderId, status: 'CANCELLED' };
  },
};

const reserveInventoryStep = {
  id: 'reserve-inventory',
  name: 'Reserve Inventory',
  execute: async (ctx: SagaContext) => {
    const orderData = ctx.get<OrderData>('orderData')!;
    console.log(`[Step] Reserving inventory for order ${orderData.orderId}...`);
    await new Promise((r) => setTimeout(r, 100));
    ctx.set('inventoryReserved', true);
    console.log(`[Step] Inventory reserved for ${orderData.items.length} items`);
    return { reserved: true, items: orderData.items };
  },
  compensate: async (ctx: SagaContext) => {
    const orderData = ctx.get<OrderData>('orderData')!;
    console.log(`[Compensate] Releasing inventory for order ${orderData.orderId}...`);
    await new Promise((r) => setTimeout(r, 100));
    console.log(`[Compensate] Inventory released`);
    return { released: true };
  },
  checkStatus: async (ctx: SagaContext) => {
    const reserved = ctx.get<boolean>('inventoryReserved');
    if (reserved === true) return OperationResult.SUCCESS;
    if (reserved === false) return OperationResult.FAILURE;
    return OperationResult.UNKNOWN;
  },
  executionTimeoutMs: 5000,
  statusCheckIntervalMs: 1000,
  maxStatusChecks: 3,
};

const processPaymentStep = {
  id: 'process-payment',
  name: 'Process Payment',
  execute: async (ctx: SagaContext) => {
    const orderData = ctx.get<OrderData>('orderData')!;
    console.log(`[Step] Processing payment of $${orderData.amount} for order ${orderData.orderId}...`);
    await new Promise((r) => setTimeout(r, 100));
    ctx.set('paymentProcessed', true);
    console.log(`[Step] Payment processed successfully`);
    return { transactionId: 'pay_12345', amount: orderData.amount };
  },
  compensate: async (ctx: SagaContext) => {
    const orderData = ctx.get<OrderData>('orderData')!;
    console.log(`[Compensate] Refunding payment of $${orderData.amount}...`);
    await new Promise((r) => setTimeout(r, 100));
    console.log(`[Compensate] Payment refunded`);
    return { refunded: true, transactionId: 'ref_12345' };
  },
  maxCompensationRetries: 3,
  compensationRetryDelayMs: 1000,
  compensationRetryBackoffMultiplier: 2,
};

const sendNotificationStep = {
  id: 'send-notification',
  name: 'Send Notification',
  execute: async (ctx: SagaContext) => {
    const orderData = ctx.get<OrderData>('orderData')!;
    console.log(`[Step] Sending order confirmation to user ${orderData.userId}...`);
    await new Promise((r) => setTimeout(r, 100));
    console.log(`[Step] Notification sent`);
    return { sent: true, channel: 'email' };
  },
  compensate: async (ctx: SagaContext) => {
    const orderData = ctx.get<OrderData>('orderData')!;
    console.log(`[Compensate] Sending order cancellation notification to user ${orderData.userId}...`);
    await new Promise((r) => setTimeout(r, 100));
    console.log(`[Compensate] Cancellation notification sent`);
    return { sent: true, type: 'cancellation' };
  },
};

const createShippingLabelStep = {
  id: 'create-shipping-label',
  name: 'Create Shipping Label',
  execute: async (ctx: SagaContext) => {
    const orderData = ctx.get<OrderData>('orderData')!;
    console.log(`[Step] Creating shipping label for order ${orderData.orderId}...`);
    await new Promise((r) => setTimeout(r, 100));
    console.log(`[Step] Shipping label created: SHIP-001`);
    return { trackingNumber: 'SHIP-001', carrier: 'FastShip' };
  },
  compensate: async (ctx: SagaContext) => {
    console.log(`[Compensate] Voiding shipping label...`);
    await new Promise((r) => setTimeout(r, 100));
    console.log(`[Compensate] Shipping label voided`);
    return { voided: true };
  },
};

async function demoSuccessfulOrder() {
  console.log('\n=== Demo 1: Successful Order Processing ===\n');

  const saga = new SagaOrchestrator({
    id: `order-saga-${Date.now()}`,
    name: 'Order Processing Saga',
    idempotencyStore,
    manualInterventionHandler: manualHandler,
    steps: [
      createOrderStep,
      reserveInventoryStep,
      processPaymentStep,
      sendNotificationStep,
      createShippingLabelStep,
    ],
  });

  saga.getContext().set<OrderData>('orderData', {
    orderId: `ORD-${Date.now()}`,
    userId: 'user_123',
    amount: 99.99,
    items: ['Product A', 'Product B'],
  });

  const status = await saga.execute();
  console.log(`\nFinal Saga Status: ${status}`);
  console.log('Success:', status === SagaStatus.COMPLETED);
}

async function demoFailedOrderWithCompensation() {
  console.log('\n=== Demo 2: Failed Order with Compensation ===\n');

  const failingPaymentStep = {
    ...processPaymentStep,
    execute: async (ctx: SagaContext) => {
      const orderData = ctx.get<OrderData>('orderData')!;
      console.log(`[Step] Processing payment of $${orderData.amount}...`);
      await new Promise((r) => setTimeout(r, 100));
      throw new Error('Payment gateway declined: insufficient funds');
    },
  };

  const saga = new SagaOrchestrator({
    id: `order-saga-fail-${Date.now()}`,
    name: 'Order Processing Saga (Failure)',
    idempotencyStore,
    manualInterventionHandler: manualHandler,
    steps: [
      createOrderStep,
      reserveInventoryStep,
      failingPaymentStep,
      sendNotificationStep,
    ],
  });

  saga.getContext().set<OrderData>('orderData', {
    orderId: `ORD-${Date.now()}`,
    userId: 'user_456',
    amount: 5000.0,
    items: ['Expensive Item'],
  });

  const status = await saga.execute();
  console.log(`\nFinal Saga Status: ${status}`);
  console.log('Compensated:', status === SagaStatus.COMPENSATED);
}

async function demoNestedSaga() {
  console.log('\n=== Demo 3: Nested Saga (Fulfillment Process) ===\n');

  const fulfillmentSteps = NestedSagaStep.create(
    {
      id: 'fulfillment-saga',
      name: 'Fulfillment Process',
      nestedSagaFactory: () => ({
        id: `fulfillment-${Date.now()}`,
        name: 'Fulfillment Saga',
        steps: [
          {
            id: 'pick-items',
            name: 'Pick Items',
            execute: async () => {
              console.log('  [Nested] Picking items from warehouse...');
              await new Promise((r) => setTimeout(r, 100));
              console.log('  [Nested] Items picked');
            },
            compensate: async () => {
              console.log('  [Nested] Returning items to shelf...');
              await new Promise((r) => setTimeout(r, 100));
              console.log('  [Nested] Items returned');
            },
          },
          {
            id: 'pack-items',
            name: 'Pack Items',
            execute: async () => {
              console.log('  [Nested] Packing items...');
              await new Promise((r) => setTimeout(r, 100));
              console.log('  [Nested] Items packed');
            },
            compensate: async () => {
              console.log('  [Nested] Unpacking items...');
              await new Promise((r) => setTimeout(r, 100));
              console.log('  [Nested] Items unpacked');
            },
          },
          createShippingLabelStep,
        ],
      }),
    },
    idempotencyStore,
    manualHandler
  );

  const saga = new SagaOrchestrator({
    id: `nested-saga-demo-${Date.now()}`,
    name: 'Complete Order Process with Nested Fulfillment',
    idempotencyStore,
    manualInterventionHandler: manualHandler,
    steps: [
      createOrderStep,
      reserveInventoryStep,
      processPaymentStep,
      fulfillmentSteps,
      sendNotificationStep,
    ],
  });

  saga.getContext().set<OrderData>('orderData', {
    orderId: `ORD-${Date.now()}`,
    userId: 'user_789',
    amount: 199.99,
    items: ['Gift Box'],
  });

  const status = await saga.execute();
  console.log(`\nFinal Saga Status: ${status}`);
  console.log('Success:', status === SagaStatus.COMPLETED);
}

async function demoCompensationFailure() {
  console.log('\n=== Demo 4: Compensation Failure with Manual Intervention ===\n');

  const flakyCompensationStep = {
    ...reserveInventoryStep,
    compensate: async (ctx: SagaContext) => {
      console.log(`[Compensate] Trying to release inventory... (attempt will fail)`);
      await new Promise((r) => setTimeout(r, 100));
      throw new Error('Inventory system is down, cannot release reservation');
    },
    maxCompensationRetries: 2,
    compensationRetryDelayMs: 100,
  };

  const saga = new SagaOrchestrator({
    id: `comp-fail-demo-${Date.now()}`,
    name: 'Compensation Failure Demo',
    idempotencyStore,
    manualInterventionHandler: manualHandler,
    steps: [
      createOrderStep,
      flakyCompensationStep,
      {
        ...processPaymentStep,
        execute: async () => {
          throw new Error('Payment failed');
        },
      },
    ],
  });

  saga.getContext().set<OrderData>('orderData', {
    orderId: `ORD-${Date.now()}`,
    userId: 'user_999',
    amount: 299.99,
    items: ['Flaky Product'],
  });

  const status = await saga.execute();
  console.log(`\nFinal Saga Status: ${status}`);

  const pendingTasks = manualHandler.getPendingTasks();
  console.log(`Pending manual tasks: ${pendingTasks.length}`);
  if (pendingTasks.length > 0) {
    console.log(`Task type: ${pendingTasks[0].type}`);
    console.log(`Task error: ${pendingTasks[0].error}`);
  }
}

async function runDemos() {
  try {
    await demoSuccessfulOrder();
    await demoFailedOrderWithCompensation();
    await demoNestedSaga();
    await demoCompensationFailure();

    console.log('\n=== All demos completed ===\n');
  } catch (error) {
    console.error('Demo error:', error);
  }
}

if (require.main === module) {
  runDemos();
}
