const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// WebSocket server
const wss = new WebSocket.Server({ server });

// Store rooms
const rooms = new Map();

// Serve static files from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket connection handling
wss.on('connection', (ws) => {
    const participantId = uuidv4();
    let currentRoomId = null;
    let userId = null;

    console.log(`[${new Date().toISOString()}] New connection: ${participantId}`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log(`[${new Date().toISOString()}] Message type: ${data.type}`);

            switch (data.type) {
                case 'join-room':
                    handleJoinRoom(ws, participantId, data);
                    currentRoomId = data.roomId;
                    userId = data.userId;
                    break;
                case 'offer':
                case 'answer':
                case 'ice-candidate':
                    forwardToParticipant(ws, data, currentRoomId);
                    break;
                case 'leave-room':
                    handleLeaveRoom(ws, participantId, currentRoomId);
                    currentRoomId = null;
                    break;
                default:
                    console.log('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });

    ws.on('close', () => {
        console.log(`[${new Date().toISOString()}] Connection closed: ${participantId}`);
        if (currentRoomId) {
            handleLeaveRoom(ws, participantId, currentRoomId);
        }
    });
});

function handleJoinRoom(ws, participantId, data) {
    const { roomId, userId } = data;
    
    // Create room if it doesn't exist
    if (!rooms.has(roomId)) {
        rooms.set(roomId, new Map());
        console.log(`[${new Date().toISOString()}] Created new room: ${roomId}`);
    }
    
    const room = rooms.get(roomId);
    room.set(participantId, { ws, userId });
    
    // Notify existing participants about new user
    for (const [pid, participant] of room.entries()) {
        if (pid !== participantId) {
            if (participant.ws.readyState === WebSocket.OPEN) {
                participant.ws.send(JSON.stringify({
                    type: 'user-joined',
                    participantId: participantId,
                    userId: userId
                }));
            }
        }
    }
    
    // Send existing participants to new user
    const existingParticipants = [];
    for (const [pid, participant] of room.entries()) {
        if (pid !== participantId) {
            existingParticipants.push({ 
                participantId: pid, 
                userId: participant.userId 
            });
        }
    }
    
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'existing-participants',
            participants: existingParticipants
        }));
    }
    
    console.log(`[${new Date().toISOString()}] User ${userId} joined room ${roomId}. Total: ${room.size}`);
}

function handleLeaveRoom(ws, participantId, roomId) {
    if (!roomId || !rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    const participant = room.get(participantId);
    
    if (participant) {
        // Notify other participants
        for (const [pid, p] of room.entries()) {
            if (pid !== participantId && p.ws.readyState === WebSocket.OPEN) {
                p.ws.send(JSON.stringify({
                    type: 'user-left',
                    userId: participant.userId
                }));
            }
        }
        
        room.delete(participantId);
        console.log(`[${new Date().toISOString()}] User ${participant.userId} left room ${roomId}. Remaining: ${room.size}`);
        
        // Delete empty room
        if (room.size === 0) {
            rooms.delete(roomId);
            console.log(`[${new Date().toISOString()}] Deleted empty room: ${roomId}`);
        }
    }
}

function forwardToParticipant(ws, data, roomId) {
    if (!roomId || !rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    let targetWs = null;
    let targetParticipantId = null;
    
    // Find target participant
    for (const [pid, participant] of room.entries()) {
        if (participant.userId === data.to) {
            targetWs = participant.ws;
            targetParticipantId = pid;
            break;
        }
    }
    
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
            type: data.type,
            from: data.from,
            data: data.data
        }));
    }
}

// Start server
server.listen(PORT, () => {
    console.log(`
    ╔═══════════════════════════════════════════════════════╗
    ║   🚀 Meeting Server Started Successfully!             ║
    ║   📡 Server running on port: ${PORT}                    ║
    ║   🌐 Access at: http://localhost:${PORT}               ║
    ║   🔗 WebSocket: ws://localhost:${PORT}                 ║
    ║                                                        ║
    ║   💡 Ready for connections!                           ║
    ╚═══════════════════════════════════════════════════════╝
    `);
});
