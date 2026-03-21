# TweetWeb - Decentralized Social Media Platform

A privacy-focused, decentralized social media platform built with Vue.js and IPFS, featuring video streaming, file sharing, and peer-to-peer communication.

## 🌟 Features

- **Decentralized Architecture**: Built on IPFS for distributed content storage
- **Video Streaming**: Automatic HLS conversion with adaptive bitrate streaming
- **File Sharing**: Secure file upload and sharing with encryption
- **Real-time Updates**: Live feed updates and notifications
- **Privacy-Focused**: No centralized data collection
- **Mobile-Friendly**: Responsive design for all devices

## 🚀 Quick Start

### Prerequisites

- Node.js 16+ and npm
- FFmpeg (for video conversion)
- Leither service (for IPFS integration)

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/TweetWeb.git
cd TweetWeb

# Install frontend dependencies
npm install

# Install backend dependencies
cd tus-server
npm install
cd ..

# Start the development server
npm run dev

# Start the TUS server (in a separate terminal)
cd tus-server
npm start
```

Visit `http://localhost:5173` to access the application.

## 📚 Documentation

Complete documentation is available in the [docs](docs/) folder:

- **[Features Overview](docs/FEATURES.md)** - Comprehensive feature documentation
- **[Setup & Installation Guide](docs/SETUP.md)** - Detailed setup instructions
- **[API Documentation](docs/API.md)** - Complete API reference
- **[Video Normalization Guide](docs/VIDEO_NORMALIZATION.md)** - Small video processing (<50MB)
- **[Video Conversion Guide](docs/VIDEO_CONVERSION.md)** - Large video processing (>50MB)
- **[Architecture Overview](docs/ARCHITECTURE.md)** - System design and architecture
- **[Privacy Policy](docs/PRIVACY.md)** - Privacy policy and data handling

See [docs/README.md](docs/README.md) for complete documentation index.

## 🏗️ Architecture

TweetWeb consists of two main components:

### Frontend (Vue.js)
- **Framework**: Vue 3 with TypeScript
- **State Management**: Pinia stores
- **Routing**: Vue Router
- **UI**: Bootstrap 5 with custom styling
- **Video Player**: Video.js with HLS.js

### Backend (TUS Server)
- **Framework**: Express.js
- **File Upload**: TUS resumable upload protocol
- **Video Processing**: FFmpeg with hardware acceleration
- **IPFS Integration**: Hprose client for Leither service
- **Archive Processing**: ZIP and TAR extraction

## 🎥 Video Features

- **Dual Processing Pipeline**: 
  - **Normalization** (<50MB): Fast MP4 normalization with automatic resolution scaling
  - **HLS Conversion** (>50MB): Adaptive bitrate streaming with multiple quality levels
- **Automatic Selection**: System automatically chooses optimal processing method
- **Adaptive Bitrate**: Multi-quality streaming (720p, 480p) for large videos
- **Hardware Acceleration**: Support for NVIDIA, Intel, Apple, and AMD encoders
- **Smart Encoding**: Intelligent encoder selection based on video properties
- **Resolution Optimization**: Automatic scaling for high-resolution videos

## 📦 File Upload Features

- **Resumable Uploads**: TUS protocol for reliable large file uploads
- **Multiple File Types**: Support for images, videos, documents, and archives
- **IPFS Storage**: All files stored on IPFS for decentralization
- **Progress Tracking**: Real-time upload progress with status polling
- **Concurrent Processing**: Up to 3 concurrent video conversions

## 🔒 Security & Privacy

- **No Central Data Storage**: All content stored on IPFS
- **Peer-to-Peer**: Direct communication between users
- **File Size Limits**: Protection against abuse (4GB for videos, 500MB for archives)
- **Automatic Cleanup**: Temporary files cleaned up after processing
- **No Tracking**: No user tracking or analytics

## 🛠️ Technology Stack

### Frontend
- Vue 3
- TypeScript
- Pinia
- Vue Router
- Bootstrap 5
- Video.js
- HLS.js
- Hprose

### Backend
- Node.js
- Express
- FFmpeg
- TUS Protocol
- AdmZip
- Hprose

### Infrastructure
- IPFS (via Leither)
- WebSocket (for real-time updates)

## 📊 Project Structure

```
TweetWeb/
├── src/                    # Frontend source code
│   ├── components/         # Vue components
│   ├── views/             # Page components
│   ├── stores/            # Pinia stores
│   ├── router/            # Vue Router configuration
│   └── utils/             # Utility functions
├── tus-server/            # Backend server
│   ├── videoRoutes.js     # Video conversion endpoints
│   ├── zipRoutes.js       # ZIP processing endpoints
│   ├── uploadRoutes.js    # File upload endpoints
│   └── app.js             # Main server file
├── docs/                  # Documentation
├── public/                # Static assets
└── dist/                  # Production build

```

## 🤝 Contributing

Contributions are welcome! Please read our contributing guidelines before submitting pull requests.

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🔗 Links

- Production: http://tweet2.fireshare.uk/
- Alternative: http://tweet1.sharefire.store/
- Documentation: [/docs](/docs)

## 🐛 Known Issues

- Video conversion may be slow without hardware acceleration
- Large file uploads require stable internet connection
- Mobile video playback may have compatibility issues on older devices

## 📮 Support

For issues and questions:
- Open an issue on GitHub
- Check the [documentation](docs/)
- Review the [API documentation](docs/API.md)

## 🙏 Acknowledgments

- Vue.js team for the amazing framework
- FFmpeg for video processing capabilities
- IPFS for decentralized storage
- TUS protocol for resumable uploads
