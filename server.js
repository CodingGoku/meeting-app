const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { createHmac, randomUUID } = require('node:crypto');
const { createRelayState, requestMediaRelay, forwardRelayPacket, removeRelayPeer } = require('./media-relay');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');

// Store rooms with participant details
const rooms = new Map(); // roomId -> Map of participantId -> participant
const reactions = new Set(['👍', '👏', '❤️', '🎉', '😂', '😮']);
const activityCooldowns = { 'chat-message': 400, reaction: 650, 'hand-raised': 250 };
const maxChatLength = 500;
const maxBufferedBytes = 64 * 1024;
const maxSignalingBacklog = 512 * 1024;
const maxSignalingBytes = 64 * 1024;
const maxPendingConnections = 256;
const signalJoinTimeoutMs = 12000;
const reconnectGraceMs = 15000;
const mediaBindTimeoutMs = 4000;
const pendingConnections = new Set();
let draining = false;
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
    res.set('Cache-Control', 'no-store');
    res.status(draining ? 503 : 200).json({
        status: draining ? 'draining' : 'healthy',
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
    let totalParticipants = 0;
    let signalingSockets = 0;
    let mediaSockets = 0;
    let relayLinks = 0;
    for (const room of rooms.values()) {
        totalParticipants += room.size;
        for (const participant of room.values()) {
            if (participant.ws.readyState === WebSocket.OPEN) signalingSockets++;
            if (participant.mediaSocket?.readyState === WebSocket.OPEN) mediaSockets++;
            relayLinks += participant.relay?.peers.size ?? 0;
        }
    }
    res.set('Cache-Control', 'no-store');
    res.json({
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        activeRooms: rooms.size,
        totalParticipants,
        signalingSockets,
        reconnectingParticipants: totalParticipants - signalingSockets,
        mediaSockets,
        relayPairs: relayLinks / 2,
        pendingConnections: pendingConnections.size
    });
});

const wss = new WebSocket.Server({
    noServer: true,
    handleProtocols: () => false,
    maxPayload: 128 * 1024
});

server.on('upgrade', (request, socket, head) => {
    if (draining || pendingConnections.size >= maxPendingConnections) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
});

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

function beginHandshake(ws, timeoutMs) {
    if (pendingConnections.size >= maxPendingConnections) {
        ws.terminate();
        return;
    }
    pendingConnections.add(ws);
    ws.handshakeTimer = setTimeout(() => ws.terminate(), timeoutMs);
    ws.handshakeTimer.unref();
}

function finishHandshake(ws) {
    clearTimeout(ws.handshakeTimer);
    pendingConnections.delete(ws);
}

function acceptSignalingMessage(ws, message, joined) {
    const now = Date.now();
    if (ws.signalWindow === undefined || now - ws.signalWindow >= 1000) {
        ws.signalWindow = now;
        ws.signalCount = 0;
    }
    const maxMessages = joined ? 240 : 12;
    if (++ws.signalCount <= maxMessages && message.length <= maxSignalingBytes) return true;
    ws.close(1008, 'Signaling limit exceeded');
    return false;
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', error => {
        console.warn('Meeting WebSocket error:', error.code ?? 'unknown');
    });
    ws.once('close', () => finishHandshake(ws));

    const isMediaSocket = req.url?.split('?')[0] === '/media';
    beginHandshake(ws, isMediaSocket ? mediaBindTimeoutMs : signalJoinTimeoutMs);
    if (isMediaSocket) {
        handleMediaSocket(ws);
        return;
    }

    let participantId = randomUUID();
    let currentRoomId = null;
    const connectionTime = new Date();

    // Send initial connection confirmation
    ws.send(JSON.stringify({
        type: 'connection-established',
        participantId: participantId,
        timestamp: connectionTime.toISOString()
    }));

    // Handle incoming messages
    ws.on('message', (message, isBinary) => {
        try {
            if (ws.readyState !== WebSocket.OPEN || draining) return;
            const room = rooms.get(currentRoomId);
            if (currentRoomId && room?.get(participantId)?.ws !== ws) return;
            if (isBinary) {
                forwardRelayPacket(room, participantId, message);
                return;
            }
            if (!acceptSignalingMessage(ws, message, Boolean(currentRoomId))) return;
            const data = JSON.parse(message.toString());

            switch (data?.type) {
                case 'join-room': {
                    if (currentRoomId) break;
                    const joinedId = handleJoinRoom(ws, participantId, data);
                    if (joinedId) {
                        participantId = joinedId;
                        currentRoomId = data.roomId;
                        finishHandshake(ws);
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
                    if (!currentRoomId) break;
                    handleLeaveRoom(participantId, currentRoomId);
                    currentRoomId = null;
                    beginHandshake(ws, signalJoinTimeoutMs);
                    break;
                    
                case 'ping':
                    // Respond to keep-alive pings
                    ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
                    break;
                    
                default:
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Unknown message type'
                    }));
            }
        } catch {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error', message: 'Failed to process message' }));
            }
        }
    });

    // Handle WebSocket close
    ws.on('close', () => {
        if (draining) return;
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

});

function handleMediaSocket(ws) {
    let roomId;
    let participantId;
    ws.on('message', (message, isBinary) => {
        if (ws.readyState !== WebSocket.OPEN || draining) return;
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
                    finishHandshake(ws);
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
        const member = rooms.get(roomId)?.get(participantId);
        if (member?.mediaSocket === ws) member.mediaSocket = null;
    });
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
                } catch {
                    console.warn('Could not notify a participant of a join.');
                }
            }
        }
        
        return participantId;
        
    } catch {
        console.warn('Could not join a meeting.');
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
            } catch {
                console.warn('Could not notify a participant of a leave.');
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
        
        // Delete empty rooms after 30 seconds (to allow for reconnections)
        if (room.size === 0) {
            setTimeout(() => {
                if (rooms.get(roomId) === room && room.size === 0) {
                    rooms.delete(roomId);
                }
            }, 30000).unref();
        }
        
    } catch {
        console.warn('Could not remove a participant.');
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
    const backlogLimit = type === 'media-state' ? maxSignalingBacklog : maxBufferedBytes;
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
            if (participant.ws.readyState !== WebSocket.OPEN ||
                participant.ws.bufferedAmount > maxSignalingBacklog) return;

            participant.ws.send(JSON.stringify({
                type: data.type,
                from: sender.userId,
                fromName: sender.userName,
                fromParticipantId: participantId,
                data: data.data
            }));
            return;
        }
    } catch {
        console.warn('Could not forward a signaling message.');
    }
}

// Cleanup inactive connections periodically
const cleanup = setInterval(() => {
    for (const [roomId, room] of rooms.entries()) {
        for (const [participantId, participant] of room.entries()) {
            if (participant.ws.readyState === WebSocket.CLOSED && !participant.disconnectTimer) {
                removeParticipant(room, participantId);
            }
        }
        
        if (room.size === 0) {
            rooms.delete(roomId);
        }
    }
}, 60000); // Run every minute
cleanup.unref();

function shutdown() {
    if (draining) return;
    draining = true;
    clearInterval(heartbeat);
    clearInterval(cleanup);

    const deadline = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
        server.closeAllConnections?.();
        process.exit(0);
    }, 5000);
    deadline.unref();

    let pendingClosures = 2;
    const closed = () => {
        if (--pendingClosures > 0) return;
        clearTimeout(deadline);
        process.exit(0);
    };
    for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
    wss.close(closed);
    server.close(closed);
    server.closeIdleConnections?.();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`MeetStream listening on port ${server.address().port}`);
});

// Export for testing purposes
module.exports = { app, server, wss, rooms };
