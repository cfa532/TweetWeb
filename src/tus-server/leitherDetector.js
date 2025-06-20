/**
 * Leither Service Port Detector
 * Uses system commands to detect the port where Leither service is running
 */

const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

/**
 * Detect Leither service port using process information
 * @returns {Promise<number|null>} The port number or null if not found
 */
async function detectLeitherPort() {
  try {
    console.log('Detecting Leither service port...');
    
    // Check for Leither processes
    try {
      const { stdout } = await execAsync('ps aux | grep -i leither | grep -v grep');
      if (stdout) {
        console.log('Found Leither process:', stdout.trim());
        // Try to extract port from process info or config
        const portMatch = stdout.match(/:(\d{4})/);
        if (portMatch) {
          const port = parseInt(portMatch[1]);
          console.log(`Extracted port ${port} from process info`);
          return port;
        }
      }
    } catch (error) {
      console.log('No Leither process found');
    }
    
    console.log('Could not detect Leither service port automatically');
    return null;
    
  } catch (error) {
    console.error('Error detecting Leither port:', error);
    return null;
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