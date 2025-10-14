# TUS Server - TweetWeb Backend

Backend server for TweetWeb providing video conversion, file upload, and IPFS integration.

## 📚 Documentation

**Complete documentation has been moved to the `/docs` directory.**

### Main Documentation

- **[Complete Server Documentation](../docs/TUS_SERVER.md)** - Full backend server documentation
- **[Setup & Installation](../docs/SETUP.md)** - Installation and configuration guide
- **[API Documentation](../docs/API.md)** - Complete API reference
- **[Video Conversion Guide](../docs/VIDEO_CONVERSION.md)** - Video processing details
- **[ZIP Processing](../docs/ZIP_PROCESSING.md)** - ZIP file processing
- **[Architecture Overview](../docs/ARCHITECTURE.md)** - System design

## Quick Start

### Installation

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env with your configuration

# Start server
npm start
```

### Environment Variables

Create a `.env` file:

```env
PORT=3000
AUTHORIZED_USERNAME=your_username
NET_DISK=/path/to/your/network/disk
```

See [Setup Guide - Environment Configuration](../docs/SETUP.md#environment-configuration) for complete configuration options.

## Features

- **Video Conversion**: Automatic HLS conversion with adaptive bitrate
- **Hardware Acceleration**: Support for NVIDIA, Intel, Apple, and AMD encoders
- **File Upload**: TUS resumable upload protocol
- **ZIP Processing**: Process pre-converted HLS content
- **TAR Extraction**: Extract tar/tar.gz files
- **IPFS Integration**: Upload to IPFS via Leither service
- **Concurrent Processing**: Up to 3 simultaneous video conversions

## API Endpoints

### Video Conversion

```bash
# Upload and convert video
POST /convert-video

# Check conversion status
GET /convert-video/status/:jobId
```

### ZIP Processing

```bash
# Process ZIP with HLS content
POST /process-zip

# Check processing status  
GET /process-zip/status/:jobId
```

### File Upload

```bash
# TUS resumable upload
POST/PATCH /files/*

# Register uploaded file
POST /files/register
```

### Tar Extraction

```bash
# Extract tar/tar.gz file
POST /extract-tar
```

See [API Documentation](../docs/API.md) for complete endpoint details.

## Video Conversion Algorithm

The server uses intelligent encoder selection:

1. **No Resample Mode**: Direct stream copy (fastest)
2. **Large Files (>256MB)**: Single quality 720p conversion
3. **Regular Files (≤256MB)**: Multi-quality 720p + 480p conversion

**Encoder Priority**:
1. Copy encoder (for compatible videos ≤1280p)
2. Hardware encoders (NVIDIA → Intel → Apple → AMD)
3. Software encoder (libx264)

**Important**: Copy encoder is **never used for multi-quality conversion** as it cannot scale video.

See [Video Conversion Guide](../docs/VIDEO_CONVERSION.md) for full details.

## Requirements

### Software

- Node.js 16+
- FFmpeg with H.264 support
- Leither service (for IPFS integration)

### Optional (for hardware acceleration)

- NVIDIA GPU with NVENC support
- Intel CPU with QuickSync support
- Apple Silicon (M1/M2/M3/M4)
- AMD GPU with AMF support

See [Setup Guide - FFmpeg Installation](../docs/SETUP.md#ffmpeg-installation) for installation instructions.

## Configuration

### Concurrency

Default limits (configured in code):

```javascript
maxConcurrentUploads = 3       // Video conversions
maxLeitherConnections = 2       // IPFS connections
uploadTimeout = 21600000        // 6 hours
```

### File Size Limits

```javascript
maxVideoSize = 4GB              // Video files
maxZipSize = 500MB              // ZIP files
maxTarSize = 50MB               // TAR files
```

## Development

```bash
# Start in development mode
npm run dev

# Run tests (if available)
npm test

# Check logs
tail -f logs/server.log
```

## Production Deployment

### Using PM2

```bash
npm install -g pm2
pm2 start app.js --name tweetweb-backend
pm2 save
pm2 startup
```

### Using Docker

See [Setup Guide - Production Deployment](../docs/SETUP.md#production-deployment)

## Troubleshooting

### Common Issues

**FFmpeg not found**:
```bash
which ffmpeg
# If not found, install FFmpeg
brew install ffmpeg  # macOS
sudo apt install ffmpeg  # Ubuntu
```

**Port already in use**:
```bash
# Change PORT in .env file
PORT=3001
```

**Leither connection failed**:
- Verify Leither service is running
- Check firewall settings
- Review port configuration

See [Setup Guide - Troubleshooting](../docs/SETUP.md#troubleshooting) for more solutions.

## File Structure

```
tus-server/
├── app.js                  # Main application
├── videoRoutes.js          # Video conversion endpoints
├── zipRoutes.js            # ZIP processing endpoints
├── uploadRoutes.js         # File upload endpoints
├── leitherDetector.js      # Leither port detection
├── netdisk.js              # Network disk routes
├── uploadedFilesBrowser.js # File browsing
├── package.json            # Dependencies
└── README.md              # This file
```

## License

MIT License

## Support

- **Documentation**: See [/docs](../docs/)
- **Issues**: Open an issue on GitHub
- **API Reference**: [API Documentation](../docs/API.md)
- **Architecture**: [Architecture Overview](../docs/ARCHITECTURE.md)

## Related Documentation

- [Main Project README](../README.md)
- [Complete Documentation Index](../docs/README.md)
- [Setup & Installation Guide](../docs/SETUP.md)
- [API Documentation](../docs/API.md)
- [Video Conversion Guide](../docs/VIDEO_CONVERSION.md)
- [Architecture Overview](../docs/ARCHITECTURE.md)
- [Privacy Policy](../docs/PRIVACY.md)
