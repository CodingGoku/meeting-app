const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { createHmac } = require('crypto');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Store rooms with participant details
const rooms = new Map(); // roomId -> Map of participantId -> participant
const reactions = new Set(['👍', '👏', '❤️', '🎉', '😂', '😮']);
const activityCooldowns = { 'chat-message': 400, reaction: 650, 'hand-raised': 250 };
const maxChatLength = 500;
const maxBufferedBytes = 64 * 1024;
const turnCredentialLifetime = 6 * 60 * 60;
const turnConfig = readTurnConfig(process.env);

function readTurnConfig({ TURN_URLS, TURN_SECRET, TURN_USERNAME, TURN_CREDENTIAL }) {
    if (!TURN_URLS && !TURN_SECRET && !TURN_USERNAME && !TURN_CREDENTIAL) {
        // Open Relay publishes these static-auth settings for shared use.
        return {
            urls: [
                'turn:staticauth.openrelay.metered.ca:80?transport=udp',
                'turn:staticauth.openrelay.metered.ca:443?transport=udp',
                'turn:staticauth.openrelay.metered.ca:443?transport=tcp'
            ],
            secret: 'openrelayprojectsecret'
        };
    }

    const urls = TURN_URLS?.split(',').map(url => url.trim());
    const urlPattern = /^turns?:(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?(?:\?transport=(?:udp|tcp))?$/i;
    if (!urls?.length || !urls.every(url => {
        const match = url.match(urlPattern);
        return match && (!match[1] || (Number(match[1]) > 0 && Number(match[1]) <= 65535));
    })) {
        console.warn('TURN is disabled. Set TURN_URLS to valid comma-separated TURN URLs.');
        return;
    }
    if (TURN_SECRET) return { urls, secret: TURN_SECRET };
    if (TURN_USERNAME && TURN_CREDENTIAL) return { urls, username: TURN_USERNAME, credential: TURN_CREDENTIAL };

    console.warn('TURN is disabled. Set TURN_SECRET or both TURN_USERNAME and TURN_CREDENTIAL.');
}

function getIceServers(participantId) {
    if (!turnConfig) return;
    const { urls, secret, username, credential } = turnConfig;
    if (!secret) return [{ urls, username, credential }];

    const expiresAt = Math.floor(Date.now() / 1000) + turnCredentialLifetime;
    const temporaryUsername = `${expiresAt}:${participantId}`;
    const temporaryCredential = createHmac('sha1', secret).update(temporaryUsername).digest('base64');
    return [{ urls, username: temporaryUsername, credential: temporaryCredential }];
}

function parseMediaState(value) {
    if (typeof value?.camera !== 'boolean' || typeof value.mic !== 'boolean' || typeof value.sharing !== 'boolean') return;
    return { camera: value.camera, mic: value.mic, sharing: value.sharing };
}

// Serve static files from 'public' folder
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        activeRooms: rooms.size,
        totalParticipants: Array.from(rooms.values()).reduce((sum, room) => sum + room.size, 0)
    });
});

// Simple test endpoint
app.get('/test', (req, res) => {
    res.send('Server is working!');
});

// Stats endpoint
app.get('/stats', (req, res) => {
    const stats = {
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        activeRooms: rooms.size,
        participants: Array.from(rooms.entries()).map(([roomId, room]) => ({
            roomId,
            participantCount: room.size,
            participants: Array.from(room.values()).map(p => ({ userId: p.userId, userName: p.userName }))
        }))
    };
    res.json(stats);
});

// Create WebSocket server with enhanced configuration
const wss = new WebSocket.Server({ 
    server,
    // Handle connection upgrades properly
    handleProtocols: (protocols, request) => {
        return protocols[0] || false;
    },
    // Maximum message size (1MB)
    maxPayload: 1024 * 1024
});

console.log('WebSocket server created successfully');

const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (ws.isAlive) {
            ws.isAlive = false;
            ws.ping();
        } else {
            ws.terminate();
        }
    }
}, 25000);
heartbeat.unref();
wss.on('close', () => clearInterval(heartbeat));

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    const participantId = uuidv4();
    let currentRoomId = null;
    const connectionTime = new Date();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    console.log(`[${new Date().toISOString()}] New WebSocket connection: ${participantId} from ${req.socket.remoteAddress}`);

    // Send initial connection confirmation
    ws.send(JSON.stringify({
        type: 'connection-established',
        participantId: participantId,
        timestamp: connectionTime.toISOString()
    }));

    // Handle incoming messages
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());

            switch (data.type) {
                case 'join-room':
                    if (!currentRoomId && handleJoinRoom(ws, participantId, data)) {
                        currentRoomId = data.roomId;
                    }
                    break;
                    
                case 'offer':
                case 'answer':
                case 'ice-candidate':
                    forwardToParticipant(participantId, data, currentRoomId);
                    break;

                case 'chat-message':
                case 'reaction':
                case 'hand-raised':
                case 'media-state':
                    broadcastRoomActivity(participantId, data, currentRoomId);
                    break;
                    
                case 'leave-room':
                    handleLeaveRoom(participantId, currentRoomId);
                    currentRoomId = null;
                    break;
                    
                case 'ping':
                    // Respond to keep-alive pings
                    ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
                    break;
                    
                default:
                    console.log('Unknown message type:', data.type);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: `Unknown message type: ${data.type}`
                    }));
            }
        } catch (error) {
            console.error('Error processing message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Failed to process message'
            }));
        }
    });

    // Handle WebSocket close
    ws.on('close', (code, reason) => {
        console.log(`[${new Date().toISOString()}] WebSocket closed: ${participantId} - Code: ${code}, Reason: ${reason || 'No reason provided'}`);
        if (currentRoomId) {
            handleLeaveRoom(participantId, currentRoomId);
        }
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
        console.error(`[${new Date().toISOString()}] WebSocket error for ${participantId}:`, error.message);
    });
});

