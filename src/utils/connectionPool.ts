/**
 * Client-side Connection Pool Manager for Hprose WebSocket connections
 * 
 * Manages a pool of reusable connections to improve performance by allowing
 * multiple simultaneous requests to the same or different servers.
 */

interface PooledConnection {
  client: any;
  ip: string;
  inUse: boolean;
  createdAt: number;
  lastUsed: number;
}

interface PendingRequest {
  ip: string;
  resolve: (client: any) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

class ConnectionPoolManager {
  private connections: Map<string, PooledConnection[]> = new Map();
  private pendingRequests: PendingRequest[] = [];
  private readonly maxConnectionsPerIp: number = 8; // 8 connections per IP
  private readonly maxTotalConnections: number = 16; // Total 16 connections across all IPs
  private readonly connectionTimeout: number = 30000; // 30 seconds
  private readonly idleTimeout: number = 60000; // 1 minute idle before cleanup
  private readonly ayApi: string[];
  
  constructor(ayApi: string[]) {
    this.ayApi = ayApi;
    
    // Periodically cleanup idle connections
    setInterval(() => this.cleanupIdleConnections(), 30000);
  }

  /**
   * Get total number of active connections across all IPs
   */
  private getTotalConnectionCount(): number {
    let count = 0;
    for (const [, connections] of this.connections) {
      count += connections.length;
    }
    return count;
  }

  /**
   * Get a connection from the pool or create a new one
   * @param ip The IP address to connect to
   * @returns A promise that resolves to an hprose client
   */
  async getConnection(ip: string): Promise<any> {
    console.log(`[CONNECTION-POOL] Request connection for ${ip}`);
    
    // Get or create connections array for this IP
    if (!this.connections.has(ip)) {
      this.connections.set(ip, []);
    }
    
    const ipConnections = this.connections.get(ip)!;
    
    // Try to find an available connection for this IP
    for (const conn of ipConnections) {
      if (!conn.inUse) {
        conn.inUse = true;
        conn.lastUsed = Date.now();
        console.log(`[CONNECTION-POOL] Reusing connection for ${ip} (${ipConnections.filter(c => c.inUse).length}/${ipConnections.length} in use)`);
        return conn.client;
      }
    }
    
    // Check if we can create a new connection
    const totalConnections = this.getTotalConnectionCount();
    const canCreateConnection = 
      ipConnections.length < this.maxConnectionsPerIp && 
      totalConnections < this.maxTotalConnections;
    
    if (canCreateConnection) {
      // Create new connection
      console.log(`[CONNECTION-POOL] Creating new connection for ${ip} (total: ${totalConnections + 1}/${this.maxTotalConnections})`);
      const client = this.createClient(ip);
      
      const connection: PooledConnection = {
        client,
        ip,
        inUse: true,
        createdAt: Date.now(),
        lastUsed: Date.now()
      };
      
      ipConnections.push(connection);
      return client;
    }
    
    // All connections are busy, queue the request
    console.log(`[CONNECTION-POOL] All connections busy for ${ip}, queuing request (${this.pendingRequests.length} pending)`);
    
    return new Promise<any>((resolve, reject) => {
      const request: PendingRequest = {
        ip,
        resolve,
        reject,
        timestamp: Date.now()
      };
      
      this.pendingRequests.push(request);
      
      // Set timeout for pending request
      setTimeout(() => {
        const index = this.pendingRequests.indexOf(request);
        if (index !== -1) {
          this.pendingRequests.splice(index, 1);
          reject(new Error(`Connection request timeout for ${ip} after ${this.connectionTimeout}ms`));
        }
      }, this.connectionTimeout);
    });
  }

  /**
   * Release a connection back to the pool
   * @param ip The IP address of the connection
   * @param client The client to release
   */
  releaseConnection(ip: string, client: any): void {
    const ipConnections = this.connections.get(ip);
    if (!ipConnections) {
      console.warn(`[CONNECTION-POOL] No connections found for ${ip}`);
      return;
    }
    
    const conn = ipConnections.find(c => c.client === client);
    if (conn) {
      conn.inUse = false;
      conn.lastUsed = Date.now();
      console.log(`[CONNECTION-POOL] Released connection for ${ip} (${ipConnections.filter(c => c.inUse).length}/${ipConnections.length} in use)`);
      
      // Process pending requests for this IP first
      this.processPendingRequests(ip);
      
      // If no pending requests for this IP, check if other IPs can use this slot
      if (this.pendingRequests.length > 0) {
        this.processPendingRequests();
      }
    }
  }

