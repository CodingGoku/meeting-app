const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Store rooms with participant details
const rooms = new Map(); // roomId -> Map of participantId -> { ws, userId, userName, joinedAt }

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

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    const participantId = uuidv4();
    let currentRoomId = null;
    let currentUserId = null;
    let currentUserName = null;
    const connectionTime = new Date();

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
            console.log(`[${new Date().toISOString()}] Message from ${participantId}: ${data.type}`);

            switch (data.type) {
                case 'join-room':
                    handleJoinRoom(ws, participantId, data);
                    currentRoomId = data.roomId;
                    currentUserId = data.userId;
                    currentUserName = data.userName;
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
            handleLeaveRoom(ws, participantId, currentRoomId);
        }
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
        console.error(`[${new Date().toISOString()}] WebSocket error for ${participantId}:`, error.message);
    });
});

function handleJoinRoom(ws, participantId, data) {
    try {
        const { roomId, userId, userName } = data;
        
        if (!roomId || !userId) {
            console.error('Invalid join data:', data);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid join data'
            }));
            return;
        }

        // Create room if it doesn't exist
        if (!rooms.has(roomId)) {
            rooms.set(roomId, new Map());
            console.log(`[${new Date().toISOString()}] Created new room: ${roomId} by ${userName || userId}`);
        }
        
        const room = rooms.get(roomId);
        
        // Check if user already exists in room (reconnection)
        let existingParticipantId = null;
        for (const [pid, participant] of room.entries()) {
            if (participant.userId === userId) {
                existingParticipantId = pid;
                break;
            }
        }
        
        if (existingParticipantId) {
            // Remove existing connection
            const oldParticipant = room.get(existingParticipantId);
            if (oldParticipant.ws !== ws) {
                try {
                    oldParticipant.ws.close();
                } catch (err) {
                    console.error('Error closing old connection:', err);
                }
            }
            room.delete(existingParticipantId);
            console.log(`[${new Date().toISOString()}] Replaced existing connection for user ${userName || userId}`);
        }
        
        // Add new participant
        room.set(participantId, { 
            ws, 
            userId, 
            userName: userName || `User ${userId.slice(0,4)}`,
            joinedAt: new Date().toISOString()
        });
        
        // Notify existing participants about new user
        const newUserInfo = {
            type: 'user-joined',
            participantId: participantId,
            userId: userId,
            userName: userName || `User ${userId.slice(0,4)}`
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
                    userName: participant.userName
                });
            }
        }
        
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'existing-participants',
                participants: existingParticipants,
                yourInfo: {
                    userId: userId,
                    userName: userName || `User ${userId.slice(0,4)}`
                }
            }));
        }
        
        console.log(`[${new Date().toISOString()}] User ${userName || userId} joined room ${roomId}. Total participants: ${room.size}`);
        
    } catch (error) {
        console.error('Error in handleJoinRoom:', error);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Failed to join room'
            }));
        }
    }
}

function handleLeaveRoom(ws, participantId, roomId) {
    try {
        if (!roomId || !rooms.has(roomId)) return;
        
        const room = rooms.get(roomId);
        const participant = room.get(participantId);
        
        if (!participant) return;
        
        const leaveInfo = {
            type: 'user-left',
            userId: participant.userId,
            userName: participant.userName
        };
        
        // Notify all other participants
        for (const [pid, p] of room.entries()) {
            if (pid !== participantId && p.ws.readyState === WebSocket.OPEN) {
                try {
                    p.ws.send(JSON.stringify(leaveInfo));
                } catch (err) {
                    console.error('Error notifying about leave:', err);
                }
            }
        }
        
        room.delete(participantId);
        console.log(`[${new Date().toISOString()}] User ${participant.userName || participant.userId} left room ${roomId}. Remaining: ${room.size}`);
        
        // Delete empty rooms after 30 seconds (to allow for reconnections)
        if (room.size === 0) {
            setTimeout(() => {
                if (rooms.has(roomId) && rooms.get(roomId).size === 0) {
                    rooms.delete(roomId);
                    console.log(`[${new Date().toISOString()}] Deleted empty room: ${roomId}`);
                }
            }, 30000);
        }
        
    } catch (error) {
        console.error('Error in handleLeaveRoom:', error);
    }
}

function forwardToParticipant(ws, data, roomId) {
    try {
        if (!roomId || !rooms.has(roomId)) return;
        
        const room = rooms.get(roomId);
        let targetParticipant = null;
        
        // Find target participant
        for (const [_, participant] of room.entries()) {
            if (participant.userId === data.to) {
                targetParticipant = participant;
                break;
            }
        }
        
        if (targetParticipant && targetParticipant.ws.readyState === WebSocket.OPEN) {
            targetParticipant.ws.send(JSON.stringify({
                type: data.type,
                from: data.from,
                fromName: data.fromName,
                data: data.data
            }));
        } else {
            // Target not found or not open
            console.log(`Target ${data.to} not found or not connected in room ${roomId}`);
        }
        
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