function handleJoinRoom(ws, participantId, data) {
    try {
        const { roomId, userId, userName, connectionKey } = data;
        
        if (typeof roomId !== 'string' || !roomId.trim() || roomId.length > 128 ||
            typeof userId !== 'string' || !userId.trim() || userId.length > 128 ||
            (userName != null && (typeof userName !== 'string' || userName.length > 80)) ||
            (connectionKey != null && (typeof connectionKey !== 'string' || connectionKey.length > 64))) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid join data'
            }));
            return false;
        }

        const participantName = userName?.trim() || `User ${userId.slice(0, 4)}`;
        const media = parseMediaState(data.media);
        // Create room if it doesn't exist
        if (!rooms.has(roomId)) {
            rooms.set(roomId, new Map());
            console.log(`[${new Date().toISOString()}] Created new room: ${roomId} by ${userName || userId}`);
        }
        
        const room = rooms.get(roomId);
        
        // Keep a live participant's identity bound to their socket.
        for (const [pid, participant] of room.entries()) {
            if (participant.userId === userId) {
                const active = participant.ws.readyState === WebSocket.OPEN;
                if (active && (!connectionKey || participant.connectionKey !== connectionKey)) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'This participant is already in the meeting'
                    }));
                    return false;
                }
                removeParticipant(room, pid);
                if (active) participant.ws.close(4001, 'Connection replaced');
                break;
            }
        }
        
        // Add new participant
        room.set(participantId, { 
            ws, 
            userId, 
            userName: participantName,
            connectionKey,
            raised: false,
            media,
            lastActivity: {},
            joinedAt: new Date().toISOString()
        });
        
        // Notify existing participants about new user
        const newUserInfo = {
            type: 'user-joined',
            participantId: participantId,
            userId: userId,
            userName: participantName,
            raised: false,
            media
        };
        
        for (const [pid, participant] of room.entries()) {
            if (pid !== participantId && participant.ws.readyState === WebSocket.OPEN) {
                try {
                    participant.ws.send(JSON.stringify(newUserInfo));
                } catch (err) {
                    console.error('Error notifying participant:', err);
                }
            }
        }
        
        // Send existing participants to new user
        const existingParticipants = [];
        for (const [pid, participant] of room.entries()) {
            if (pid !== participantId) {
                existingParticipants.push({ 
                    participantId: pid, 
                    userId: participant.userId,
                    userName: participant.userName,
                    raised: participant.raised,
                    media: participant.media
                });
            }
        }
        
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'existing-participants',
                participants: existingParticipants,
                iceServers: getIceServers(participantId),
                yourInfo: {
                    userId: userId,
                    userName: participantName,
                    raised: false,
                    media
                }
            }));
        }
        
        console.log(`[${new Date().toISOString()}] User ${userName || userId} joined room ${roomId}. Total participants: ${room.size}`);
        return true;
        
    } catch (error) {
        console.error('Error in handleJoinRoom:', error);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Failed to join room'
            }));
        }
        return false;
    }
}

function removeParticipant(room, participantId) {
    const participant = room.get(participantId);
    if (!participant) return;

    room.delete(participantId);
    const payload = JSON.stringify({
        type: 'user-left',
        userId: participant.userId,
        userName: participant.userName
    });
    for (const member of room.values()) {
        if (member.ws.readyState === WebSocket.OPEN) {
            try {
                member.ws.send(payload);
            } catch (error) {
                console.error('Error notifying about leave:', error);
            }
        }
    }
    return participant;
}

function handleLeaveRoom(participantId, roomId) {
    try {
        const room = rooms.get(roomId);
        if (!room) return;

        const participant = removeParticipant(room, participantId);
        if (!participant) return;
        console.log(`[${new Date().toISOString()}] User ${participant.userName || participant.userId} left room ${roomId}. Remaining: ${room.size}`);
        
        // Delete empty rooms after 30 seconds (to allow for reconnections)
        if (room.size === 0) {
            setTimeout(() => {
                if (rooms.get(roomId) === room && room.size === 0) {
                    rooms.delete(roomId);
                    console.log(`[${new Date().toISOString()}] Deleted empty room: ${roomId}`);
                }
            }, 30000);
        }
        
    } catch (error) {
        console.error('Error in handleLeaveRoom:', error);
    }
}

