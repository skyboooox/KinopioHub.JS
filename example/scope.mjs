import { KinopioHub } from '../kinopio.mjs';

// Scope management example
console.log('=== KinopioHub Scope Management Example ===');

async function scopeExample() {
  try {
    const hub = new KinopioHub({
      servers: ["wss://demo.nats.io:8443"],
      debug: true
    });

    await hub.connected();
    console.log('✅ Connected to NATS server');

    console.log('Creating different scopes...');

    // Method 1: Using getScope
    const userScope = hub.getScope('users');
    const onlineUsersVar = userScope.getVariable('online');
    const userCountVar = userScope.getVariable('count');

    // Method 2: Using dynamic property access
    const chatMessages = hub.chat.messages;
    const chatUsers = hub.chat.users;

    // Method 3: Direct scope.variable access
    const systemHealth = hub.system.health;
    const systemLogs = hub.system.logs;

    console.log('✅ Scopes created');

    // Publish to different scopes
    console.log('Publishing data to different scopes...');

    await onlineUsersVar.pub(['Alice', 'Bob', 'Charlie']);
    console.log('✅ Published online users');

    await userCountVar.pub({ total: 150, online: 3, registered_today: 5 });
    console.log('✅ Published user count');

    await chatMessages.pub({
      room: 'general',
      user: 'Alice',
      message: 'Hello everyone!',
      timestamp: Date.now()
    });
    console.log('✅ Published chat message');

    await systemHealth.pub({
      cpu_usage: 45.2,
      memory_usage: 68.1,
      disk_usage: 23.8,
      status: 'healthy',
      last_check: Date.now()
    });
    console.log('✅ Published system health');

    await systemLogs.pub({
      level: 'error',
      message: 'Failed to connect to database',
      service: 'user-service',
      timestamp: Date.now(),
      stack_trace: 'Error: Connection timeout...'
    });
    console.log('✅ Published system log');

    // Subscribe to different scopes
    console.log('Setting up subscriptions...');

    await onlineUsersVar.sub((users) => {
      console.log('👥 Online users updated:', users);
    });

    await chatMessages.sub((message) => {
      console.log('💬 Chat message:', `${message.user}: ${message.message}`);
    });

    await systemHealth.sub((health) => {
      console.log('🏥 System health:', health.status, `CPU: ${health.cpu_usage}%`);
    });

    console.log('✅ All subscriptions active');

    // Demonstrate scope organization
    console.log('\n📊 Scope Organization:');
    console.log('├── users/');
    console.log('│   ├── online');
    console.log('│   └── count');
    console.log('├── chat/');
    console.log('│   ├── messages');
    console.log('│   └── users');
    console.log('└── system/');
    console.log('    ├── health');
    console.log('    └── logs');

    // Keep running for a few seconds to see updates
    setTimeout(async () => {
      await hub.dispose();
      console.log('✅ Disconnected');
      process.exit(0);
    }, 5000);

  } catch (error) {
    console.error('❌ Scope example failed:', error.message);
    process.exit(1);
  }
}

scopeExample();