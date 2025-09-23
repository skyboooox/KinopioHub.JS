import { KinopioHub } from '../kinopio.mjs';

// Publishing messages example
console.log('=== KinopioHub Publishing Example ===');

async function publishExample() {
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

    console.log('Publishing messages...');

    // Publish simple message
    await messagesVar.pub({ 
      user: 'Alice', 
      message: 'Hello World!',
      timestamp: Date.now()
    });
    console.log('✅ Published message 1');

    // Publish another message
    await messagesVar.pub({ 
      user: 'Bob', 
      message: 'How are you?',
      timestamp: Date.now()
    });
    console.log('✅ Published message 2');

    // Publish with different data types
    await messagesVar.pub({ 
      user: 'System', 
      message: 'Server restart in 5 minutes',
      type: 'warning',
      priority: 'high',
      timestamp: Date.now()
    });
    console.log('✅ Published system message');

    console.log('All messages published successfully!');

    // Cleanup
    setTimeout(async () => {
      await hub.dispose();
      console.log('✅ Disconnected');
      process.exit(0);
    }, 2000);

  } catch (error) {
    console.error('❌ Publishing failed:', error.message);
    process.exit(1);
  }
}

publishExample();