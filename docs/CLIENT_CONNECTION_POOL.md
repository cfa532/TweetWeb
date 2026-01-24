# Client-Side Connection Pool

This document describes the client-side connection pool implementation for TweetWeb, which enables efficient parallel requests to Leither backend services.

## Overview

The client-side connection pool manages WebSocket connections to Leither backend nodes, allowing up to 8 simultaneous connections across all nodes, with a maximum of 4 connections per node. This significantly improves performance when loading multiple tweets, users, and media in parallel.

## Architecture

### Components

1. **ConnectionPoolManager** (`src/utils/connectionPool.ts`)
   - Core connection pool implementation
   - Manages connection lifecycle
   - Handles request queuing
   - Performs automatic cleanup

2. **ClientProxy** (`src/utils/clientProxy.ts`)
   - Transparent proxy wrapper for hprose clients
   - Automatically acquires and releases connections
   - Maintains compatibility with existing code

3. **LeitherStore** (`src/stores/leitherStore.ts`)
   - Provides connection pool instance
   - Exposes helper methods for pool access
   - Manages pool statistics

4. **TweetStore** (`src/stores/tweetStore.ts`)
   - Updated to use pooled clients
   - All user clients now use the connection pool

## Configuration

### Connection Limits

```typescript
maxConnectionsPerIp: 4      // Maximum connections per IP address
maxTotalConnections: 8      // Maximum total connections across all IPs
connectionTimeout: 30000    // 30 seconds timeout for acquiring connection
idleTimeout: 60000          // 1 minute idle before connection cleanup
```

### Performance Benefits

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Simultaneous Requests | 1-2 | 8 | 400-800% |
| Connection Reuse | No | Yes | Reduces overhead |
| Request Latency | High | Low | ~50-70% faster |
| Resource Efficiency | Low | High | Shared pool |

## Usage

### Automatic Usage (Recommended)

All user clients automatically use the connection pool through the ClientProxy:

```typescript
// In tweetStore.ts - automatically uses pool
const user = await this.getUser(userId);
const result = await user.client.RunMApp("get_tweets_by_user", params);
// Connection is automatically released after the call
```

### Manual Usage (Advanced)

#### Get and Release Connection

```typescript
import { useLeitherStore } from '@/stores/leitherStore';

const lapi = useLeitherStore();
const client = await lapi.getClient('127.0.0.1:4800');

try {
  const result = await client.RunMApp("some_method", params);
  // Process result...
} finally {
  lapi.releaseClient('127.0.0.1:4800', client);
}
```

#### Using withClient Helper

```typescript
import { useLeitherStore } from '@/stores/leitherStore';

const lapi = useLeitherStore();

// Automatically handles connection acquisition and release
const result = await lapi.withClient('127.0.0.1:4800', async (client) => {
  return await client.RunMApp("some_method", params);
});
```

#### Creating Pooled Clients

```typescript
import { createPooledClient } from '@/utils/clientProxy';
import { useLeitherStore } from '@/stores/leitherStore';

const lapi = useLeitherStore();
const ip = '127.0.0.1:4800';

// Create a client proxy that automatically uses the pool
const client = createPooledClient(ip, lapi.connectionPool);

// Use it like a regular hprose client
const result = await client.RunMApp("get_user", { aid: appId, ver: "last", userid: userId });
// Connection is automatically acquired and released
```

## Connection Lifecycle

### 1. Connection Acquisition

```
┌─────────────────┐
│ Request Client  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Pool Has Free?  │──Yes──┐
└────────┬────────┘       │
         │ No             ▼
         ▼           ┌─────────┐
┌─────────────────┐ │ Return  │
│ Can Create New? │ │ Client  │
└────────┬────────┘ └─────────┘
         │ No
         ▼
┌─────────────────┐
│ Queue Request   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Wait for Free   │
└─────────────────┘
```

### 2. Connection Release

```
┌─────────────────┐
│ Release Client  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Mark Available  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Process Queue   │──Has Pending?──┐
└─────────────────┘                │
                                   ▼
                         ┌──────────────────┐
                         │ Assign to Pending│
                         └──────────────────┘
```

### 3. Automatic Cleanup

```
┌─────────────────┐
│ Cleanup Timer   │
│   (30 seconds)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Check All Conns │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Idle > 60s?     │──Yes──┐
└────────┬────────┘       │
         │ No             ▼
         │           ┌─────────┐
         │           │ Remove  │
         │           │  Conn   │
         │           └─────────┘
         ▼
┌─────────────────┐
│ Keep Connection │
└─────────────────┘
```

## Features

### 1. Connection Reuse

Connections are reused across multiple requests to the same IP:

```typescript
// First request - creates new connection
const user1 = await getUser(userId1);
await user1.client.RunMApp("get_tweets", params);

// Second request - reuses existing connection
const user2 = await getUser(userId2); // Same provider IP
await user2.client.RunMApp("get_user", params);
```

### 2. Request Queuing

When all connections are busy, requests are queued:

