import { KinopioHub } from '../kinopio.mjs';

// Request-Reply pattern example
console.log('=== KinopioHub Request-Reply Example ===');

async function requestReplyExample() {
  try {
    const hub = new KinopioHub({
      servers: ["wss://demo.nats.io:8443"],
      debug: true
    });

    await hub.connected();
    console.log('✅ Connected to NATS server');

    // Get a scope and variable for the service
    const mathScope = hub.getScope('math');
    const calculatorVar = mathScope.getVariable('calculator');

    console.log('Setting up service handler...');

    // Set up service handler (server side)
    await calculatorVar.serve(async (request) => {
      console.log('🔧 Processing request:', request);
      
      const { operation, a, b } = request;
      let result;

      switch (operation) {
        case 'add':
          result = a + b;
          break;
        case 'subtract':
          result = a - b;
          break;
        case 'multiply':
          result = a * b;
          break;
        case 'divide':
          result = b !== 0 ? a / b : 'Error: Division by zero';
          break;
        default:
          throw new Error('Unknown operation: ' + operation);
      }

      return {
        result: result,
        operation: operation,
        inputs: { a, b },
        timestamp: Date.now()
      };
    });

    console.log('✅ Calculator service is running');

    // Wait a moment for service to be ready
    await new Promise(resolve => setTimeout(resolve, 1000));

    console.log('Making requests to the service...');

    // Make requests (client side)
    const addResult = await calculatorVar.req({
      operation: 'add',
      a: 10,
      b: 5
    });
    console.log('➕ Addition result:', addResult);

    const multiplyResult = await calculatorVar.req({
      operation: 'multiply',
      a: 7,
      b: 3
    });
    console.log('✖️  Multiplication result:', multiplyResult);

    const divideResult = await calculatorVar.req({
      operation: 'divide',
      a: 20,
      b: 4
    });
    console.log('➗ Division result:', divideResult);

    // Test error handling
    try {
      const errorResult = await calculatorVar.req({
        operation: 'invalid',
        a: 1,
        b: 2
      });
    } catch (error) {
      console.log('❌ Expected error:', error.message);
    }

    console.log('All requests completed!');

    // Cleanup
    setTimeout(async () => {
      await hub.dispose();
      console.log('✅ Disconnected');
      process.exit(0);
    }, 2000);

  } catch (error) {
    console.error('❌ Request-Reply failed:', error.message);
    process.exit(1);
  }
}

requestReplyExample();