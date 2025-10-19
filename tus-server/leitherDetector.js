/**
 * Leither Service Port Detector
 * Uses system commands to detect the port where Leither service is running
 */

const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

/**
 * Detect Leither service port using netstat to find listening processes
 * @returns {Promise<number|null>} The port number or null if not found
 */
async function detectLeitherPort() {
  try {
    console.log('Detecting Leither service port...');
    
    // Try different commands for different operating systems
    const detectionCommands = [
      // lsof is available on both macOS and Linux and is more reliable
      'lsof -i -P -n | grep LISTEN',
      // Linux style netstat
      'netstat -tlnp | grep LISTEN',
      // macOS style netstat (without -p flag)
      'netstat -an | grep LISTEN',
      // Alternative macOS style
      'netstat -an | grep "\.80[0-9][0-9].*LISTEN"'
    ];
    
    for (const command of detectionCommands) {
      try {
        console.log(`Trying command: ${command}`);
        const { stdout } = await execAsync(command);
        if (stdout) {
          const lines = stdout.split('\n').filter(line => line.trim());
          console.log(`Found ${lines.length} listening ports with command: ${command}`);
          
          for (const line of lines) {
            // For lsof output, check if the process name is "Leither" (case-sensitive)
            if (command.includes('lsof')) {
              // lsof format: Leither 1234 user 23u IPv4 0x1234567890 0t0 TCP *:8081 (LISTEN)
              const leitherMatch = line.match(/^Leither\s+\d+\s+\w+\s+\d+u\s+IPv[46]\s+\w+\s+\d+t\d+\s+TCP\s+\*:(\d{4,5})\s*\(LISTEN\)/);
              if (leitherMatch) {
                const port = parseInt(leitherMatch[1]);
                if (port >= 8000 && port <= 9000) { // Leither port range
                  console.log(`Found Leither process listening on port ${port}`);
                  return port;
                }
              }
            } else {
              // For netstat output, use the old method but with webapi endpoint verification
              const portMatches = [
                // Linux netstat format: tcp 0 0 0.0.0.0:8081 0.0.0.0:* LISTEN
                line.match(/:(\d{4,5})\s/),
                // macOS netstat format: tcp4 0 0 *.8081 *.* LISTEN
                line.match(/\.(\d{4,5})\s/),
                // Alternative format: tcp 0 0 127.0.0.1:8081 0.0.0.0:* LISTEN
                line.match(/127\.0\.0\.1:(\d{4,5})/),
                line.match(/0\.0\.0\.0:(\d{4,5})/)
              ];
              
              for (const match of portMatches) {
                if (match) {
                  const port = parseInt(match[1]);
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
          }
        }
      } catch (error) {
        console.log(`Command failed: ${command} - ${error.message}`);
        continue; // Try next command
      }
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