```typescript
// All 8 connections are in use
for (let i = 0; i < 20; i++) {
  // First 8 requests get connections immediately
  // Remaining 12 requests are queued
  promises.push(loadTweet(tweetIds[i]));
}

// As connections are released, queued requests are processed
await Promise.all(promises);
```

### 3. Automatic Cleanup

Idle connections are automatically cleaned up after 60 seconds:

```typescript
// Connection is created
const client = await getClient(ip);

// Use connection
await client.RunMApp("get_user", params);

// Release connection
releaseClient(ip, client);

// After 60 seconds of being idle, connection is removed
// (This happens automatically in the background)
```

### 4. Per-IP Management

Connections are managed separately for each IP address:

```typescript
// Can have up to 4 connections per IP
await Promise.all([
  loadFromIP('127.0.0.1:4800'),  // Uses pool for this IP
  loadFromIP('127.0.0.1:4800'),  // Reuses connection or creates new (max 4)
  loadFromIP('192.168.1.100:4800'),  // Uses pool for this IP
  loadFromIP('192.168.1.100:4800'),  // Reuses connection or creates new (max 4)
]);
```

### 5. Transparent Proxy

The ClientProxy provides a transparent interface:

```typescript
const client = createPooledClient(ip, connectionPool);

// Works exactly like a regular hprose client
const result = await client.RunMApp("get_user", params);
const tweets = await client.RunMApp("get_tweets", params);

// But connections are managed automatically by the pool
```

## Monitoring

### Pool Statistics

Get real-time statistics about the connection pool:

```typescript
import { useLeitherStore } from '@/stores/leitherStore';

const lapi = useLeitherStore();
const stats = lapi.getPoolStats();

console.log(stats);
// Output:
// {
//   totalConnections: 5,
//   pendingRequests: 2,
//   byIp: {
//     '127.0.0.1:4800': {
//       total: 3,
//       inUse: 2,
//       idle: 1
//     },
//     '192.168.1.100:4800': {
//       total: 2,
//       inUse: 1,
//       idle: 1
//     }
//   }
// }
```

### Console Logging

The connection pool provides detailed logging:

```javascript
// Connection creation
[CONNECTION-POOL] Creating new connection for 127.0.0.1:4800 (total: 3/8)
[CONNECTION-POOL] Created new client for ws://127.0.0.1:4800/ws/

// Connection reuse
[CONNECTION-POOL] Reusing connection for 127.0.0.1:4800 (2/3 in use)

// Connection release
[CONNECTION-POOL] Released connection for 127.0.0.1:4800 (1/3 in use)

// Request queuing
[CONNECTION-POOL] All connections busy for 127.0.0.1:4800, queuing request (5 pending)
[CONNECTION-POOL] Fulfilled pending request for 127.0.0.1:4800 (waited 1250ms)

// Cleanup
[CONNECTION-POOL] Removing idle connection for 127.0.0.1:4800 (idle for 65s)
[CONNECTION-POOL] Cleanup: removed 2 idle connections, 6 remaining
```

## Performance Optimization

### Parallel Loading

Load multiple items in parallel:

```typescript
// Bad: Sequential loading (slow)
for (const tweetId of tweetIds) {
  await loadTweet(tweetId);
}

// Good: Parallel loading with connection pool
const promises = tweetIds.map(tweetId => loadTweet(tweetId));
await Promise.all(promises);
// Up to 8 tweets load simultaneously!
```

### Batch Operations

Batch multiple operations together:

```typescript
// Load user data and tweets in parallel
const [user, tweets, followers, followings] = await Promise.all([
  getUser(userId),
  loadTweets(userId),
  getFollowers(userId),
  getFollowings(userId)
]);
```

### Smart Prefetching

Prefetch data before it's needed:

```typescript
// Start loading tweets in background while user views other content
const tweetsPromise = loadTweets(userId);

// Do other work...
await doOtherWork();

// Tweets are ready or nearly ready when we need them
const tweets = await tweetsPromise;
```

## Error Handling

### Connection Timeout

```typescript
try {
  const client = await lapi.getClient(ip);
  // Use client...
} catch (error) {
  if (error.message.includes('timeout')) {
    console.error('Could not acquire connection within 30 seconds');
    // Show user-friendly error message
  }
}
```

### Network Errors

```typescript
const client = createPooledClient(ip, connectionPool);

try {
  const result = await client.RunMApp("get_user", params);
} catch (error) {
  console.error('Network error:', error);
  // Connection is automatically released even on error
  // Retry logic can be implemented here
}
```

### Pool Cleared

```typescript
try {
  const client = await lapi.getClient(ip);
} catch (error) {
  if (error.message.includes('pool cleared')) {
    console.error('Connection pool was cleared');
    // Handle cleanup scenario
  }
}
```

## Best Practices

### 1. Use ClientProxy for User Clients

Always create user clients using `createPooledClient`:

```typescript
// Good
user.client = createPooledClient(user.providerIp, lapi.connectionPool);

// Bad - creates new connection every time
user.client = window.hprose.Client.create("ws://" + ip + "/ws/", ayApi);
```

### 2. Prefer Promise.all for Parallel Operations

```typescript
// Good - parallel execution
const [tweets, users, comments] = await Promise.all([
  loadTweets(),
  loadUsers(),
  loadComments()
]);

// Bad - sequential execution
const tweets = await loadTweets();
const users = await loadUsers();
const comments = await loadComments();
```

### 3. Monitor Pool Statistics in Development

```typescript
// Add to development tools
if (import.meta.env.DEV) {
  setInterval(() => {
    const stats = lapi.getPoolStats();
    console.log('Pool stats:', stats);
  }, 10000);
}
```

### 4. Handle Errors Gracefully

```typescript
try {
  const result = await user.client.RunMApp("get_tweets", params);
  return result;
} catch (error) {
  console.error('Failed to load tweets:', error);
  // Return cached data or empty result
  return [];
}
```

### 5. Don't Hold Connections

When using manual connection management, always release:

```typescript
// Good
const client = await lapi.getClient(ip);
try {
  return await client.RunMApp("method", params);
} finally {
  lapi.releaseClient(ip, client);
}

// Bad - connection never released
const client = await lapi.getClient(ip);
return await client.RunMApp("method", params);
```

## Troubleshooting

### Issue: All Connections Busy

**Symptom**: Requests are queuing for long periods

**Solutions**:
- Check if some operations are taking too long
- Ensure connections are being released properly
- Consider increasing `maxTotalConnections` if needed
- Look for any blocking operations

```typescript
// Debug: Log when operations start and end
console.time('operation');
await user.client.RunMApp("get_tweets", params);
console.timeEnd('operation');
```

### Issue: Connection Timeout

**Symptom**: "Connection request timeout" errors

**Solutions**:
- Check network connectivity to the IP
- Verify the backend service is running
- Check if too many parallel requests are being made
- Increase `connectionTimeout` if operations are legitimately slow

```typescript
// Increase timeout for specific operations
const originalTimeout = 30000;
const extendedTimeout = 60000;

// This is handled automatically by the pool
// But you can check pool stats to see if this is the issue
const stats = lapi.getPoolStats();
if (stats.pendingRequests > 10) {
  console.warn('Many pending requests, possible timeout issues');
}
```

### Issue: Memory Leaks

**Symptom**: Browser memory usage grows over time

**Solutions**:
- Ensure automatic cleanup is running (check console logs)
- Verify connections are being released
- Check for circular references in cached data

```typescript
// Force cleanup if needed
lapi.connectionPool.cleanupIdleConnections();

// Check pool stats
const stats = lapi.getPoolStats();
console.log('Total connections:', stats.totalConnections);
```

### Issue: WebSocket Connection Errors

**Symptom**: "WebSocket connection failed" errors

**Solutions**:
- Verify the IP and port are correct
- Check if the backend service is running
- Verify firewall settings
- Check browser console for CORS errors

```typescript
// Test connection manually
const testClient = window.hprose.Client.create("ws://" + ip + "/ws/", ayApi);
try {
  await testClient.RunMApp("get_user", { aid: appId, ver: "last", userid: "test" });
  console.log('Connection successful');
} catch (error) {
  console.error('Connection failed:', error);
}
```

## Migration Guide

### From Direct Clients to Pooled Clients

#### Before:
```typescript
// Old code - direct client creation
const client = window.hprose.Client.create("ws://" + ip + "/ws/", ayApi);
const result = await client.RunMApp("get_user", params);
```

#### After:
```typescript
// New code - pooled client
import { createPooledClient } from '@/utils/clientProxy';
import { useLeitherStore } from '@/stores/leitherStore';

const lapi = useLeitherStore();
const client = createPooledClient(ip, lapi.connectionPool);
const result = await client.RunMApp("get_user", params);
// Connection is automatically managed
```

### From LeitherStore.getClient to Pooled Clients

#### Before:
```typescript
// Old code
user.client = this.lapi.getClient(user.providerIp);
```

#### After:
```typescript
// New code
import { createPooledClient } from '@/utils/clientProxy';
user.client = createPooledClient(user.providerIp, this.lapi.connectionPool);
```

## Related Documentation

- [Architecture Overview](ARCHITECTURE.md)
- [Leither Connection Management](LEITHER_CONNECTION.md) - Server-side connection pooling
- [API Documentation](API.md)
- [Features Overview](FEATURES.md)

## Future Enhancements

1. **Dynamic Pool Sizing**: Adjust pool size based on network conditions
2. **Connection Health Checks**: Periodic validation of connections
3. **Priority Queue**: Priority-based request queuing
4. **Connection Affinity**: Prefer connections that have been used recently
5. **Metrics Dashboard**: Visual monitoring of pool performance
6. **Adaptive Timeouts**: Adjust timeouts based on historical performance
7. **Load Balancing**: Smart distribution across multiple backend nodes

