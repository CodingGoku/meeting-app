const WebSocket = require('ws');

const headerSize = 37;
const videoKind = 1;
const audioKind = 2;
const maxVideoPacket = 128 * 1024;
const audioPayloadSize = 640;
const maxRelayBacklog = 192 * 1024;
const maxRelayPeers = 8;
const maxImageEdge = 1280;
const participantIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const peerLimit = { video: 12, videoBytes: 384 * 1024, audio: 35 };
const senderLimit = { video: 72, videoBytes: 1536 * 1024, audio: 210 };

function createBudget() {
    return { start: 0, video: 0, videoBytes: 0, audio: 0 };
}

function createRelayState(enabled) {
    return enabled ? { peers: new Set(), peerBudgets: new Map(), budget: createBudget() } : null;
}

function validPacket(packet) {
    if (!Buffer.isBuffer(packet) || packet.length <= headerSize) return false;

    if (packet[0] === audioKind) return packet.length === headerSize + audioPayloadSize;
    if (packet[0] !== videoKind || packet.length > maxVideoPacket || packet.length < headerSize + 4) return false;
    return packet[headerSize] === 0xff && packet[headerSize + 1] === 0xd8 &&
        packet[packet.length - 2] === 0xff && packet[packet.length - 1] === 0xd9;
}

function validJpegDimensions(packet) {
    let offset = headerSize + 2;
    for (let segment = 0; segment < 32 && offset + 4 <= packet.length; segment++) {
        if (packet[offset++] !== 0xff) return false;
        const marker = packet[offset++];
        if (marker === 0xda || marker === 0xd9) return false;

        const length = packet.readUInt16BE(offset);
        if (length < 2 || offset + length > packet.length) return false;
        const isFrame = marker >= 0xc0 && marker <= 0xcf &&
            marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) {
            if (length < 11) return false;
            const height = packet.readUInt16BE(offset + 3);
            const width = packet.readUInt16BE(offset + 5);
            const components = packet[offset + 7];
            return components >= 1 && components <= 4 && length === 8 + 3 * components &&
                width > 0 && width <= maxImageEdge && height > 0 && height <= maxImageEdge;
        }
        offset += length;
    }
    return false;
}

function maySend(budget, limits, packet, now) {
    if (now - budget.start >= 1000 || now < budget.start) {
        budget.start = now;
        budget.video = 0;
        budget.videoBytes = 0;
        budget.audio = 0;
    }

    if (packet[0] === audioKind) return budget.audio < limits.audio;
    return budget.video < limits.video && budget.videoBytes + packet.length <= limits.videoBytes;
}

function charge(budget, packet) {
    if (packet[0] === audioKind) {
        budget.audio++;
    } else {
        budget.video++;
        budget.videoBytes += packet.length;
    }
}

function requestMediaRelay(room, senderId, targetId) {
    if (!room || typeof targetId !== 'string' || !participantIdPattern.test(targetId) || targetId === senderId) return;

    const sender = room.get(senderId);
    const target = room.get(targetId);
    if (!sender?.relay || !target?.relay ||
        sender.ws.readyState !== WebSocket.OPEN || target.ws.readyState !== WebSocket.OPEN ||
        sender.relay.peers.has(targetId) ||
        sender.relay.peers.size >= maxRelayPeers || target.relay.peers.size >= maxRelayPeers) return;

    sender.relay.peers.add(targetId);
    sender.relay.peerBudgets.set(targetId, createBudget());
    target.relay.peers.add(senderId);
    target.relay.peerBudgets.set(senderId, createBudget());
    sender.ws.send(JSON.stringify({ type: 'media-relay', userId: target.userId, participantId: targetId }));
    target.ws.send(JSON.stringify({ type: 'media-relay', userId: sender.userId, participantId: senderId }));
}

function forwardRelayPacket(room, senderId, packet) {
    const sender = room?.get(senderId);
    if (!sender?.relay || !validPacket(packet)) return;

    const targetId = packet.toString('latin1', 1, headerSize);
    if (!participantIdPattern.test(targetId) || !sender.relay.peers.has(targetId)) return;

    const target = room.get(targetId);
    if (target?.ws.readyState !== WebSocket.OPEN || !target.relay?.peers.has(senderId) ||
        target.ws.bufferedAmount + packet.length > maxRelayBacklog) return;

    const peerBudget = sender.relay.peerBudgets.get(targetId);
    const now = Date.now();
    if (!maySend(peerBudget, peerLimit, packet, now) || !maySend(sender.relay.budget, senderLimit, packet, now)) return;
    if (packet[0] === videoKind && !validJpegDimensions(packet)) return;

    charge(peerBudget, packet);
    charge(sender.relay.budget, packet);
    const forwarded = Buffer.from(packet);
    forwarded.write(senderId, 1, headerSize - 1, 'ascii');
    target.ws.send(forwarded, { binary: true });
}

function removeRelayPeer(room, participantId, relay) {
    if (!relay) return;

    for (const otherId of relay.peers) {
        const other = room.get(otherId)?.relay;
        other?.peers.delete(participantId);
        other?.peerBudgets.delete(participantId);
    }
}

module.exports = { createRelayState, requestMediaRelay, forwardRelayPacket, removeRelayPeer };
