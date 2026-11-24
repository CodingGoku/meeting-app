const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { createHmac } = require('crypto');
const { createRelayState, requestMediaRelay, forwardRelayPacket, removeRelayPeer } = require('./media-relay');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Store rooms with participant details
const rooms = new Map(); // roomId -> Map of participantId -> participant
const reactions = new Set(['👍', '👏', '❤️', '🎉', '😂', '😮']);
const activityCooldowns = { 'chat-message': 400, reaction: 650, 'hand-raised': 250 };
const maxChatLength = 500;
const maxBufferedBytes = 64 * 1024;
const reconnectGraceMs = 15000;
const mediaBindTimeoutMs = 4000;
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
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    if (req.url?.split('?')[0] === '/media') {
        handleMediaSocket(ws);
        return;
    }

    let participantId = uuidv4();
    let currentRoomId = null;
    const connectionTime = new Date();

    console.log(`[${new Date().toISOString()}] New WebSocket connection: ${participantId} from ${req.socket.remoteAddress}`);

    // Send initial connection confirmation
    ws.send(JSON.stringify({
        type: 'connection-established',
        participantId: participantId,
        timestamp: connectionTime.toISOString()
    }));

    // Handle incoming messages
    ws.on('message', (message, isBinary) => {
        try {
            const room = rooms.get(currentRoomId);
            if (currentRoomId && room?.get(participantId)?.ws !== ws) return;
            if (isBinary) {
                forwardRelayPacket(room, participantId, message);
                return;
            }
            const data = JSON.parse(message.toString());

            switch (data.type) {
                case 'join-room': {
                    if (currentRoomId) break;
                    const joinedId = handleJoinRoom(ws, participantId, data);
                    if (joinedId) {
                        participantId = joinedId;
                        currentRoomId = data.roomId;
                    }
                    break;
                }
                    
                case 'offer':
                case 'answer':
                case 'ice-candidate':
                    forwardToParticipant(participantId, data, currentRoomId);
                    break;

                case 'relay-preference':
                    if (typeof data.data?.directReady === 'boolean') {
                        forwardToParticipant(participantId, data, currentRoomId);
                    }
                    break;

                case 'relay-request':
                    requestMediaRelay(room, participantId, data.toParticipantId);
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
        const participant = rooms.get(currentRoomId)?.get(participantId);
        if (participant?.ws !== ws) return;
        if (!participant.connectionKey) {
            handleLeaveRoom(participantId, currentRoomId);
            return;
        }
        participant.disconnectTimer = setTimeout(() => {
            if (rooms.get(currentRoomId)?.get(participantId)?.ws === ws) {
                handleLeaveRoom(participantId, currentRoomId);
            }
        }, reconnectGraceMs);
        participant.disconnectTimer.unref?.();
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
        console.error(`[${new Date().toISOString()}] WebSocket error for ${participantId}:`, error.message);
    });
});

