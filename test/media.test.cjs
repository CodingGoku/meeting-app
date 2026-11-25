const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = readFileSync(path.join(__dirname, '../public/media.js'));
const moduleUrl = 'data:text/javascript;base64,' + source.toString('base64');

test('recovers a stalled camera while allowing a static presentation', async t => {
    const { MeetingMedia } = await import(moduleUrl);
    const previousPerformance = globalThis.performance;
    let now = 0;
    globalThis.performance = { now: () => now };
    t.after(() => { globalThis.performance = previousPerformance; });

    const stateChanges = [];
    let decoded = 20;
    const peer = {
        status: 'connected',
        initiate: true,
        expectVideo: true,
        expectScreen: false,
        videoRevision: 1,
        stream: { getVideoTracks: () => [{ readyState: 'live', muted: false }] },
        pc: {
            connectionState: 'connected',
            getStats: async () => new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: decoded }]])
        }
    };
    const media = Object.create(MeetingMedia.prototype);
    media.peers = new Map([['other', peer]]);
    media.onStatus = (id, state) => stateChanges.push([id, state]);
    media.scheduleRecovery = () => {};

    for (now = 0; now <= 6000; now += 1500) await media.sampleInboundVideo('other', peer);
    assert.deepEqual(stateChanges, [['other', 'reconnecting']]);
    assert.equal(peer.videoStalled, true);

    decoded++;
    await media.sampleInboundVideo('other', peer);
    assert.equal(peer.videoStalled, false);
    assert.deepEqual(stateChanges.at(-1), ['other', 'connected']);

    peer.expectScreen = true;
    for (; now <= 20000; now += 1500) await media.sampleInboundVideo('other', peer);
    assert.equal(peer.videoStalled, false);
    assert.equal(stateChanges.length, 2);
});

test('keeps signaling attached to the current ICE generation after reconnect', async () => {
    const { MeetingMedia } = await import(moduleUrl);
    const localDescription = { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:current\r\n' };
    const previousCandidate = { candidate: 'candidate:previous', usernameFragment: 'previous' };
    const currentCandidate = { candidate: 'candidate:current', usernameFragment: 'current' };
    const end = { candidate: '', usernameFragment: 'current' };

    const peer = {
        participantId: 'current-participant',
        descriptionSent: false,
        pc: { localDescription },
        outgoingCandidates: [previousCandidate, currentCandidate, end],
        queue: Promise.resolve()
    };
    const media = Object.create(MeetingMedia.prototype);
    media.peers = new Map([['guest', peer]]);
    let socketReady = false;
    const sent = [];
    media.send = (type, payload) => {
        if (!socketReady) return false;
        sent.push({ type, payload });
        return true;
    };

    media.flushLocalSignals('guest', peer);
    assert.deepEqual(sent, []);
    assert.equal(peer.outgoingCandidates.length, 3);
    socketReady = true;
    media.signalingResumed();
    await peer.queue;

    assert.equal(peer.descriptionSent, true);
    assert.equal(peer.outgoingCandidates.length, 0);
    assert.deepEqual(sent.map(item => item.type), ['offer', 'ice-candidate', 'ice-candidate']);
    assert.deepEqual(sent.slice(1).map(item => item.payload.data.candidate), [currentCandidate, end]);
    assert(sent.every(item => item.payload.toParticipantId === 'current-participant'));
});

test('accepts audio from one screen picker and shares silently when none is selected', async t => {
    const { MeetingMedia } = await import(moduleUrl);
    const mediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    t.after(() => {
        if (mediaDevices) Object.defineProperty(navigator, 'mediaDevices', mediaDevices);
        else Reflect.deleteProperty(navigator, 'mediaDevices');
    });

    const requests = [];
    let choose;
    Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
            getDisplayMedia(options) {
                requests.push(options);
                return new Promise(resolve => { choose = resolve; });
            }
        }
    });
    const makeTrack = () => Object.assign(new EventTarget(), {
        readyState: 'live',
        stop() { this.readyState = 'ended'; }
    });
    const makeStream = (video, audio = []) => ({
        getVideoTracks: () => [video],
        getAudioTracks: () => audio,
        getTracks: () => [video, ...audio]
    });
    const notices = [];
    const media = Object.assign(Object.create(MeetingMedia.prototype), {
        devices: {},
        notify: message => notices.push(message),
        startAudioMix() {},
        async refresh() {}
    });

    const audio = makeTrack();
    const pending = media.toggleShare();
    await media.toggleShare();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].audio, true);
    assert.equal(requests[0].systemAudio, 'include');
    choose(makeStream(makeTrack(), [audio]));
    assert.equal((await pending).sharing, true);
    assert.equal(media.outgoingAudio(), audio);
    assert.equal((await media.toggleShare()).sharing, false);
    assert.equal(audio.readyState, 'ended');

    const silentShare = media.toggleShare();
    choose(makeStream(makeTrack()));
    assert.equal((await silentShare).sharing, true);
    assert.equal(media.outgoingAudio(), null);
    assert.deepEqual(notices, []);
});