  /**
   * Process pending requests, prioritizing a specific IP if provided
   * @param priorityIp Optional IP to prioritize
   */
  private processPendingRequests(priorityIp?: string): void {
    if (this.pendingRequests.length === 0) {
      return;
    }
    
    // Find requests for the priority IP first
    let requestIndex = -1;
    if (priorityIp) {
      requestIndex = this.pendingRequests.findIndex(req => req.ip === priorityIp);
    }
    
    // If no priority request found, get the oldest request
    if (requestIndex === -1) {
      requestIndex = 0;
    }
    
    if (requestIndex === -1 || requestIndex >= this.pendingRequests.length) {
      return;
    }
    
    const request = this.pendingRequests[requestIndex];
    const ipConnections = this.connections.get(request.ip);
    
    if (!ipConnections) {
      this.pendingRequests.splice(requestIndex, 1);
      request.reject(new Error(`No connections available for ${request.ip}`));
      return;
    }
    
    // Try to find an available connection
    for (const conn of ipConnections) {
      if (!conn.inUse) {
        conn.inUse = true;
        conn.lastUsed = Date.now();
        this.pendingRequests.splice(requestIndex, 1);
        console.log(`[CONNECTION-POOL] Fulfilled pending request for ${request.ip} (waited ${Date.now() - request.timestamp}ms)`);
        request.resolve(conn.client);
        return;
      }
    }
    
    // Check if we can create a new connection for this request
    const totalConnections = this.getTotalConnectionCount();
    const canCreateConnection = 
      ipConnections.length < this.maxConnectionsPerIp && 
      totalConnections < this.maxTotalConnections;
    
    if (canCreateConnection) {
      this.pendingRequests.splice(requestIndex, 1);
      console.log(`[CONNECTION-POOL] Creating new connection for pending request ${request.ip}`);
      
      const client = this.createClient(request.ip);
      const connection: PooledConnection = {
        client,
        ip: request.ip,
        inUse: true,
        createdAt: Date.now(),
        lastUsed: Date.now()
      };
      
      ipConnections.push(connection);
      request.resolve(client);
    }
  }

  /**
   * Create a new hprose client
   * @param ip The IP address to connect to
   * @returns An hprose client instance
   */
  private createClient(ip: string): any {
    const client = window.hprose.Client.create("ws://" + ip + "/ws/", this.ayApi);
    console.log(`[CONNECTION-POOL] Created new client for ws://${ip}/ws/`);
    return client;
  }

  /**
   * Cleanup idle connections that haven't been used recently
   */
  private cleanupIdleConnections(): void {
    const now = Date.now();
    let removedCount = 0;
    
    for (const [ip, connections] of this.connections) {
      const activeConnections = connections.filter(conn => {
        const isIdle = !conn.inUse && (now - conn.lastUsed > this.idleTimeout);
        if (isIdle) {
          console.log(`[CONNECTION-POOL] Removing idle connection for ${ip} (idle for ${Math.round((now - conn.lastUsed) / 1000)}s)`);
          removedCount++;
          return false;
        }
        return true;
      });
      
      if (activeConnections.length === 0) {
        this.connections.delete(ip);
      } else {
        this.connections.set(ip, activeConnections);
      }
    }
    
    if (removedCount > 0) {
      console.log(`[CONNECTION-POOL] Cleanup: removed ${removedCount} idle connections, ${this.getTotalConnectionCount()} remaining`);
    }
  }

  /**
   * Get pool statistics for monitoring
   */
  getStats() {
    const stats: any = {
      totalConnections: this.getTotalConnectionCount(),
      pendingRequests: this.pendingRequests.length,
      byIp: {}
    };
    
    for (const [ip, connections] of this.connections) {
      stats.byIp[ip] = {
        total: connections.length,
        inUse: connections.filter(c => c.inUse).length,
        idle: connections.filter(c => !c.inUse).length
      };
    }
    
    return stats;
  }

  /**
   * Clear all connections (useful for testing or cleanup)
   */
  clearAll(): void {
    console.log(`[CONNECTION-POOL] Clearing all connections`);
    this.connections.clear();
    
    // Reject all pending requests
    for (const request of this.pendingRequests) {
      request.reject(new Error('Connection pool cleared'));
    }
    this.pendingRequests = [];
  }
}

export default ConnectionPoolManager;

