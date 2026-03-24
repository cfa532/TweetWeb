/**
 * Client Proxy for Connection Pool
 * 
 * This proxy wraps the connection pool and provides the same interface as an hprose client,
 * but automatically manages connections from the pool.
 */

import type ConnectionPoolManager from './connectionPool';

// Type for the connection pool interface that matches what lapi.connectionPool provides
export type ConnectionPoolInterface = Pick<ConnectionPoolManager, 'getConnection' | 'releaseConnection' | 'getStats' | 'clearAll'>;

/**
 * Creates a proxy client that automatically uses the connection pool
 * @param ip The IP address to connect to
 * @param connectionPool The connection pool manager
 * @returns A proxy object that mimics an hprose client
 */
export function createPooledClient(ip: string, connectionPool: ConnectionPoolInterface): any {
  // Store custom timeout if set (default to 6 seconds)
  let customTimeout = 6000;
  
  // Create a proxy that intercepts all method calls
  const proxy = new Proxy({}, {
    get(target, prop, receiver) {
      // Special properties that should be handled directly
      if (prop === 'timeout') {
        // Return the stored timeout value
        return customTimeout;
      }
      
      if (prop === 'ip') {
        return ip;
      }
      
      if (prop === 'isPooledClient') {
        return true;
      }
      
      // Ignore Vue/JavaScript internal properties that shouldn't trigger connection
      const ignoredProps = [
        'toJSON', 'toString', 'valueOf', 'constructor', 'prototype',
        '__proto__', '__v_isRef', '__v_isReadonly', '__v_isReactive',
        '__v_skip', 'then', 'catch', 'finally', Symbol.toStringTag,
        Symbol.iterator, Symbol.asyncIterator, Symbol.hasInstance
      ];
      
      if (ignoredProps.includes(prop as any) || typeof prop === 'symbol') {
        return undefined;
      }
      
      // Return a wrapper function that will acquire connection only when called
      // This prevents acquiring connections on property access
      return function(...args: any[]) {
        // Return a promise that handles the connection lifecycle
        return (async () => {
          let client;
          try {
            client = await connectionPool.getConnection(ip);

            // CRITICAL: Apply custom timeout to the real client before calling method
            if (customTimeout !== 10000) {
              console.log(`[POOLED-CLIENT] Applying timeout ${customTimeout}ms to client for ${ip}`);
              (client as any).timeout = customTimeout;
            }

            // Get the method from the actual client
            const method = (client as any)[prop];
            if (typeof method === 'function') {
              // Race the RPC call against a timeout to guarantee connection release
              // even if the underlying hprose call hangs indefinitely
              const timeoutMs = customTimeout + 2000; // grace period beyond client timeout
              const result = await Promise.race([
                method.apply(client, args),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error(
                    `Pooled call ${String(prop)} to ${ip} timed out after ${timeoutMs}ms`
                  )), timeoutMs)
                )
              ]);
              return result;
            }
            // If it's a property, return it
            return method;
          } finally {
            // Always release the connection
            if (client) {
              connectionPool.releaseConnection(ip, client);
            }
          }
        })();
      };
    },
    
    set(target, prop, value, receiver) {
      // Allow setting timeout
      if (prop === 'timeout') {
        // Store the timeout to be applied to real clients
        customTimeout = value;
        console.log(`[POOLED-CLIENT] Timeout set to ${value}ms for ${ip}`);
        return true;
      }
      return false;
    }
  });
  
  return proxy;
}

/**
 * Execute a client method with automatic connection management
 * Useful for one-off calls where you don't need to maintain a client reference
 * 
 * @param ip The IP address to connect to
 * @param connectionPool The connection pool manager
 * @param methodName The name of the method to call
 * @param args Arguments to pass to the method
 * @returns The result of the method call
 */
export async function executeWithPool(
  ip: string,
  connectionPool: ConnectionPoolInterface,
  methodName: string,
  ...args: any[]
): Promise<any> {
  const client = await connectionPool.getConnection(ip);
  try {
    const method = (client as any)[methodName];
    if (typeof method !== 'function') {
      throw new Error(`Method ${methodName} not found on client`);
    }
    return await method.apply(client, args);
  } finally {
    connectionPool.releaseConnection(ip, client);
  }
}

/**
 * Check if a client is a pooled client proxy
 * @param client The client to check
 * @returns True if the client is a pooled client
 */
export function isPooledClient(client: any): boolean {
  return client && client.isPooledClient === true;
}

