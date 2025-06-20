/**
 * Leither Service Port Detector
 * Uses system commands to detect the port where Leither service is running
 */

const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

/**
 * Detect Leither service port using lsof to find listening processes
 * @returns {Promise<number|null>} The port number or null if not found
 */
async function detectLeitherPort() {
  try {
    console.log('Detecting Leither service port...');
    
    // Method 1: Use lsof to find processes listening on common Leither ports
    const commonPorts = [8081, 4800, 8080, 8000, 8500, 9000];
    
    for (const port of commonPorts) {
      try {
        const { stdout } = await execAsync(`lsof -i :${port} -sTCP:LISTEN`);
        if (stdout && stdout.trim()) {
          console.log(`Found process listening on port ${port}:`, stdout.trim());
          
          // Test if this port has a webapi endpoint
          const isWebApi = await testWebApiEndpoint(port);
          if (isWebApi) {
            console.log(`Port ${port} has webapi endpoint - likely Leither service`);
            return port;
          }
        }
      } catch (error) {
        // Port not in use, continue to next
      }
    }
    
    // Method 2: Use netstat to find all listening ports and check for webapi
    try {
      const { stdout } = await execAsync('netstat -tlnp | grep LISTEN');
      if (stdout) {
        const lines = stdout.split('\n').filter(line => line.trim());
        console.log('Found listening ports:', lines.length);
        
        for (const line of lines) {
          const portMatch = line.match(/:(\d{4,5})\s/);
          if (portMatch) {
            const port = parseInt(portMatch[1]);
            if (port >= 8000 && port <= 9000) { // Leither port range
              console.log(`Testing port ${port} for webapi endpoint...`);
              const isWebApi = await testWebApiEndpoint(port);
              if (isWebApi) {
                console.log(`Found webapi endpoint on port ${port} - likely Leither service`);
                return port;
              }
            }
          }
        }
      }
    } catch (error) {
      console.log('Error using netstat:', error.message);
    }
    
    console.log('Could not detect Leither service port automatically');
    return null;
    
  } catch (error) {
    console.error('Error detecting Leither port:', error);
    return null;
  }
}

/**
 * Test if a port has a webapi endpoint
 * @param {number} port - Port to test
 * @returns {Promise<boolean>} True if webapi endpoint exists
 */
async function testWebApiEndpoint(port) {
  try {
    // Test for webapi endpoint specifically
    const { stdout } = await execAsync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/webapi/`);
    return stdout === '200' || stdout === '404' || stdout === '405'; // Any response means endpoint exists
  } catch (error) {
    return false;
  }
}

/**
 * Test connection to a specific port
 * @param {number} port - Port to test
 * @returns {Promise<boolean>} True if connection successful
 */
async function testPortConnection(port) {
  try {
    const { stdout } = await execAsync(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/webapi/`);
    return stdout === '200' || stdout === '404' || stdout === '405'; // Any response means service is there
  } catch (error) {
    return false;
  }
}

/**
 * Get the best available Leither port
 * @returns {Promise<number>} The port number (defaults to 8081 if not found)
 */
async function getLeitherPort() {
  const detectedPort = await detectLeitherPort();
  
  if (detectedPort) {
    const isConnectable = await testPortConnection(detectedPort);
    if (isConnectable) {
      console.log(`Using detected Leither port: ${detectedPort}`);
      return detectedPort;
    }
  }
  
  // Fallback to default port
  console.log('Using default Leither port: 8081');
  return 8081;
}

module.exports = {
  detectLeitherPort,
  testPortConnection,
  getLeitherPort
}; 