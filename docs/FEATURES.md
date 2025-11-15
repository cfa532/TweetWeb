# TweetWeb Features Documentation

Comprehensive documentation of all major features in TweetWeb.

## Table of Contents

- [Overview](#overview)
- [Core Features](#core-features)
- [Video Features](#video-features)
- [File Management](#file-management)
- [Social Features](#social-features)
- [Storage Features](#storage-features)
- [UI/UX Features](#uiux-features)
- [Technical Features](#technical-features)

## Overview

TweetWeb is a decentralized social media platform built on IPFS, featuring:

- **Decentralized Architecture**: No central servers, all content on IPFS
- **Video Streaming**: Automatic video processing with multiple quality options
- **File Sharing**: Secure file upload and sharing
- **Social Network**: Tweet, follow, and interact with users
- **Privacy-Focused**: User data stored on IPFS, not centralized servers

## Core Features

### Decentralized Architecture

- **IPFS Storage**: All content stored on IPFS network
- **No Central Servers**: No single point of failure
- **Peer-to-Peer**: Direct communication between users
- **Distributed**: Content replicated across IPFS network

### Authentication & User Management

- **User Profiles**: Customizable user profiles
- **Follow System**: Follow/unfollow other users
- **User Discovery**: Find and connect with other users
- **User Pages**: Dedicated pages for each user

### Content Creation

- **Tweet Creation**: Create text-based posts
- **Media Attachments**: Attach images, videos, documents
- **Rich Text**: Format text with markdown
- **Private Posts**: Create private posts visible only to you
- **Downloadable Content**: Control whether attachments are downloadable

## Video Features

### Video Processing

TweetWeb provides two video processing pipelines:

#### 1. Video Normalization (<50MB)

**Purpose**: Fast MP4 normalization for small videos

**Features**:
- Automatic format normalization to MP4
- Smart resolution scaling (>720p → max 720p)
- Original resolution preserved for ≤720p videos
- Direct IPFS upload
- Fast processing (seconds to minutes)

**Use Cases**:
- Short video clips
- Mobile videos
- Quick uploads
- Simple video sharing

**Documentation**: [Video Normalization Guide](VIDEO_NORMALIZATION.md)

#### 2. Video Conversion (>50MB)

**Purpose**: HLS streaming for large videos

**Features**:
- HLS (HTTP Live Streaming) format
- Adaptive bitrate streaming
- Multiple quality levels (720p, 480p)
- Hardware acceleration support
- Progress tracking
- Status polling

**Use Cases**:
- Long-form content
- High-quality videos
- Professional content
- Streaming optimization

**Documentation**: [Video Conversion Guide](VIDEO_CONVERSION.md)

### Video Player

- **HLS Support**: Native HLS playback with Video.js
- **Adaptive Quality**: Automatic quality selection based on bandwidth
- **Manual Quality Control**: Users can select quality level
- **Progress Tracking**: Video playback progress
- **Aspect Ratio Detection**: Automatic aspect ratio handling
- **Mobile-Friendly**: Responsive video player

### Video Optimization

- **Hardware Acceleration**: Support for NVIDIA, Intel, Apple, AMD encoders
- **Smart Encoding**: Intelligent encoder selection
- **Copy Mode**: Fast copy for compatible videos
- **Aspect Ratio Preservation**: Maintains original video proportions
- **Quality Control**: CRF/CQ values for quality/size balance

## File Management

### File Upload

- **Multiple Formats**: Images, videos, documents, archives
- **Resumable Uploads**: TUS protocol for reliable uploads
- **Progress Tracking**: Real-time upload progress
- **Pause/Resume**: Pause and resume uploads
- **Large File Support**: Up to 4GB for videos
- **Drag & Drop**: Easy file selection

### File Types

#### Images
- **Supported Formats**: JPEG, PNG, GIF, WebP, BMP, SVG
- **Automatic Compression**: Images compressed to <2MB
- **Aspect Ratio Detection**: Automatic aspect ratio calculation
- **Preview**: Image preview before upload

#### Videos
- **Supported Formats**: MP4, AVI, MOV, MKV, WebM, WMV, FLV, M4V, 3GP, OGV
- **Automatic Processing**: Normalization or HLS conversion
- **Multiple Quality Levels**: Adaptive streaming support
- **Thumbnail Generation**: Video thumbnails

#### Documents
- **Supported Formats**: PDF, DOC, DOCX, TXT, etc.
- **Preview**: PDF preview in browser
- **Download**: Direct download support

#### Archives
- **Supported Formats**: ZIP, TAR, TAR.GZ
- **Automatic Extraction**: Extract and process archive contents
- **HLS Processing**: ZIP files containing HLS content automatically processed

### File Organization

- **Cloud File List**: Browse uploaded files
- **Shared Files**: Access shared files from other users
- **Download Packages**: Organize files into downloadable packages
- **File Metadata**: File size, type, upload date
- **CID Access**: Direct IPFS CID access

## Social Features

### Tweets

- **Create Tweets**: Text-based posts with media
- **View Feed**: Chronological feed of tweets
- **Tweet Details**: Detailed view of individual tweets
- **Like/Unlike**: Like and unlike tweets
- **Bookmark**: Save tweets for later
- **Reply**: Reply to tweets (future feature)
- **Share**: Share tweets (future feature)

### User Interactions

- **Follow/Unfollow**: Follow and unfollow users
- **Followers List**: View user's followers
- **Followings List**: View users you follow
- **User Profiles**: View user information and posts
- **User Search**: Find users (future feature)

### Privacy

- **Private Posts**: Create posts visible only to you
- **Downloadable Control**: Control whether content is downloadable
- **IPFS Privacy**: Content stored on IPFS, not centralized servers
- **No Tracking**: No user tracking or analytics

## Storage Features

### IPFS Integration

- **Leither Service**: IPFS integration via Leither
- **CID Generation**: Content Identifiers for all files
- **Distributed Storage**: Content replicated across network
- **Direct Access**: Access content via IPFS CID
- **Persistence**: Content persists on IPFS network

### Network Disk

- **File Browser**: Browse files on network disk
- **File Access**: Access files via `/netd/*` endpoints
- **File Sharing**: Share files with other users
- **Storage Management**: Manage storage usage

### File Registration

- **TUS Integration**: Register TUS-uploaded files
- **Metadata Storage**: Store file metadata
- **Access Control**: Control file access (future feature)

## UI/UX Features

### User Interface

- **Responsive Design**: Works on desktop, tablet, mobile
- **Bootstrap 5**: Modern UI framework
- **Custom Styling**: Branded appearance
- **Dark Mode** (future feature)

### User Experience

- **Drag & Drop**: Easy file upload via drag & drop
- **Paste Support**: Paste files from clipboard
- **Progress Indicators**: Real-time progress for all operations
- **Loading States**: Visual feedback during operations
- **Error Handling**: User-friendly error messages
- **Toast Notifications**: Success/error notifications

### Components

- **Editor Modal**: Rich tweet editor with media support
- **Media Viewer**: Full-screen media viewer
- **Video Player**: HLS video player with quality controls
- **Image Preview**: Image preview with zoom
- **Link Preview**: Automatic link preview generation
- **QR Code**: QR code generation for sharing

## Technical Features

### Backend Architecture

- **Express.js**: RESTful API server
- **TUS Protocol**: Resumable file uploads
- **FFmpeg Integration**: Video processing
- **Leither Integration**: IPFS access
- **Concurrent Processing**: Multiple simultaneous operations
- **Queue Management**: Job queue for video processing

### Frontend Architecture

- **Vue 3**: Modern reactive framework
- **TypeScript**: Type-safe development
- **Pinia**: State management
- **Vue Router**: Client-side routing
- **Composition API**: Modern Vue patterns

### Performance

- **Hardware Acceleration**: GPU-based video encoding
- **Concurrent Processing**: Up to 3 simultaneous conversions
- **Progress Tracking**: Real-time progress updates
- **Efficient Encoding**: Smart encoder selection
- **Optimized Storage**: Efficient file organization

### Reliability

- **Resumable Uploads**: Resume failed uploads
- **Retry Logic**: Automatic retry for failed operations
- **Error Recovery**: Graceful error handling
- **Status Polling**: Track operation status
- **Timeout Handling**: Proper timeout management

### Security

- **File Validation**: Validate file types and sizes
- **Size Limits**: Prevent abuse with size limits
- **Input Sanitization**: Sanitize user inputs
- **CORS Configuration**: Proper CORS setup
- **No Central Data**: No sensitive data on servers

## Feature Comparison

### Video Processing

| Feature | Normalization | HLS Conversion |
|---------|--------------|----------------|
| **File Size** | ≤ 50MB | ≤ 4GB |
| **Output Format** | MP4 | HLS (M3U8 + TS) |
| **Quality Levels** | Single | Multiple (720p, 480p) |
| **Processing Time** | Fast (seconds) | Slower (minutes) |
| **Adaptive Streaming** | ❌ | ✅ |
| **Use Case** | Quick uploads | Professional content |

### File Upload

| Feature | TUS Upload | Direct Upload |
|---------|-----------|---------------|
| **Resumable** | ✅ | ❌ |
| **Progress** | ✅ | ✅ |
| **Large Files** | ✅ | Limited |
| **Pause/Resume** | ✅ | ❌ |
| **Use Case** | Large files | Small files |

## Future Features

### Planned Features

- **Live Streaming**: Real-time video streaming
- **Audio Support**: Audio file processing and playback
- **Comments**: Comment system for tweets
- **Notifications**: Push notifications for interactions
- **Search**: Full-text search for tweets
- **Hashtags**: Hashtag support and trending
- **Mentions**: @mention support
- **Direct Messages**: Private messaging between users
- **Groups**: Group functionality
- **Themes**: Custom themes and dark mode

### Roadmap

1. **Phase 1** (Current): Core features
   - ✅ Tweet creation
   - ✅ Video processing
   - ✅ File upload
   - ✅ User profiles
   - ✅ Follow system

2. **Phase 2** (Next): Enhanced social
   - Comments
   - Notifications
   - Search
   - Hashtags

3. **Phase 3** (Future): Advanced features
   - Live streaming
   - Direct messages
   - Groups
   - Mobile apps

## Feature Usage Guide

### For Users

**Uploading a Video**:
1. Click "Files" button in tweet editor
2. Select or drag & drop video file
3. System automatically selects normalization (<50MB) or HLS conversion (>50MB)
4. Wait for processing to complete
5. Video is automatically attached to tweet

**Sharing Files**:
1. Upload file via Upload File page
2. File is stored on IPFS
3. Share CID with others
4. Others can access file via CID

**Following Users**:
1. Visit user's profile page
2. Click "Follow" button
3. User's tweets appear in your feed

### For Developers

**Video Normalization**:
```javascript
import { normalizeVideo } from '@/utils/uploadUtils';

const cid = await normalizeVideo(file, baseUrl, cloudDrivePort, onProgress);
```

**Video Conversion**:
```javascript
import { uploadVideo } from '@/utils/uploadUtils';

const cid = await uploadVideo(file, baseUrl, cloudDrivePort, onProgress, noResample);
```

**File Upload**:
```javascript
// TUS upload
const mid = await uploadFileWithTus(file, index);

// Direct IPFS upload
const fsid = await tweetStore.openTempFile();
const cid = await readFileSlice(fsid, await file.arrayBuffer(), 0, index);
```

## Related Documentation

- [API Documentation](API.md) - Complete API reference
- [Video Normalization Guide](VIDEO_NORMALIZATION.md) - Small video processing
- [Video Conversion Guide](VIDEO_CONVERSION.md) - Large video processing
- [Architecture Overview](ARCHITECTURE.md) - System architecture
- [Setup Guide](SETUP.md) - Installation and setup