function handleMediaSocket(ws) {
    let roomId;
    let participantId;
    const timeout = setTimeout(() => ws.close(1008, 'Media authentication timeout'), mediaBindTimeoutMs);
    timeout.unref?.();

    ws.on('message', (message, isBinary) => {
        if (participantId) {
            const room = rooms.get(roomId);
            if (isBinary && room?.get(participantId)?.mediaSocket === ws) {
                forwardRelayPacket(room, participantId, message);
            }
            return;
        }
        try {
            if (isBinary || message.length > 1024 || ws.readyState !== WebSocket.OPEN) {
                ws.close(1008, 'Media authentication required');
                return;
            }
            const data = JSON.parse(message.toString());
            const room = rooms.get(data?.roomId);
            if (data?.type === 'bind-media' && typeof data.userId === 'string' &&
                typeof data.connectionKey === 'string' && data.connectionKey) {
                for (const [id, member] of room ?? []) {
                    if (!member.relay || member.userId !== data.userId || member.connectionKey !== data.connectionKey) continue;
                    const replaced = member.mediaSocket;
                    member.mediaSocket = ws;
                    roomId = data.roomId;
                    participantId = id;
                    clearTimeout(timeout);
                    replaced?.close(4001, 'Media connection replaced');
                    ws.send(JSON.stringify({ type: 'media-ready' }));
                    return;
                }
            }
        } catch {
            // Invalid media authentication is handled identically to a rejected key.
        }
        ws.close(1008, 'Media authentication required');
    });

    ws.on('close', () => {
        clearTimeout(timeout);
        const member = rooms.get(roomId)?.get(participantId);
        if (member?.mediaSocket === ws) member.mediaSocket = null;
    });
    ws.on('error', error => console.error('Media WebSocket error:', error.message));
}

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
        const relayMedia = data.relayMedia === true;
        const directRecovery = data.directRecovery === true;
        // Create room if it doesn't exist
        if (!rooms.has(roomId)) {
            rooms.set(roomId, new Map());
            console.log(`[${new Date().toISOString()}] Created new room: ${roomId} by ${userName || userId}`);
        }
        
        const room = rooms.get(roomId);
        
        // Keep a participant and their relay pairings while their network reconnects.
        for (const [pid, participant] of room.entries()) {
            if (participant.userId === userId) {
                const active = participant.ws.readyState === WebSocket.OPEN;
                if (connectionKey && participant.connectionKey === connectionKey) {
                    const replaced = participant.ws;
                    clearTimeout(participant.disconnectTimer);
                    participant.disconnectTimer = null;
                    participant.ws = ws;
                    sendRoster(ws, room, pid, true, media);
                    if (media) broadcastRoomActivity(pid, { type: 'media-state', ...media }, roomId);
                    if (active) replaced.close(4001, 'Connection replaced');
                    return pid;
                }
                if (active || participant.connectionKey) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'This participant is already in the meeting'
                    }));
                    return false;
                }
                removeParticipant(room, pid);
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
            directRecovery,
            relay: createRelayState(relayMedia, data.encodedVideo === true),
            lastActivity: {},
            joinedAt: new Date().toISOString()
        });

        sendRoster(ws, room, participantId, false);

        // Notify existing participants about new user
        const newUserInfo = {
            type: 'user-joined',
            participantId: participantId,
            userId: userId,
            userName: participantName,
            raised: false,
            media,
            relayMedia,
            directRecovery
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
        
        console.log(`[${new Date().toISOString()}] User ${userName || userId} joined room ${roomId}. Total participants: ${room.size}`);
        return participantId;
        
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

function sendRoster(ws, room, participantId, resumed, updatedMedia) {
    const member = room.get(participantId);
    const participants = [];
    let newerThanSelf = false;
    for (const [pid, participant] of room.entries()) {
        if (pid === participantId) {
            newerThanSelf = true;
            continue;
        }
        participants.push({
            participantId: pid,
            userId: participant.userId,
            userName: participant.userName,
            raised: participant.raised,
            media: participant.media,
            relayMedia: Boolean(participant.relay),
            directRecovery: participant.directRecovery,
            relayed: member.relay?.peers.has(pid) ?? false,
            encodedVideo: Boolean(member.relay?.encodedVideo && participant.relay?.encodedVideo),
            shouldOffer: resumed && newerThanSelf
        });
    }
    ws.send(JSON.stringify({
        type: 'existing-participants',
        resumed,
        participants,
        iceServers: getIceServers(participantId),
        mediaRelay: true,
        mediaSocket: true,
        yourInfo: {
            participantId,
            userId: member.userId,
            userName: member.userName,
            raised: member.raised,
            media: updatedMedia ?? member.media
        }
    }));
}

function removeParticipant(room, participantId) {
    const participant = room.get(participantId);
    if (!participant) return;

    clearTimeout(participant.disconnectTimer);
    participant.mediaSocket?.close(1000, 'Participant left');
    removeRelayPeer(room, participantId, participant.relay);
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
    const backlogLimit = type === 'media-state' ? 512 * 1024 : maxBufferedBytes;
    for (const participant of room.values()) {
        if (participant.ws.readyState === WebSocket.OPEN && participant.ws.bufferedAmount < backlogLimit) {
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
    for (const [roomId, room] of rooms.entries()) {
        for (const [participantId, participant] of room.entries()) {
            if (participant.ws.readyState === WebSocket.CLOSED && !participant.disconnectTimer) {
                console.log(`Cleaning up inactive participant ${participantId} in room ${roomId}`);
                removeParticipant(room, participantId);
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
