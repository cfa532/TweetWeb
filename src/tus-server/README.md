# TUS Server with Tar Extraction and Leither Integration

This server provides TUS (Tus Resumable Upload) functionality along with tar file extraction and integration with the Leither service for IPFS storage.

## Features

- **TUS Upload**: Resumable file uploads using the TUS protocol
- **File Browser**: Web interface for browsing uploaded files
- **Network Disk**: Access to files stored in a network disk directory
- **Tar Extraction**: Extract tar/tar.gz files to temporary directories
- **Leither Integration**: Automatically detect Leither service and add extracted files to IPFS
- **IPFS Storage**: Get CID (Content Identifier) for extracted files

## Setup

1. Install dependencies:
```bash
cd src/tus-server
npm install
```

2. Create a `.env` file with the following variables:
```env
PORT=3000
AUTHORIZED_USERNAME=your_username
NET_DISK=/path/to/your/network/disk
```

3. Start the server:
```bash
npm start
```

## API Endpoints

### Tar File Extraction with IPFS

**POST** `/extract-tar`

Extracts a tar or tar.gz file to a temporary directory, adds it to IPFS via Leither service, and returns the CID.

**Request:**
- Content-Type: `multipart/form-data`
- Body: Form data with field name `tarFile` containing the tar file

**Response (Success with IPFS):**
```json
{
  "success": true,
  "message": "Tar file extracted and added to IPFS successfully",
  "extractedPath": "/tmp/tar-extract-1234567890-abc123def",
  "originalFileName": "example.tar.gz",
  "extractedSize": 1024000,
  "extractedAt": "2024-01-01T12:00:00.000Z",
  "cid": "QmX...",
  "leitherPort": 8081
}
```

**Response (Success without IPFS):**
```json
{
  "success": true,
  "message": "Tar file extracted successfully, but Leither service failed",
  "extractedPath": "/tmp/tar-extract-1234567890-abc123def",
  "originalFileName": "example.tar.gz",
  "extractedSize": 1024000,
  "extractedAt": "2024-01-01T12:00:00.000Z",
  "leitherError": "Connection refused",
  "leitherPort": 8081
}
```

**Error Response:**
```json
{
  "success": false,
  "message": "Error message",
  "error": "Detailed error information"
}
```

### Example Usage

Using curl:
```bash
curl -X POST \
  -F "tarFile=@/path/to/your/file.tar.gz" \
  http://localhost:3000/extract-tar
```

Using JavaScript/Fetch:
```javascript
const formData = new FormData();
formData.append('tarFile', fileInput.files[0]);

fetch('/extract-tar', {
  method: 'POST',
  body: formData
})
.then(response => response.json())
.then(data => {
  if (data.success) {
    if (data.cid) {
      console.log('IPFS CID:', data.cid);
      console.log('Extracted to:', data.extractedPath);
    } else {
      console.log('Extracted to:', data.extractedPath);
      console.log('Leither error:', data.leitherError);
    }
  } else {
    console.error('Error:', data.message);
  }
});
```

## Leither Service Integration

The server automatically detects the Leither service port using system commands:

1. **Port Detection**: Uses `netstat`, `ps`, `pgrep`, and `lsof` to find the Leither service
2. **Common Ports**: Checks ports 8081, 4800, 8080, 3000, 5000
3. **Connection Test**: Tests connectivity to the detected port
4. **Fallback**: Uses port 8081 as default if detection fails

### Leither Workflow

1. **Port Detection**: Automatically finds Leither service port
2. **Client Creation**: Creates hprose HTTP client to `http://localhost:{port}/webapi/`
3. **Authentication**: Gets PPT and logs in to get API access
4. **IPFS Upload**: Adds extracted directory to IPFS using `IpfsAdd`
5. **CID Return**: Returns the IPFS Content Identifier (CID)

## Security Notes

- The extracted files are placed in temporary directories that should be cleaned up by the client
- File size is limited to 50MB by default
- Only tar and tar.gz files are accepted
- Authorization is required for most endpoints (except file access and tar extraction)
- Leither service integration is optional - extraction works even if Leither is unavailable

## File Types Supported

- `application/x-tar` - Standard tar files
- `application/gzip` - Gzipped files
- `application/x-gzip` - Alternative gzip MIME type

## Authorization

The following endpoints do NOT require authorization:
- `/extract-tar` - Tar file extraction with IPFS
- `/netd/*` - File access paths
- `/files/register` - File registration

All other endpoints require the `AUTHORIZED_USERNAME` to be provided via query params, request body, or headers.

## Temporary Directory Cleanup

The server creates temporary directories in the system's temp directory (e.g., `/tmp` on Linux/macOS). These directories are not automatically cleaned up by the server. It's the client's responsibility to clean up the extracted files when they're no longer needed.

The temporary directory path is returned in the response and can be used by the client to access the extracted files or clean them up.

## Testing

Run the test script to verify functionality:
```bash
npm test
```

This will:
1. Create a test tar file with sample content
2. Upload it to the server
3. Extract it and attempt IPFS upload via Leither
4. Display the results including CID if successful 