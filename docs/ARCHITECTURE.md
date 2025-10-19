# Architecture Overview

System design and architecture documentation for TweetWeb.

## Table of Contents

- [System Overview](#system-overview)
- [High-Level Architecture](#high-level-architecture)
- [Frontend Architecture](#frontend-architecture)
- [Backend Architecture](#backend-architecture)
- [Data Flow](#data-flow)
- [Technology Stack](#technology-stack)
- [Storage Architecture](#storage-architecture)
- [Security Architecture](#security-architecture)
- [Scalability](#scalability)
- [Future Improvements](#future-improvements)

## System Overview

TweetWeb is a decentralized social media platform built on peer-to-peer technologies. The system consists of:

- **Frontend**: Vue.js SPA (Single Page Application)
- **Backend**: Node.js/Express API server
- **Storage**: IPFS for decentralized content storage
- **Media Processing**: FFmpeg for video conversion
- **Communication**: WebSocket for real-time updates

### Key Principles

1. **Decentralization**: No central data storage
2. **Privacy**: User data stored on IPFS
3. **Performance**: Hardware-accelerated video processing
4. **Scalability**: Concurrent job processing
5. **Reliability**: Resumable uploads, retry logic

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Client Layer                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Browser    │  │   Mobile     │  │   Desktop    │      │
│  │   (Vue.js)   │  │   (Future)   │  │   (Future)   │      │
│  └──────┬───────┘  └──────────────┘  └──────────────┘      │
│         │                                                     │
└─────────┼─────────────────────────────────────────────────────┘
          │ HTTP/WebSocket
┌─────────┼─────────────────────────────────────────────────────┐
│         │              API Layer                              │
│  ┌──────▼────────────────────────────────────────────┐       │
│  │           Express.js Backend (Port 3000)           │       │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐       │       │
│  │  │  Video   │  │   ZIP    │  │   File   │       │       │
│  │  │  Routes  │  │  Routes  │  │  Routes  │       │       │
│  │  └──────────┘  └──────────┘  └──────────┘       │       │
│  └────────────────────────────────────────────────────       │
└─────────┬───────────────┬──────────────────┬─────────────────┘
          │               │                  │
┌─────────▼──────┐ ┌──────▼─────────┐ ┌────▼──────────────────┐
│  FFmpeg Video  │ │  Leither/IPFS  │ │  Local File System    │
│  Processing    │ │  Integration   │ │  (Temp Storage)       │
└────────────────┘ └────────────────┘ └───────────────────────┘
                          │
                   ┌──────▼──────┐
                   │  IPFS       │
                   │  Network    │
                   └─────────────┘
```

## Frontend Architecture

### Component Hierarchy

```
App.vue
├── AppHeader.vue
│   ├── CornerMenu.vue
│   └── UserActions.vue
├── MainPage.vue
│   ├── TweetView.vue
│   │   ├── MediaView.vue
│   │   │   ├── Image.vue
│   │   │   ├── VideoJS.vue (HLS Player)
│   │   │   └── pdf.vue
│   │   ├── LinkPreview.vue
│   │   └── UserRow.vue
│   └── EditorModal.vue
│       └── MediaViewerModal.vue
├── UserPage.vue
│   ├── Followers.vue
│   ├── Followings.vue
│   └── TweetDetail.vue
├── DownloadPage.vue
│   ├── DownloadPackage.vue
│   ├── UploadPackage.vue
│   ├── CloudFileList.vue
│   ├── SharedFile.vue
│   └── UploadFile.vue
└── ReqService.vue
```

### State Management (Pinia)

#### Tweet Store (`tweetStore.ts`)

Manages tweet data and operations:

```typescript
interface TweetStore {
  tweets: Tweet[];
  currentUser: User | null;
  
  // Actions
  fetchTweets(): Promise<void>;
  createTweet(content: string, media: MediaFile[]): Promise<void>;
  deleteTweet(tweetId: string): Promise<void>;
  likeTweet(tweetId: string): Promise<void>;
  
  // IPFS Operations
  openTempFile(): Promise<string>;
  uploadToIPFS(data: ArrayBuffer): Promise<string>;
}
```

#### Leither Store (`leitherStore.ts`)

Manages IPFS/Leither connection:

```typescript
interface LeitherStore {
  client: HproseClient | null;
  connected: boolean;
  
  // Actions
  connect(): Promise<void>;
  disconnect(): void;
  ipfsAdd(data: any): Promise<string>;
  ipfsGet(cid: string): Promise<any>;
}
```

#### Alert Store (`alert.store.ts`)

Manages UI notifications:

```typescript
interface AlertStore {
  alerts: Alert[];
  
  // Actions
  success(message: string): void;
  error(message: string): void;
  warning(message: string): void;
  info(message: string): void;
}
```

### Router Configuration

```typescript
// router/index.ts
const routes = [
  { path: '/', component: MainPage },
  { path: '/user/:userId', component: UserPage },
  { path: '/tweet/:tweetId', component: TweetDetail },
  { path: '/download', component: DownloadPage },
  { path: '/services', component: ReqService }
];
```

### Video Player Architecture

```typescript
// VideoJS.vue with HLS.js
┌─────────────────────────────────┐
│     VideoJS Component            │
│  ┌───────────────────────────┐  │
│  │   HLS.js Integration      │  │
│  │   - Master playlist       │  │
│  │   - Quality selection     │  │
│  │   - Adaptive bitrate      │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │   Video.js Player         │  │
│  │   - Controls              │  │
│  │   - Playback              │  │
│  │   - Events                │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

## Backend Architecture

### Service Layer Structure

```
tus-server/
├── app.js                  # Main application + Centralized Leither Management
├── videoRoutes.js          # Video conversion endpoints
├── zipRoutes.js            # ZIP processing endpoints
├── uploadRoutes.js         # File upload endpoints
├── leitherDetector.js      # Leither port detection utility
├── netdisk.js              # Network disk routes
└── uploadedFilesBrowser.js # File browsing
```

### Leither Connection Architecture

The leither connection management follows a centralized architecture pattern:

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Startup                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  app.js - initializeLeither()                      │    │
│  │  ├── Detect Leither port (once)                    │    │
│  │  ├── Test connection                               │    │
│  │  ├── Cache port in memory                          │    │
│  │  └── Set leitherInitialized = true                 │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                Global Connection Pool                       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  leitherConnections Map                             │    │
│  │  ├── Connection 1: {client, isAvailable, port}     │    │
│  │  ├── Connection 2: {client, isAvailable, port}     │    │
│  │  └── Max: 2 connections                             │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                Service Modules                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ videoRoutes  │  │  zipRoutes   │  │ Other Routes │      │
│  │              │  │              │  │              │      │
│  │ global.      │  │ global.      │  │ global.      │      │
│  │ getLeither   │  │ getLeither   │  │ getLeither   │      │
│  │ Connection() │  │ Connection() │  │ Connection() │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

**Key Components**:

1. **Startup Initialization** (`app.js`):
   - Detects Leither port once at startup
   - Tests connection to ensure service is available
   - Caches port information in memory
   - Sets initialization flag

2. **Global Connection Pool**:
   - Shared across all service modules
   - Maximum 2 concurrent connections
   - Connection availability tracking
   - Automatic connection reuse

3. **Service Integration**:
   - All modules use `global.getLeitherConnection()`
   - Consistent connection management
   - Automatic connection release
   - No duplicate port detection

### Video Processing Pipeline

```
┌───────────────────────────────────────────────────────────┐
│                   Video Upload Request                     │
└────────────────┬──────────────────────────────────────────┘
                 │
      ┌──────────▼───────────┐
      │  Generate Job ID      │
      │  Return Immediately   │
      └──────────┬───────────┘
                 │
      ┌──────────▼───────────────────┐
      │  Background Processing        │
      │  ┌───────────────────────┐   │
      │  │ 1. File Validation    │   │
      │  └───────────────────────┘   │
      │  ┌───────────────────────┐   │
      │  │ 2. Video Analysis     │   │
      │  │   (ffprobe)           │   │
      │  └───────────────────────┘   │
      │  ┌───────────────────────┐   │
      │  │ 3. Encoder Detection  │   │
      │  │   & Selection         │   │
      │  └───────────────────────┘   │
      │  ┌───────────────────────┐   │
      │  │ 4. HLS Conversion     │   │
      │  │   (ffmpeg)            │   │
      │  └───────────────────────┘   │
      │  ┌───────────────────────┐   │
      │  │ 5. IPFS Upload        │   │
      │  │   (via Leither)       │   │
      │  └───────────────────────┘   │
      │  ┌───────────────────────┐   │
      │  │ 6. Cleanup            │   │
      │  └───────────────────────┘   │
      └──────────────────────────────┘
                 │
      ┌──────────▼───────────┐
      │  Update Job Status    │
      │  (processingJobs Map) │
      └───────────────────────┘
```

### Concurrency Control

```typescript
// Concurrency management
const maxConcurrentUploads = 3;
const uploadQueue = [];
let activeUploads = 0;

interface QueuedJob {
  req: Request;
  res: Response;
  resolve: Function;
  reject: Function;
}

function processUploadQueue() {
  while (uploadQueue.length > 0 && 
         activeUploads < maxConcurrentUploads) {
    const job = uploadQueue.shift();
    activeUploads++;
    processVideoUpload(job)
      .finally(() => {
        activeUploads--;
        processUploadQueue();
      });
  }
}
```

### Connection Pooling

#### Centralized Leither Connection Management

The leither connection management is centralized in `app.js` and initialized once at startup for optimal performance:

```typescript
// Centralized in app.js - initialized at startup
let leitherConnections = new Map();
let leitherPort = null;
let leitherInitialized = false;
const maxLeitherConnections = 2;

interface LeitherConnection {
  client: HproseClient;
  isAvailable: boolean;
  port: number;
}

// Startup initialization
async function initializeLeither() {
  if (leitherInitialized) return;
  
  try {
    console.log('[LEITHER-INIT] Initializing Leither connection...');
    leitherPort = await getLeitherPort();
    console.log(`[LEITHER-INIT] Detected Leither service on port: ${leitherPort}`);
    
    // Test connection by creating a client
    const testClient = await createLeitherClient(leitherPort);
    if (testClient) {
      console.log('[LEITHER-INIT] Leither connection test successful');
      leitherInitialized = true;
    }
  } catch (error) {
    console.error('[LEITHER-INIT] Failed to initialize Leither connection:', error.message);
    leitherInitialized = false;
  }
}

// Global functions available to all modules
async function getLeitherConnection(): Promise<HproseClient> {
  if (!leitherInitialized || !leitherPort) {
    throw new Error('Leither service not initialized');
  }
  
  const connectionKey = `port-${leitherPort}`;
  
  // Check for available connection
  if (leitherConnections.has(connectionKey)) {
    const connection = leitherConnections.get(connectionKey);
    if (connection.isAvailable) {
      connection.isAvailable = false;
      return connection.client;
    }
  }
  
  // Create new connection if under limit
  if (leitherConnections.size < maxLeitherConnections) {
    const client = await createLeitherClient(leitherPort);
    leitherConnections.set(connectionKey, {
      client,
      isAvailable: false,
      port: leitherPort
    });
    return client;
  }
  
  // Wait for available connection
  return waitForConnection();
}

// Make functions globally available
global.getLeitherConnection = getLeitherConnection;
global.releaseLeitherConnection = releaseLeitherConnection;
global.getCurrentLeitherPort = getCurrentLeitherPort;
global.isLeitherInitialized = isLeitherInitialized;
```

**Benefits of Centralized Management**:
- **Single Port Detection**: Leither port detected once at startup, cached in memory
- **Shared Connection Pool**: All services (video, ZIP) share the same connection pool
- **Better Performance**: No repeated port detection delays during processing
- **Consistent Behavior**: All modules use identical leither connection patterns
- **Easier Maintenance**: Single point of control for leither connection logic

### Job Status Tracking

```typescript
// In-memory job status storage
const processingJobs = new Map<string, JobStatus>();

interface JobStatus {
  status: 'uploading' | 'processing' | 'completed' | 'failed';
  progress: number;  // 0-100
  message: string;
  cid?: string;
  tempDir?: string;
  error?: string;
  startTime: number;
  endTime?: number;
}

// Status updates
processingJobs.set(jobId, {
  status: 'processing',
  progress: 45,
  message: 'Converting video to 720p HLS...',
  startTime: Date.now()
});
```

## Data Flow

### Video Upload Flow

```
┌─────────┐
│ Client  │
└────┬────┘
     │ 1. POST /convert-video (videoFile)
     ▼
┌─────────────┐
│   Backend   │
└─────┬───────┘
      │ 2. Return jobId immediately
      ▼
┌─────────────┐
│   Client    │ 3. Poll /convert-video/status/:jobId
└─────┬───────┘    every 2 seconds
      │
      ▼
┌─────────────────────────────────┐
│   Backend (Background)          │
│   ┌──────────────────────┐      │
│   │ Video Analysis       │      │
│   └──────────────────────┘      │
│   ┌──────────────────────┐      │
│   │ FFmpeg Conversion    │      │
│   └──────────────────────┘      │
│   ┌──────────────────────┐      │
│   │ IPFS Upload          │      │
│   └──────────────────────┘      │
└─────────────┬───────────────────┘
              │ 4. Update job status
              ▼
       ┌──────────────┐
       │ Client Poll  │ 5. Receive CID when complete
       └──────────────┘
```

### Tweet Creation Flow

```
┌─────────┐
│  User   │ 1. Create tweet with media
└────┬────┘
     │
     ▼
┌──────────────┐
│ EditorModal  │ 2. Upload media
└──────┬───────┘
       │ 3. Video → /convert-video
       │ 4. Other files → Direct IPFS
       ▼
┌──────────────┐
│ uploadUtils  │ 5. Handle uploads & polling
└──────┬───────┘
       │ 6. Get CIDs for all media
       ▼
┌──────────────┐
│ TweetStore   │ 7. Create tweet with CIDs
└──────┬───────┘
       │ 8. Store tweet on IPFS
       ▼
┌──────────────┐
│    IPFS      │ 9. Return tweet CID
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  User Feed   │ 10. Display new tweet
└──────────────┘
```

### HLS Playback Flow

```
┌─────────┐
│  User   │ 1. Click play on video
└────┬────┘
     │
     ▼
┌──────────────┐
│  VideoJS     │ 2. Load master playlist
└──────┬───────┘    from IPFS via CID
       │
       ▼
┌──────────────┐
│   HLS.js     │ 3. Parse master playlist
└──────┬───────┘    Select initial quality
       │
       ▼
┌──────────────┐
│  IPFS/CDN    │ 4. Fetch quality playlist
└──────┬───────┘    (720p/playlist.m3u8)
       │
       ▼
┌──────────────┐
│   HLS.js     │ 5. Download segments
└──────┬───────┘    (segment001.ts, ...)
       │
       ▼
┌──────────────┐
│  VideoJS     │ 6. Play video
└──────┬───────┘    Monitor bandwidth
       │ 7. Adaptive switching
       ▼
┌──────────────┐
│  IPFS/CDN    │ 8. Fetch different quality
└──────────────┘    if needed (480p)
```

## Technology Stack

### Frontend Stack

| Technology | Purpose | Version |
|------------|---------|---------|
| Vue.js | UI Framework | 3.x |
| TypeScript | Type Safety | 5.x |
| Pinia | State Management | 2.x |
| Vue Router | Routing | 4.x |
| Bootstrap | UI Components | 5.x |
| Video.js | Video Player | 8.x |
| HLS.js | HLS Support | 1.x |
| Hprose | IPFS Client | Latest |
| Vite | Build Tool | 5.x |

### Backend Stack

| Technology | Purpose | Version |
|------------|---------|---------|
| Node.js | Runtime | 16+ |
| Express | Web Framework | 4.x |
| FFmpeg | Video Processing | Latest |
| express-fileupload | File Uploads | Latest |
| hprose | Leither Client | Latest |
| adm-zip | ZIP Processing | Latest |
| TUS | Resumable Uploads | Protocol |

### Infrastructure

| Component | Technology |
|-----------|------------|
| Storage | IPFS |
| CDN | IPFS Gateway |
| Video Encoding | FFmpeg |
| Hardware Accel | NVENC/QSV/VideoToolbox/AMF |
| WebSocket | Native WebSocket |

## Storage Architecture

### IPFS Storage Model

```
Tweet Object (CID: QmXXX...)
├── content: "Hello world!"
├── timestamp: 1234567890
├── author: QmABC...
├── media: [
│   {
│     type: "video/hls"
│     cid: QmVIDEO...  ──┐
│     isHLSConverted: true
│   }
└──]                     │
                         │
          ┌──────────────┘
          │
          ▼
HLS Content (CID: QmVIDEO...)
├── master.m3u8          # Master playlist
├── 720p/
│   ├── playlist.m3u8    # 720p playlist
│   ├── segment000.ts
│   ├── segment001.ts
│   └── ...
└── 480p/
    ├── playlist.m3u8    # 480p playlist
    ├── segment000.ts
    ├── segment001.ts
    └── ...
```

### Content Addressing

All content is addressed by its cryptographic hash (CID):

```typescript
// CID format (IPFS)
Qm + base58(sha256(content))

// Example
QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG
```

### Storage Lifecycle

1. **Upload**: Content uploaded to IPFS via Leither
2. **Pin**: Content pinned to ensure persistence
3. **Distribute**: Content replicated across IPFS network
4. **Access**: Content retrieved via CID
5. **Cache**: Frequently accessed content cached by gateways

## Security Architecture

### Client-Side Security

1. **Input Validation**
   - File type validation
   - File size limits
   - Content sanitization

2. **XSS Protection**
   - Vue.js automatic escaping
   - CSP headers
   - No innerHTML usage

3. **CSRF Protection**
   - SameSite cookies
   - CORS configuration

### Server-Side Security

1. **File Upload Security**
   ```javascript
   // Size limits
   maxFileSize: 4GB (videos)
   maxFileSize: 500MB (archives)
   
   // Type validation
   allowedVideoTypes: ['video/mp4', 'video/avi', ...]
   allowedArchiveTypes: ['application/zip', 'application/x-tar']
   
   // Path sanitization
   filename = path.basename(filename);
   filename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
   ```

2. **Process Isolation**
   - FFmpeg runs in separate process
   - Resource limits via spawn options
   - Timeout protection

3. **Temporary File Security**
   - Random directory names
   - Automatic cleanup
   - Limited permissions

### IPFS Security

1. **Content Integrity**
   - CID-based addressing ensures content hasn't been tampered
   - Cryptographic hashing

2. **Privacy Considerations**
   - Content is public by default
   - Users should understand IPFS is a public network
   - Sensitive data should not be uploaded

## Scalability

### Horizontal Scaling

```
                    Load Balancer
                         │
        ┌────────────────┼────────────────┐
        │                │                │
     Server 1         Server 2         Server 3
        │                │                │
        └────────────────┼────────────────┘
                         │
                    Shared IPFS
```

### Vertical Scaling

- Increase CPU cores for concurrent processing
- Add GPU for hardware acceleration
- Increase RAM for larger video processing
- Add SSD for faster temporary storage

### Performance Optimizations

1. **Caching**
   - Encoder detection cache (5 min)
   - **Leither port cache** (startup initialization)
   - IPFS content cache
   - Static asset caching

2. **Concurrency**
   - Parallel video conversion (max 3)
   - **Centralized Leither connection pooling** (max 2 connections)
   - Async I/O operations

3. **Resource Management**
   - Memory limits on FFmpeg buffers
   - Cleanup of old temp files
   - Queue management
   - **Shared connection pool** across all services

4. **Leither Connection Optimization**
   - **Single port detection** at startup (vs. per-request detection)
   - **Connection reuse** across video and ZIP processing
   - **Reduced connection overhead** (no repeated port scanning)
   - **Faster service startup** (cached port information)

### Bottlenecks

| Component | Bottleneck | Mitigation |
|-----------|------------|------------|
| Video Conversion | CPU/GPU | Hardware acceleration, queue |
| IPFS Upload | Network bandwidth | Compression, chunking |
| Concurrent Users | Server capacity | Load balancing |
| Storage | Disk space | Automatic cleanup |

## Future Improvements

### Short Term

1. **Webhooks**: Eliminate polling with webhooks
2. **Batch Processing**: Process multiple videos in batches
3. **Thumbnails**: Generate video thumbnails
4. **Progress Websockets**: Real-time progress via WebSocket

### Medium Term

1. **Live Streaming**: Support for live video streaming
2. **CDN Integration**: Integrate with IPFS CDN services
3. **Distributed Processing**: Multiple encoding servers
4. **Advanced Analytics**: Video view statistics

### Long Term

1. **Mobile Apps**: Native iOS/Android apps
2. **P2P Streaming**: Direct peer-to-peer video streaming
3. **Blockchain Integration**: Content ownership on blockchain
4. **AI Features**: Automatic content moderation, tagging

## Monitoring & Observability

### Logging

```javascript
// Structured logging
console.log(`[${timestamp}] [${jobId}] [${level}] ${message}`);

// Example
[2024-01-01T12:00:00] [abc123] [INFO] Video conversion started
[2024-01-01T12:05:00] [abc123] [SUCCESS] IPFS upload completed
```

### Metrics

- Active conversions
- Queue length
- Average conversion time
- Success/failure rate
- IPFS upload time
- Storage usage

### Health Checks

```javascript
// Health check endpoint
GET /health

Response:
{
  status: 'ok',
  uptime: 3600,
  activeJobs: 2,
  queueLength: 5,
  leitherConnected: true
}
```

## Deployment Architecture

### Development

```
┌─────────────┐     ┌─────────────┐
│  Frontend   │     │   Backend   │
│  (Vite Dev) │────▶│ (Node.js)   │
│  Port 5173  │     │  Port 3000  │
└─────────────┘     └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   Leither   │
                    │    IPFS     │
                    └─────────────┘
```

### Production

```
┌──────────────────┐
│   Nginx          │ SSL, Static Files
│   Port 80/443    │
└────────┬─────────┘
         │
    ┌────┴────┐
    │         │
┌───▼───┐  ┌─▼────────┐
│Static │  │ Backend  │
│Files  │  │ (PM2)    │
│(dist/)│  │Port 3000 │
└───────┘  └──┬───────┘
              │
       ┌──────▼──────┐
       │   Leither   │
       │    IPFS     │
       └─────────────┘
```

## Related Documentation

- [Setup Guide](SETUP.md) - Installation and configuration
- [API Documentation](API.md) - API endpoints
- [Video Conversion](VIDEO_CONVERSION.md) - Video processing details
- [Privacy Policy](PRIVACY.md) - Privacy and data handling