function broadcastRoomActivity(participantId, data, roomId) {
    const room = rooms.get(roomId);
    const sender = room?.get(participantId);
    if (!sender) return;

    const { type } = data;
    const now = Date.now();
    const cooldown = activityCooldowns[type];
    if (cooldown && now - (sender.lastActivity[type] ?? 0) < cooldown) return;

    const message = { type, userId: sender.userId, userName: sender.userName };
    switch (type) {
        case 'chat-message': {
            if (typeof data.text !== 'string' || data.text.length > maxChatLength) return;
            const text = data.text.trim();
            if (!text) return;
            message.text = text;
            message.timestamp = new Date(now).toISOString();
            break;
        }
        case 'reaction':
            if (!reactions.has(data.reaction)) return;
            message.reaction = data.reaction;
            break;
        case 'hand-raised':
            if (typeof data.raised !== 'boolean' || sender.raised === data.raised) return;
            sender.raised = data.raised;
            message.raised = sender.raised;
            break;
        case 'media-state': {
            const media = parseMediaState(data);
            if (!media || (sender.media?.camera === media.camera &&
                sender.media.mic === media.mic && sender.media.sharing === media.sharing)) return;
            sender.media = media;
            message.media = media;
            break;
        }
    }

    sender.lastActivity[type] = now;
    const payload = JSON.stringify(message);
    for (const participant of room.values()) {
        if (participant.ws.readyState === WebSocket.OPEN && participant.ws.bufferedAmount < maxBufferedBytes) {
            participant.ws.send(payload);
        }
    }
}

function forwardToParticipant(participantId, data, roomId) {
    try {
        const room = rooms.get(roomId);
        const sender = room?.get(participantId);
        if (!sender) return;

        for (const [targetId, participant] of room.entries()) {
            if (participant.userId !== data.to) continue;
            if (data.toParticipantId != null && data.toParticipantId !== targetId) return;
            if (participant.ws.readyState !== WebSocket.OPEN) break;

            participant.ws.send(JSON.stringify({
                type: data.type,
                from: sender.userId,
                fromName: sender.userName,
                fromParticipantId: participantId,
                data: data.data
            }));
            return;
        }
        console.log(`Target ${data.to} not found or not connected in room ${roomId}`);
        
    } catch (error) {
        console.error('Error in forwardToParticipant:', error);
    }
}

// Cleanup inactive connections periodically
setInterval(() => {
    const now = new Date();
    for (const [roomId, room] of rooms.entries()) {
        for (const [participantId, participant] of room.entries()) {
            if (participant.ws.readyState !== WebSocket.OPEN) {
                console.log(`Cleaning up inactive participant ${participantId} in room ${roomId}`);
                room.delete(participantId);
            }
        }
        
        if (room.size === 0) {
            rooms.delete(roomId);
            console.log(`Cleaned up empty room: ${roomId}`);
        }
    }
}, 60000); // Run every minute

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        // Close all WebSocket connections
        wss.clients.forEach((client) => {
            client.close();
        });
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

// Error handling for uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Don't crash - keep the server running
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔═══════════════════════════════════════════════════════════════════╗
    ║                                                                   ║
    ║   🚀  MEETSTREAM PRO - WebRTC Meeting Server                      ║
    ║   ═══════════════════════════════════════════════════════════     ║
    ║                                                                   ║
    ║   📡  Server Information:                                         ║
    ║   • Port: ${PORT}                                                      ║
    ║   • Environment: ${process.env.NODE_ENV || 'development'}                                   ║
    ║   • Node Version: ${process.version}                                        ║
    ║                                                                   ║
    ║   🌐  Access URLs:                                                 ║
    ║   • Local:    http://localhost:${PORT}                                 ║
    ║   • WebSocket: ws://localhost:${PORT}                                  ║
    ║   • Health:   http://localhost:${PORT}/health                          ║
    ║                                                                   ║
    ║   📁  Static Files:                                               ║
    ║   • Public folder: ${publicPath}                                         ║
    ║   • index.html exists: ${fs.existsSync(path.join(publicPath, 'index.html'))}                       ║
    ║                                                                   ║
    ║   💡  Features:                                                   ║
    ║   • WebRTC Peer-to-Peer connections                               ║
    ║   • Room-based meetings with codes                                ║
    ║   • Screen sharing support                                        ║
    ║   • Participant names and tracking                                ║
    ║   • Automatic room cleanup                                        ║
    ║                                                                   ║
    ║   ✅  Server is ready and waiting for connections!                ║
    ║                                                                   ║
    ╚═══════════════════════════════════════════════════════════════════╝
    `);
});

// Export for testing purposes
module.exports = { app, server, wss, rooms };
