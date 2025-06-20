# TUS Server with Tar Extraction

This server provides TUS (Tus Resumable Upload) functionality along with a new tar file extraction feature.

## Features

- **TUS Upload**: Resumable file uploads using the TUS protocol
- **File Browser**: Web interface for browsing uploaded files
- **Network Disk**: Access to files stored in a network disk directory
- **Tar Extraction**: Extract tar/tar.gz files to temporary directories

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

### Tar File Extraction

**POST** `/extract-tar`

Extracts a tar or tar.gz file to a temporary directory and returns the path.

**Request:**
- Content-Type: `multipart/form-data`
- Body: Form data with field name `tarFile` containing the tar file

**Response:**
```json
{
  "success": true,
  "message": "Tar file extracted successfully",
  "extractedPath": "/tmp/tar-extract-1234567890-abc123def",
  "originalFileName": "example.tar.gz",
  "extractedSize": 1024000,
  "extractedAt": "2024-01-01T12:00:00.000Z"
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
    console.log('Extracted to:', data.extractedPath);
  } else {
    console.error('Error:', data.message);
  }
});
```

## Security Notes

- The extracted files are placed in temporary directories that should be cleaned up by the client
- File size is limited to 50MB by default
- Only tar and tar.gz files are accepted
- Authorization is required for all endpoints (except file access)

## File Types Supported

- `application/x-tar` - Standard tar files
- `application/gzip` - Gzipped files
- `application/x-gzip` - Alternative gzip MIME type

## Temporary Directory Cleanup

The server creates temporary directories in the system's temp directory (e.g., `/tmp` on Linux/macOS). These directories are not automatically cleaned up by the server. It's the client's responsibility to clean up the extracted files when they're no longer needed.

The temporary directory path is returned in the response and can be used by the client to access the extracted files or clean them up. 