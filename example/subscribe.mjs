import { KinopioHub } from '../kinopio.mjs';

// Subscribing to messages example
console.log('=== KinopioHub Subscription Example ===');

async function subscribeExample() {
  try {
    const hub = new KinopioHub({
      servers: ["wss://demo.nats.io:8443"],
      debug: true
    });

    await hub.connected();
    console.log('✅ Connected to NATS server');

    // Get a scope and variable
    const chatScope = hub.getScope('chat');
    const messagesVar = chatScope.getVariable('messages');

    console.log('Setting up subscription...');

    // Subscribe to messages
    await messagesVar.sub((data) => {
      console.log('📨 Received message:', {
        from: data.user,
        content: data.message,
        time: new Date(data.timestamp).toLocaleTimeString()
      });
      
      if (data.type === 'warning') {
        console.log('⚠️  Warning message detected!');
      }
    });

    console.log('✅ Subscription active. Waiting for messages...');
    console.log('💡 Run publish.mjs in another terminal to see messages');

    // Keep the subscription alive
    console.log('Press Ctrl+C to stop listening');

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await hub.dispose();
      console.log('✅ Disconnected');
      process.exit(0);
    });

  } catch (error) {
    console.error('❌ Subscription failed:', error.message);
    process.exit(1);
  }
}

subscribeExample();