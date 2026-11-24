const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const path = require('node:path');
const { after, before, test } = require('node:test');
const WebSocket = require('ws');

const projectRoot = path.resolve(__dirname, '..');
const deadlineMs = 5000;
const micState = { camera: true, mic: true, sharing: false };
const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAABv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AaP/Z',
    'base64'
);
const vp8 = Buffer.from('MAIAnQEqCAAIAAFAJiWgAnS6AfgB+AAEoQAA/vDEC/9COihoe6f/9eiDxBv1NAAA', 'base64');
let appProcess;
let origin;

before(async () => {
    appProcess = spawn(process.execPath, ['server.js'], {
        cwd: projectRoot,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: '0',
            TURN_URLS: 'turn:127.0.0.1:3478',
            TURN_SECRET: '',
            TURN_USERNAME: 'test-relay-user',
            TURN_CREDENTIAL: 'test-relay-credential'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const events = new EventEmitter();
    let logs = '';
    function record(chunk) {
        logs = (logs + chunk).slice(-4096);
        const listening = /MeetStream listening on port ([1-9][0-9]*)/.exec(logs);
        if (listening) events.emit('listening', listening[1]);
    }
    appProcess.stdout.setEncoding('utf8').on('data', record);
    appProcess.stderr.setEncoding('utf8').on('data', record);
    appProcess.once('error', error => events.emit('startup-error', error));
    appProcess.once('exit', (code, signal) => events.emit('startup-error', new Error(`Server exited (${code ?? signal})`)));
    const timeout = AbortSignal.timeout(deadlineMs);
    try {
        const port = await Promise.race([
            once(events, 'listening', { signal: timeout }).then(([value]) => value),
            once(events, 'startup-error', { signal: timeout }).then(([error]) => { throw error; })
        ]);
        origin = `http://127.0.0.1:${port}`;
    } catch (error) {
        throw new Error(`Unable to start the integration server.\n${logs}`, { cause: error });
    }
});

after(async () => {
    if (!appProcess?.pid || appProcess.exitCode !== null || appProcess.signalCode !== null) return;
    const exited = once(appProcess, 'exit', { signal: AbortSignal.timeout(deadlineMs) });
    appProcess.kill('SIGTERM');
    try {
        await exited;
    } catch {
        appProcess.kill('SIGKILL');
    }
});

function request(endpoint) {
    return fetch(new URL(endpoint, origin), { signal: AbortSignal.timeout(deadlineMs) });
}

async function openSocket(t, endpoint = '/') {
    const socket = new WebSocket(new URL(endpoint, origin.replace('http:', 'ws:')), {
        handshakeTimeout: deadlineMs
    });
    const inbox = [];
    const events = new EventEmitter();
    let terminalError;
    socket.on('message', (data, isBinary) => {
        try {
            inbox.push(isBinary ? data : JSON.parse(data.toString()));
        } catch (error) {
            terminalError = error;
        }
        events.emit('message');
    });
    socket.on('error', error => {
        terminalError = error;
        events.emit('message');
    });
    socket.on('close', code => {
        terminalError ??= new Error(`WebSocket closed with code ${code}`);
        events.emit('message');
    });
    t.after(() => socket.terminate());
    await once(socket, 'open', { signal: AbortSignal.timeout(deadlineMs) });

    async function next(match) {
        const matches = typeof match === 'string' ? value => value.type === match : match;
        const timeout = AbortSignal.timeout(deadlineMs);
        for (;;) {
            const index = inbox.findIndex(matches);
            if (index !== -1) return inbox.splice(index, 1)[0];
            if (terminalError) throw terminalError;
            await once(events, 'message', { signal: timeout });
        }
    }

    return {
        socket,
        inbox,
        next,
        send(message) {
            socket.send(Buffer.isBuffer(message) ? message : JSON.stringify(message));
        }
    };
}

function member(userName, capabilities = {}) {
    return {
        userId: randomUUID(),
        connectionKey: randomUUID(),
        userName,
        media: micState,
        relayMedia: true,
        directRecovery: true,
        encodedVideo: true,
        ...capabilities
    };
}

async function enter(client, roomId, identity) {
    client.send({ type: 'join-room', roomId, ...identity });
    return client.next('existing-participants');
}

async function bindMedia(t, roomId, identity) {
    const client = await openSocket(t, '/media');
    client.send({
        type: 'bind-media',
        roomId,
        userId: identity.userId,
        connectionKey: identity.connectionKey
    });
    await client.next('media-ready');
    return client;
}

function packet(kind, participantId, payload) {
    return Buffer.concat([Buffer.from([kind]), Buffer.from(participantId, 'ascii'), payload]);
}

function offerData(sessionName) {
    return { sdp: { type: 'offer', sdp: `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=${sessionName}\r\nt=0 0\r\n` } };
}

test('serves the lobby, application JavaScript and health through HTTP', async () => {
    const [lobby, script, health] = await Promise.all([
        request('/'),
        request('/app.js'),
        request('/health')
    ]);
    assert.equal(lobby.status, 200);
    assert.match(await lobby.text(), /<title>MeetStream Pro<\/title>/);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    await script.arrayBuffer();
    assert.equal(health.status, 200);
    const status = await health.json();
    assert.equal(status.status, 'healthy');
    assert.equal(status.activeRooms, 0);
    assert.equal(status.totalParticipants, 0);
});

test('keeps meeting activity and signaling in the room and uses server identity', async t => {
    const roomId = randomUUID();
    const host = member('Private host');
    const guest = member('Private guest', { encodedVideo: false });
    const outsider = member('Private outsider');
    const [alice, bob, eve] = await Promise.all([openSocket(t), openSocket(t), openSocket(t)]);
    const first = await enter(alice, roomId, host);
    const second = await enter(bob, roomId, guest);
    await enter(eve, randomUUID(), outsider);
    const joined = await alice.next('user-joined');
    assert.equal(first.resumed, false);
    assert.equal(first.mediaSocket, true);
    assert.equal(first.mediaRelay, true);
    assert.equal(joined.participantId, second.yourInfo.participantId);
    assert.equal(joined.directRecovery, true);
    assert.equal(second.participants.length, 1);
    assert.equal(second.participants[0].participantId, first.yourInfo.participantId);
    assert.equal(second.participants[0].encodedVideo, false);
    assert.equal(second.participants[0].shouldOffer, false);
    assert.equal('connectionKey' in second.participants[0], false);

    const target = { to: host.userId, toParticipantId: first.yourInfo.participantId };
    eve.send({ type: 'offer', ...target, data: offerData('Other room') });
    eve.send({ type: 'ping' });
    await eve.next('pong');
    bob.send({ type: 'offer', ...target, toParticipantId: randomUUID(), data: offerData('Old participant') });
    bob.send({ type: 'offer', ...target, from: outsider.userId, data: offerData('This room') });
    const offer = await alice.next('offer');
    assert.deepEqual(offer.data, offerData('This room'));
    assert.equal(offer.from, guest.userId);
    assert.equal(offer.fromParticipantId, second.yourInfo.participantId);
    bob.send({ type: 'relay-preference', ...target, data: { directReady: true } });
    assert.deepEqual((await alice.next('relay-preference')).data, { directReady: true });

    eve.send({ type: 'chat-message', text: 'Other room only' });
    await eve.next('chat-message');
    alice.send({ type: 'chat-message', text: 'Hello from this room' });
    assert.equal((await bob.next('chat-message')).text, 'Hello from this room');

    const response = await request('/stats');
    assert.equal(response.status, 200);
    const stats = await response.json();
    assert.ok(stats.activeRooms >= 2);
    assert.ok(stats.totalParticipants >= 3);
    const publicStats = JSON.stringify(stats);
    for (const privateValue of [roomId, host.userId, host.userName, host.connectionKey, outsider.userName]) {
        assert.ok(!publicStats.includes(privateValue));
    }
});

test('preserves participant identity, relay and offer ordering after reconnect', async t => {
    const roomId = randomUUID();
    const host = member('Host');
    const guest = member('Guest');
    const alice = await openSocket(t);
    const bob = await openSocket(t);
    const first = await enter(alice, roomId, host);
    const second = await enter(bob, roomId, guest);
    await alice.next('user-joined');
    const aliceId = first.yourInfo.participantId;
    const bobId = second.yourInfo.participantId;

    alice.send({ type: 'relay-request', toParticipantId: bobId });
    assert.equal((await alice.next('media-relay')).encodedVideo, true);
    assert.equal((await bob.next('media-relay')).participantId, aliceId);
    const interrupted = once(alice.socket, 'close', { signal: AbortSignal.timeout(deadlineMs) });
    alice.socket.close(4000, 'Test connection interruption');
    await interrupted;

    const impostor = await openSocket(t);
    impostor.send({ type: 'join-room', roomId, ...host, connectionKey: randomUUID() });
    assert.equal((await impostor.next('error')).message, 'This participant is already in the meeting');
    const resumed = await openSocket(t);
    const roster = await enter(resumed, roomId, host);
    assert.equal(roster.resumed, true);
    assert.equal(roster.yourInfo.participantId, aliceId);
    assert.equal(roster.participants[0].participantId, bobId);
    assert.equal(roster.participants[0].relayed, true);
    assert.equal(roster.participants[0].encodedVideo, true);
    assert.equal(roster.participants[0].shouldOffer, true);

    const sound = Buffer.alloc(640, 7);
    resumed.send(packet(2, bobId, sound));
    assert.deepEqual(await bob.next(Buffer.isBuffer), packet(2, aliceId, sound));
    assert.equal(bob.inbox.some(item => item.type === 'user-left' || item.type === 'user-joined'), false);

    resumed.send({ type: 'leave-room' });
    assert.equal((await bob.next('user-left')).userId, host.userId);
});

test('authenticates the dedicated media path and rejects malformed or oversized media', async t => {
    const roomId = randomUUID();
    const host = member('Host');
    const guest = member('Guest');
    const alice = await openSocket(t);
    const bob = await openSocket(t);
    const first = await enter(alice, roomId, host);
    const second = await enter(bob, roomId, guest);
    const aliceId = first.yourInfo.participantId;
    const bobId = second.yourInfo.participantId;
    alice.send({ type: 'relay-request', toParticipantId: bobId });
    await Promise.all([alice.next('media-relay'), bob.next('media-relay')]);

    const wrongKey = await openSocket(t, '/media');
    const rejected = once(wrongKey.socket, 'close', { signal: AbortSignal.timeout(deadlineMs) });
    wrongKey.send({ type: 'bind-media', roomId, userId: host.userId, connectionKey: randomUUID() });
    assert.equal((await rejected)[0], 1008);

    const [sender, receiver] = await Promise.all([bindMedia(t, roomId, host), bindMedia(t, roomId, guest)]);
    const badDimensions = Buffer.from(jpeg);
    const frameMarker = badDimensions.indexOf(Buffer.from([0xff, 0xc0]));
    badDimensions.writeUInt16BE(8192, frameMarker + 7);
    sender.send(packet(1, bobId, Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9])));
    sender.send(packet(1, bobId, badDimensions));
    sender.send(packet(2, bobId, Buffer.alloc(639)));
    sender.send(packet(1, bobId, jpeg));

    assert.deepEqual(await receiver.next(Buffer.isBuffer), packet(1, aliceId, jpeg));

    const vp8Header = Buffer.alloc(11);
    vp8Header.writeUInt16BE(8, 0);
    vp8Header.writeUInt16BE(8, 2);
    vp8Header[10] = 1;
    const forgedHeader = Buffer.from(vp8Header);
    forgedHeader.writeUInt16BE(9, 0);
    sender.send(packet(3, bobId, Buffer.concat([forgedHeader, vp8])));
    const encodedVideo = Buffer.concat([vp8Header, vp8]);
    sender.send(packet(3, bobId, encodedVideo));
    assert.deepEqual(await receiver.next(Buffer.isBuffer), packet(3, aliceId, encodedVideo));

    const sound = Buffer.alloc(640, 2);
    sender.send(packet(2, bobId, sound));
    assert.deepEqual(await bob.next(Buffer.isBuffer), packet(2, aliceId, sound));

    const closed = once(sender.socket, 'close', { signal: AbortSignal.timeout(deadlineMs) });
    const oversized = Buffer.concat([jpeg.subarray(0, -2), Buffer.alloc(128 * 1024), jpeg.subarray(-2)]);
    sender.send(packet(1, bobId, oversized));
    assert.equal((await closed)[0], 1009);
});

test('closes active WebSockets on SIGTERM', { skip: process.platform === 'win32' }, async t => {
    const client = await openSocket(t);
    const closed = once(client.socket, 'close', { signal: AbortSignal.timeout(deadlineMs) });
    const exited = once(appProcess, 'exit', { signal: AbortSignal.timeout(deadlineMs) });
    appProcess.kill('SIGTERM');
    assert.equal((await closed)[0], 1001);
    assert.equal((await exited)[0], 0);
});
