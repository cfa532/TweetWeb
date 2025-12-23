/**
 * Client Proxy for Connection Pool
 * 
 * This proxy wraps the connection pool and provides the same interface as an hprose client,
 * but automatically manages connections from the pool.
 */

import type ConnectionPoolManager from './connectionPool';

/**
 * Creates a proxy client that automatically uses the connection pool
 * @param ip The IP address to connect to
 * @param connectionPool The connection pool manager
 * @returns A proxy object that mimics an hprose client
 */
export function createPooledClient(ip: string, connectionPool: ConnectionPoolManager): any {
  // Create a proxy that intercepts all method calls
  const proxy = new Proxy({}, {
    get(target, prop, receiver) {
      // Special properties that should be handled directly
      if (prop === 'timeout') {
        // Return a default timeout value
        return 30000;
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
            
            // Get the method from the actual client
            const method = (client as any)[prop];
            if (typeof method === 'function') {
              // Call the method and await its result
              return await method.apply(client, args);
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
        // We don't actually set this on the proxy since each real client
        // will have its own timeout, but we accept it to maintain compatibility
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
  connectionPool: ConnectionPoolManager,
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

