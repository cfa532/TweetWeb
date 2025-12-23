# TweetWeb Documentation

Complete documentation for the TweetWeb decentralized social media platform.

## 📚 Documentation Index

### Getting Started

- **[Setup & Installation Guide](SETUP.md)** - Complete setup instructions for development and production
- **[Quick Start](#quick-start)** - Get up and running in 5 minutes

### Core Documentation

- **[Features Overview](FEATURES.md)** - Comprehensive feature documentation
- **[Architecture Overview](ARCHITECTURE.md)** - System design and architecture
- **[API Documentation](API.md)** - Complete API reference
- **[Video Conversion Guide](VIDEO_CONVERSION.md)** - HLS conversion for large videos (>50MB)
- **[Video Normalization Guide](VIDEO_NORMALIZATION.md)** - MP4 normalization for small videos (<50MB)

### Backend Documentation

- **[TUS Server Documentation](TUS_SERVER.md)** - Backend server documentation
- **[ZIP Processing](ZIP_PROCESSING.md)** - ZIP file processing for HLS content
- **[Leither Connection Management](LEITHER_CONNECTION.md)** - Server-side IPFS connection management

### Frontend Documentation

- **[Client Connection Pool](CLIENT_CONNECTION_POOL.md)** - Client-side connection pooling (8 simultaneous connections)

### Legal & Privacy

- **[Privacy Policy](PRIVACY.md)** - Privacy policy and data handling

## Quick Start

### Prerequisites

- Node.js 16+
- FFmpeg
- Leither service

### Installation (5 Minutes)

```bash
# 1. Clone repository
git clone https://github.com/yourusername/TweetWeb.git
cd TweetWeb

# 2. Install frontend dependencies
npm install

# 3. Install backend dependencies
cd tus-server
npm install
cd ..

# 4. Start backend (Terminal 1)
cd tus-server
npm start

# 5. Start frontend (Terminal 2)
npm run dev

# 6. Open browser
open http://localhost:5173
```

## Documentation by Role

### For Developers

**First Time Setup:**
1. [Setup & Installation Guide](SETUP.md)
2. [Architecture Overview](ARCHITECTURE.md)
3. [API Documentation](API.md)

**Working with Video:**
1. [Video Normalization Guide](VIDEO_NORMALIZATION.md) - For small videos (<50MB)
2. [Video Conversion Guide](VIDEO_CONVERSION.md) - For large videos (>50MB)
3. [API Documentation - Video Endpoints](API.md#video-conversion-api)

**Working with Files:**
1. [API Documentation - File Upload](API.md#file-upload-api)
2. [ZIP Processing](ZIP_PROCESSING.md)

**Backend Architecture:**
1. [Leither Connection Management](LEITHER_CONNECTION.md) - Server-side pooling
2. [Client Connection Pool](CLIENT_CONNECTION_POOL.md) - Client-side pooling
3. [Architecture Overview](ARCHITECTURE.md)

### For System Administrators

**Deployment:**
1. [Setup Guide - Production Deployment](SETUP.md#production-deployment)
2. [Architecture - Deployment Architecture](ARCHITECTURE.md#deployment-architecture)

**Monitoring:**
1. [Setup Guide - Troubleshooting](SETUP.md#troubleshooting)
2. [Architecture - Monitoring & Observability](ARCHITECTURE.md#monitoring--observability)

**Performance:**
1. [Video Conversion - Performance Optimization](VIDEO_CONVERSION.md#performance-optimization)
2. [Architecture - Scalability](ARCHITECTURE.md#scalability)

### For End Users

**Privacy & Security:**
1. [Privacy Policy](PRIVACY.md)
2. [Architecture - Security Architecture](ARCHITECTURE.md#security-architecture)

## Common Tasks

### Video Upload

See: [API Documentation - Video Conversion](API.md#video-conversion-api)

```javascript
const formData = new FormData();
formData.append('videoFile', videoFile);

const response = await fetch('/convert-video', {
  method: 'POST',
  body: formData
});

const { jobId } = await response.json();
// Poll /convert-video/status/:jobId for progress
```

### Setup Hardware Acceleration

See: [Setup Guide - FFmpeg Installation](SETUP.md#ffmpeg-installation) and [Video Conversion - Hardware Acceleration](VIDEO_CONVERSION.md#hardware-acceleration)

```bash
# macOS (VideoToolbox)
brew install ffmpeg

# Linux with NVIDIA
sudo apt install ffmpeg nvidia-cuda-toolkit

# Verify
ffmpeg -encoders | grep h264
```

### Deploy to Production

See: [Setup Guide - Production Deployment](SETUP.md#production-deployment)

```bash
# Using PM2
npm install -g pm2
cd tus-server
pm2 start app.js --name tweetweb-backend
pm2 save
pm2 startup
```

### Troubleshoot Video Conversion

See: [Video Conversion - Troubleshooting](VIDEO_CONVERSION.md#troubleshooting)

Common issues:
- FFmpeg not found
- Hardware encoder fails
- Slow conversion
- Quality issues
- Audio sync problems

## API Quick Reference

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/normalize-video` | POST | Normalize small video (<50MB) to MP4 |
| `/convert-video` | POST | Upload and convert video to HLS |
| `/convert-video/status/:jobId` | GET | Check video conversion status |
| `/process-zip` | POST | Process ZIP containing HLS content |
| `/process-zip/status/:jobId` | GET | Check ZIP processing status |
| `/extract-tar` | POST | Extract tar/tar.gz files |
| `/files/*` | * | TUS resumable upload endpoints |
| `/netd/*` | GET | Access network disk files |

Full API documentation: [API.md](API.md)

## Architecture Quick Reference

### System Components

```
┌─────────────┐
│   Browser   │  Vue.js Frontend
│  (Vue.js)   │
└──────┬──────┘
       │ HTTP/WebSocket
┌──────▼────────┐
│   Express     │  Node.js Backend
│   Backend     │
└──────┬────────┘
       │
   ┌───┴───┐
   │       │
┌──▼──┐ ┌─▼──────┐
│FFmpeg│ │Leither │
│     │ │ IPFS   │
└─────┘ └────────┘
```

Full architecture: [ARCHITECTURE.md](ARCHITECTURE.md)

## Technology Stack

### Frontend
- Vue 3 + TypeScript
- Pinia (State Management)
- Vue Router
- Bootstrap 5
- Video.js + HLS.js

### Backend
- Node.js + Express
- FFmpeg (Video Processing)
- Hprose (IPFS Integration)
- TUS Protocol (Resumable Uploads)

Full stack details: [ARCHITECTURE.md#technology-stack](ARCHITECTURE.md#technology-stack)

## Video Conversion Algorithm

```
1. Upload → Immediate response with jobId
2. Background processing:
   - Video analysis (resolution, codec, etc.)
   - Encoder selection (hardware/software)
   - HLS conversion (720p, 480p)
   - IPFS upload
3. Status polling → Get CID when complete
```

Full algorithm: [VIDEO_CONVERSION.md#conversion-algorithm](VIDEO_CONVERSION.md#conversion-algorithm)

## File Size Limits

| Type | Limit | Endpoint |
|------|-------|----------|
| Video | 4GB | `/convert-video` |
| ZIP | 500MB | `/process-zip` |
| TAR | 50MB | `/extract-tar` |
| General Files | Varies | `/files/*` |

## Support Quality Profiles

### Video Output

| Quality | Resolution | Bitrate | Use Case |
|---------|------------|---------|----------|
| 720p | 1280x720 | Adaptive (capped at 3000k) | High quality, desktop |
| 480p | 854x480 | Adaptive (capped at 1500k) | Lower bandwidth, mobile |
| 360p | Scaled | Adaptive (capped at 1000k) | Low bandwidth, mobile |

Full quality details: [VIDEO_CONVERSION.md#quality-profiles](VIDEO_CONVERSION.md#quality-profiles)

## Environment Variables

### Frontend (.env)

```env
VITE_API_BASE_URL=http://localhost:3000
VITE_WS_URL=ws://localhost:3000
```

### Backend (tus-server/.env)

```env
PORT=3000
AUTHORIZED_USERNAME=admin
NET_DISK=/path/to/network/disk
MAX_CONCURRENT_UPLOADS=3
```

Full configuration: [SETUP.md#environment-configuration](SETUP.md#environment-configuration)

## Performance Benchmarks

### Video Conversion Times (Typical)

| File Size | Hardware Accel | Software Only |
|-----------|----------------|---------------|
| 100MB | 1-2 min | 3-5 min |
| 500MB | 3-5 min | 10-15 min |
| 1GB | 5-10 min | 20-30 min |
| 2GB | 10-20 min | 40-60 min |

*Times vary based on video codec, resolution, and system specs*

### Concurrent Processing

- Maximum concurrent video conversions: **3**
- Additional requests queued: **FIFO order**
- Maximum queue size: **10 requests**

## Security Considerations

### Upload Security

- ✅ File type validation
- ✅ File size limits
- ✅ Path sanitization
- ✅ Process isolation (FFmpeg)
- ✅ Automatic cleanup

### IPFS Considerations

- ⚠️ Content is **public** by default
- ⚠️ CIDs are **permanent** once shared
- ⚠️ Deletion is **not guaranteed** on distributed network
- ⚠️ Do **not** upload sensitive personal information

Full security details: [ARCHITECTURE.md#security-architecture](ARCHITECTURE.md#security-architecture)

## Contributing

We welcome contributions! Areas where help is needed:

- 📱 Mobile app development
- 🎨 UI/UX improvements
- 🔧 Performance optimization
- 📚 Documentation improvements
- 🐛 Bug fixes
- ✨ New features

## License

MIT License - see LICENSE file for details

## Links

- **Main README**: [/README.md](../README.md)
- **Production**: http://tweet2.fireshare.uk/
- **Alternative**: http://tweet1.sharefire.store/
- **GitHub Issues**: Report bugs and request features

## Version History

### v1.0.0 (Current)
- Initial release
- Video conversion with HLS output
- ZIP processing
- File upload via TUS
- IPFS integration
- Hardware-accelerated encoding

## Getting Help

1. **Documentation**: Check this documentation first
2. **Common Issues**: See [SETUP.md - Troubleshooting](SETUP.md#troubleshooting)
3. **Video Issues**: See [VIDEO_CONVERSION.md - Troubleshooting](VIDEO_CONVERSION.md#troubleshooting)
4. **GitHub Issues**: Open an issue for bugs or questions
5. **Support**: Contact through the application

## What's Next?

After reading the documentation, try:

1. **Development Setup**: Follow [SETUP.md](SETUP.md)
2. **Upload a Test Video**: Use the API examples in [API.md](API.md)
3. **Explore Architecture**: Understand the system in [ARCHITECTURE.md](ARCHITECTURE.md)
4. **Optimize Performance**: Read [VIDEO_CONVERSION.md](VIDEO_CONVERSION.md)

Happy coding! 🚀

