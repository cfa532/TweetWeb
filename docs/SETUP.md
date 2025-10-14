# Setup & Installation Guide

Complete guide to setting up TweetWeb for development and production environments.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Frontend Setup](#frontend-setup)
- [Backend Setup](#backend-setup)
- [FFmpeg Installation](#ffmpeg-installation)
- [Leither Service Setup](#leither-service-setup)
- [Environment Configuration](#environment-configuration)
- [Running the Application](#running-the-application)
- [Production Deployment](#production-deployment)
- [Troubleshooting](#troubleshooting)

## Prerequisites

### Required Software

- **Node.js**: Version 16.x or higher
- **npm**: Version 7.x or higher (comes with Node.js)
- **FFmpeg**: Latest version with codec support
- **Git**: For cloning the repository

### Recommended

- **Hardware Acceleration**: GPU with H.264 encoding support
  - NVIDIA GPU (h264_nvenc)
  - Intel QuickSync (h264_qsv)
  - Apple Silicon/VideoToolbox (h264_videotoolbox)
  - AMD GPU (h264_amf)

### System Requirements

#### Minimum
- 2 CPU cores
- 4GB RAM
- 10GB free disk space
- Internet connection

#### Recommended
- 4+ CPU cores
- 8GB+ RAM
- 50GB+ free disk space (for video processing)
- High-speed internet connection

## Frontend Setup

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/TweetWeb.git
cd TweetWeb
```

### 2. Install Dependencies

```bash
npm install
```

This will install all frontend dependencies including:
- Vue 3
- TypeScript
- Pinia
- Vue Router
- Bootstrap
- Video.js
- HLS.js
- And more...

### 3. Configure Environment

Create a `.env` file in the project root (if needed):

```env
# Optional frontend configuration
VITE_API_BASE_URL=http://localhost:3000
VITE_WS_URL=ws://localhost:3000
```

### 4. Development Server

```bash
npm run dev
```

The frontend will be available at `http://localhost:5173`

### 5. Build for Production

```bash
npm run build
```

Production files will be in the `dist/` directory.

## Backend Setup

### 1. Navigate to TUS Server Directory

```bash
cd tus-server
```

### 2. Install Dependencies

```bash
npm install
```

This will install:
- Express
- express-fileupload
- hprose
- adm-zip
- And other backend dependencies

### 3. Configure Environment

Create a `.env` file in the `tus-server` directory:

```env
# Server Configuration
PORT=3000

# Authorization (optional)
AUTHORIZED_USERNAME=admin

# Network Disk Path (optional)
NET_DISK=/path/to/your/network/disk

# CORS Configuration (optional)
CORS_ORIGIN=http://localhost:5173
```

### 4. Start the Server

```bash
npm start
```

Or for development with auto-restart:

```bash
npm run dev
```

The backend will be available at `http://localhost:3000`

## FFmpeg Installation

FFmpeg is required for video conversion features.

### macOS

#### Using Homebrew (Recommended)

```bash
# Basic installation
brew install ffmpeg

# With additional codecs and hardware acceleration
brew install ffmpeg --with-fdk-aac --with-x265
```

### Ubuntu/Debian

```bash
# Update package list
sudo apt update

# Install FFmpeg
sudo apt install ffmpeg

# Verify installation
ffmpeg -version
```

#### For Hardware Acceleration (Ubuntu)

```bash
# NVIDIA NVENC
sudo apt install ffmpeg nvidia-cuda-toolkit

# Intel QuickSync
sudo apt install ffmpeg intel-media-va-driver-non-free

# AMD AMF
sudo apt install ffmpeg mesa-va-drivers
```

### CentOS/RHEL

```bash
# Enable EPEL repository
sudo yum install epel-release

# Install FFmpeg
sudo yum install ffmpeg ffmpeg-devel

# Verify installation
ffmpeg -version
```

### Windows

1. Download FFmpeg from https://ffmpeg.org/download.html
2. Extract to `C:\ffmpeg`
3. Add `C:\ffmpeg\bin` to system PATH
4. Verify installation in Command Prompt: `ffmpeg -version`

### Verify Hardware Acceleration

Check available encoders:

```bash
# List all encoders
ffmpeg -encoders | grep h264

# Should show:
# h264_nvenc (NVIDIA)
# h264_qsv (Intel)
# h264_videotoolbox (Apple)
# h264_amf (AMD)
```

## Leither Service Setup

Leither is required for IPFS integration.

### 1. Installation

Download and install Leither from the official source.

### 2. Configuration

Configure Leither to run on the expected port (default: varies).

### 3. Verify Connection

The TUS server will automatically detect the Leither service port.

Check logs for:
```
[LEITHER] Detected Leither service on port: XXXX
[LEITHER] Connection established
```

### 4. Troubleshooting Leither

If connection fails:

1. **Check Service Status**:
   ```bash
   # Check if Leither is running
   ps aux | grep leither
   ```

2. **Verify Port**:
   The server uses automatic port detection. Check `leitherDetector.js` for configuration.

3. **Check Firewall**:
   Ensure the Leither port is not blocked by firewall.

## Environment Configuration

### Frontend Environment Variables

Create `.env` in the project root:

```env
# API Configuration
VITE_API_BASE_URL=http://localhost:3000
VITE_WS_URL=ws://localhost:3000

# Feature Flags
VITE_ENABLE_VIDEO_UPLOAD=true
VITE_ENABLE_FILE_SHARING=true

# Upload Limits
VITE_MAX_VIDEO_SIZE=4294967296  # 4GB in bytes
VITE_MAX_FILE_SIZE=524288000     # 500MB in bytes
```

### Backend Environment Variables

Create `.env` in `tus-server/` directory:

```env
# Server Configuration
PORT=3000
NODE_ENV=development

# Authorization
AUTHORIZED_USERNAME=admin
AUTHORIZED_PASSWORD=your_secure_password

# Network Disk
NET_DISK=/path/to/network/disk

# CORS
CORS_ORIGIN=http://localhost:5173,http://localhost:4173

# Upload Configuration
MAX_FILE_SIZE=4294967296  # 4GB
MAX_ZIP_SIZE=524288000     # 500MB
MAX_TAR_SIZE=52428800      # 50MB

# Concurrency
MAX_CONCURRENT_UPLOADS=3
MAX_LEITHER_CONNECTIONS=2

# Timeouts
UPLOAD_TIMEOUT=21600000    # 6 hours
LEITHER_TIMEOUT=14400000   # 4 hours

# Cleanup
TEMP_FILE_CLEANUP_AGE=3600000  # 1 hour
```

## Running the Application

### Development Mode

1. **Start Backend** (Terminal 1):
   ```bash
   cd tus-server
   npm start
   ```

2. **Start Frontend** (Terminal 2):
   ```bash
   npm run dev
   ```

3. **Access Application**:
   Open `http://localhost:5173` in your browser

### Production Mode

1. **Build Frontend**:
   ```bash
   npm run build
   ```

2. **Serve Static Files**:
   Configure backend to serve `dist/` directory or use a web server like nginx.

3. **Start Backend**:
   ```bash
   cd tus-server
   NODE_ENV=production npm start
   ```

## Production Deployment

### Using PM2 (Recommended)

```bash
# Install PM2 globally
npm install -g pm2

# Start backend with PM2
cd tus-server
pm2 start app.js --name "tweetweb-backend"

# Save PM2 configuration
pm2 save

# Setup auto-start on system boot
pm2 startup
```

### Using Docker

Create `Dockerfile` in project root:

```dockerfile
FROM node:16-alpine

# Install FFmpeg
RUN apk add --no-cache ffmpeg

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tus-server/package*.json ./tus-server/

# Install dependencies
RUN npm install
RUN cd tus-server && npm install

# Copy application files
COPY . .

# Build frontend
RUN npm run build

# Expose ports
EXPOSE 3000 5173

# Start application
CMD ["npm", "run", "start:all"]
```

Build and run:

```bash
docker build -t tweetweb .
docker run -p 3000:3000 -p 5173:5173 tweetweb
```

### Using Nginx (Reverse Proxy)

Create `/etc/nginx/sites-available/tweetweb`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Serve frontend
    location / {
        root /path/to/TweetWeb/dist;
        try_files $uri $uri/ /index.html;
    }

    # Proxy API requests
    location /api/ {
        proxy_pass http://localhost:3000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 21600s;  # 6 hours for long uploads
    }

    # WebSocket support
    location /ws/ {
        proxy_pass http://localhost:3000/ws/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }
}
```

Enable and restart:

```bash
sudo ln -s /etc/nginx/sites-available/tweetweb /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

## Troubleshooting

### Common Issues

#### 1. FFmpeg Not Found

**Error**: `ffmpeg: command not found`

**Solution**:
```bash
# Verify FFmpeg installation
which ffmpeg

# If not found, install FFmpeg (see FFmpeg Installation section)
```

#### 2. Port Already in Use

**Error**: `EADDRINUSE: address already in use :::3000`

**Solution**:
```bash
# Find process using port 3000
lsof -i :3000

# Kill the process
kill -9 <PID>

# Or change PORT in .env file
```

#### 3. Leither Connection Failed

**Error**: `[LEITHER] WebSocket connection failed`

**Solution**:
1. Verify Leither service is running
2. Check firewall settings
3. Review port configuration in `leitherDetector.js`

#### 4. Video Upload Fails

**Error**: Various video upload errors

**Solutions**:
- Check FFmpeg installation and codecs
- Verify file size limits
- Check disk space
- Review server logs for specific errors
- Ensure hardware acceleration is configured

#### 5. CORS Errors

**Error**: `Access-Control-Allow-Origin` errors

**Solution**:
Add frontend URL to backend CORS configuration in `tus-server/app.js`:

```javascript
app.use(cors({
  origin: ['http://localhost:5173', 'http://your-frontend-url.com'],
  credentials: true
}));
```

#### 6. Build Errors

**Error**: TypeScript or build errors

**Solution**:
```bash
# Clear node_modules and reinstall
rm -rf node_modules package-lock.json
npm install

# Clear build cache
rm -rf dist .vite

# Rebuild
npm run build
```

### Debug Mode

Enable debug logging:

```bash
# Backend
DEBUG=* npm start

# Or set in .env
NODE_ENV=development
DEBUG=true
```

### Log Files

Check log files for detailed error information:

```bash
# Backend logs (if using PM2)
pm2 logs tweetweb-backend

# System logs
tail -f /var/log/syslog  # Linux
tail -f /var/log/system.log  # macOS
```

## Performance Optimization

### Backend

1. **Enable Clustering**:
   ```javascript
   // In app.js
   const cluster = require('cluster');
   const numCPUs = require('os').cpus().length;

   if (cluster.isMaster) {
     for (let i = 0; i < numCPUs; i++) {
       cluster.fork();
     }
   } else {
     // Start server
   }
   ```

2. **Optimize FFmpeg**:
   - Use hardware acceleration
   - Adjust thread count based on CPU cores
   - Enable caching for encoder detection

3. **Configure Concurrency**:
   ```env
   MAX_CONCURRENT_UPLOADS=<number-of-cpu-cores>
   ```

### Frontend

1. **Code Splitting**: Already configured in Vite
2. **Lazy Loading**: Import components asynchronously
3. **Caching**: Configure service worker for offline support

## Next Steps

- Review [API Documentation](API.md) for endpoint details
- Read [Video Conversion Guide](VIDEO_CONVERSION.md) for video processing
- Check [Architecture Overview](ARCHITECTURE.md) for system design
- Review [Privacy Policy](PRIVACY.md) for data handling

## Support

For additional help:
- Check [GitHub Issues](https://github.com/yourusername/TweetWeb/issues)
- Review [Documentation](README.md)
- Contact support through the application

