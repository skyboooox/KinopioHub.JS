import { KinopioHub } from '../kinopio.mjs';

// Basic connection example
console.log('=== KinopioHub Connection Example ===');

async function connectionExample() {
  try {
    // Create a new hub instance
    const hub = new KinopioHub({
      servers: ["wss://demo.nats.io:8443"],
      debug: true
    });

    console.log('Connecting to NATS server...');
    
    // Wait for connection
    await hub.connected();
    console.log('✅ Connected successfully!');

    // Check connection status
    console.log('Connection state:', hub.state);
    console.log('Is connected:', hub.isConnected);

    // Keep connection alive for a few seconds
    setTimeout(async () => {
      console.log('Disconnecting...');
      await hub.dispose();
      console.log('✅ Disconnected gracefully');
      process.exit(0);
    }, 3000);

  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    process.exit(1);
  }
}

connectionExample();