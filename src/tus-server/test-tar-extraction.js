/**
 * Test script for tar extraction functionality
 * This script creates a test tar file and uploads it to the server
 */

const fs = require('fs');
const path = require('path');
const tar = require('tar');
const FormData = require('form-data');
const fetch = require('node-fetch');

async function testTarExtraction() {
  try {
    console.log('Creating test tar file...');
    
    // Create a temporary directory for test files
    const testDir = path.join(__dirname, 'test-files');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    
    // Create some test files
    const testFiles = [
      { name: 'test1.txt', content: 'This is test file 1' },
      { name: 'test2.txt', content: 'This is test file 2' },
      { name: 'subdir/test3.txt', content: 'This is test file 3 in subdirectory' }
    ];
    
    for (const file of testFiles) {
      const filePath = path.join(testDir, file.name);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, file.content);
    }
    
    // Create tar file
    const tarPath = path.join(__dirname, 'test.tar.gz');
    await tar.create({
      gzip: true,
      file: tarPath,
      cwd: testDir
    }, ['.']);
    
    console.log(`Created test tar file: ${tarPath}`);
    
    // Upload to server
    console.log('Uploading to server...');
    
    const form = new FormData();
    form.append('tarFile', fs.createReadStream(tarPath), {
      filename: 'test.tar.gz',
      contentType: 'application/gzip'
    });
    
    const response = await fetch('http://localhost:3000/extract-tar', {
      method: 'POST',
      body: form,
      headers: {
        ...form.getHeaders(),
        'x-username': process.env.AUTHORIZED_USERNAME || 'testuser'
      }
    });
    
    const result = await response.json();
    
    if (result.success) {
      console.log('✅ Tar extraction successful!');
      console.log('Extracted path:', result.extractedPath);
      console.log('Original filename:', result.originalFileName);
      console.log('Extracted size:', result.extractedSize);
      console.log('Extracted at:', result.extractedAt);
      
      // List contents of extracted directory
      console.log('\nContents of extracted directory:');
      const listFiles = (dir, prefix = '') => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          const isDir = stat.isDirectory();
          console.log(`${prefix}${isDir ? '📁' : '📄'} ${file}`);
          if (isDir) {
            listFiles(fullPath, prefix + '  ');
          }
        }
      };
      
      listFiles(result.extractedPath);
      
    } else {
      console.error('❌ Tar extraction failed:', result.message);
      if (result.error) {
        console.error('Error details:', result.error);
      }
    }
    
    // Cleanup test files
    console.log('\nCleaning up test files...');
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    if (fs.existsSync(tarPath)) {
      fs.unlinkSync(tarPath);
    }
    
  } catch (error) {
    console.error('Test failed:', error);
  }
}

// Run the test if this file is executed directly
if (require.main === module) {
  testTarExtraction();
}

module.exports = { testTarExtraction }; 