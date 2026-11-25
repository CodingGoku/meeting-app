const stunServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

const isLive = track => track?.readyState === 'live';
const stopStream = stream => stream?.getTracks().forEach(track => track.stop());
const ICE_TIMEOUT = 11000;
const MAX_RESTARTS = 2;
const BACKGROUND_ICE_TIMEOUT = 25000;
const MAX_ICE_CANDIDATES = 192;
const VIDEO_SAMPLE_MS = 1500;
const VIDEO_STALL_MS = 6000;
const mediaKinds = ['audio', 'video'];
const cameraConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };

function transportConnected(pc) {
    return pc.connectionState === 'connected' ||
        (!pc.connectionState && ['connected', 'completed'].includes(pc.iceConnectionState));
}

function iceFragments(description) {
    const matches = description?.sdp?.matchAll(/^a=ice-ufrag:(\S+)\r?$/gm);
    return new Set(Array.from(matches || [], match => match[1]));
}

function candidateMatches(description, candidate) {
    return Boolean(description?.sdp && (!candidate.usernameFragment ||
        iceFragments(description).has(candidate.usernameFragment)));
}
const microphoneConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

function inputConstraints(device, id) {
    const defaults = device === 'camera' ? cameraConstraints : microphoneConstraints;
    return id ? { ...defaults, deviceId: { exact: id } } : defaults;
}

export class MeetingMedia {
    constructor({ send, onLocal, onRemote, onRemoteRemoved, onStatus = () => {}, notify }) {
        this.send = send;
        this.onLocal = onLocal;
        this.onRemote = onRemote;
        this.onRemoteRemoved = onRemoteRemoved;
        this.notify = notify;
        this.onStatus = onStatus;
        this.preview = new MediaStream();
        this.outbound = new MediaStream();
        this.iceServers = stunServers;
        this.peers = new Map();
        this.devices = { mic: null, camera: null };
        this.inputIds = { mic: '', camera: '' };
        this.pendingDevices = new Set();
        this.displayStream = null;
        this.pendingShare = false;
        this.audioMix = null;
        this.destroyed = false;
    }

    get state() {
        return {
            mic: isLive(this.devices.mic),
            camera: isLive(this.devices.camera),
            sharing: isLive(this.displayStream?.getVideoTracks()[0])
        };
    }

    async prepare({ mic, camera, inputIds = {} }) {
        this.inputIds = { mic: inputIds.mic || '', camera: inputIds.camera || '' };
        if (mic && camera && navigator.mediaDevices?.getUserMedia) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: inputConstraints('mic', this.inputIds.mic),
                    video: inputConstraints('camera', this.inputIds.camera)
                });
                this.setDevice('mic', stream.getAudioTracks()[0]);
                this.setDevice('camera', stream.getVideoTracks()[0]);
            } catch {
                // A browser can deny one input while still granting the other.
            }
        }

        const missing = [];
        if (!this.destroyed && mic && !this.state.mic && !await this.openDevice('mic')) {
            missing.push('microphone');
        }
        if (!this.destroyed && camera && !this.state.camera && !await this.openDevice('camera')) {
            missing.push('camera');
        }
        if (missing.length && !this.destroyed) {
            this.notify(`Could not access your ${missing.join(' or ')}. You can still join.`);
        }
        await this.refresh();
        return this.state;
    }

    setDevice(device, track) {
        if (!track) return;
        if (this.destroyed) {
            track.stop();
            return;
        }
        const previous = this.devices[device];
        this.devices[device] = track;
        previous?.stop();
        if (device === 'camera' && 'contentHint' in track) track.contentHint = 'motion';
        track.addEventListener('ended', () => {
            if (this.devices[device] !== track) return;
            this.devices[device] = null;
            this.notify(device === 'mic' ? 'Your microphone is no longer available.' : 'Your camera is no longer available.');
            void this.refresh();
        }, { once: true });
    }

    async openDevice(device, id = this.inputIds[device], useDefaultIfMissing = true) {
        if (!navigator.mediaDevices?.getUserMedia) return false;
        const kind = device === 'mic' ? 'audio' : 'video';
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ [kind]: inputConstraints(device, id) });
            const [track] = stream.getTracks();
            if (!isLive(track) || this.destroyed) {
                stopStream(stream);
                return false;
            }
            this.setDevice(device, track);
            this.inputIds[device] = id;
            return true;
        } catch (error) {
            if (id && useDefaultIfMissing && !this.destroyed &&
                (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')) {
                return this.openDevice(device, '', false);
            }
            return false;
        }
    }

    async setInputDevice(device, id) {
        if (this.destroyed || this.pendingDevices.has(device)) return false;
        if (id === this.inputIds[device] || !isLive(this.devices[device])) {
            this.inputIds[device] = id;
            return true;
        }
        this.pendingDevices.add(device);
        try {
            if (!await this.openDevice(device, id, false)) return false;
            await this.refresh();
            return !this.destroyed;
        } finally {
            this.pendingDevices.delete(device);
        }
    }

    async toggleDevice(device) {
        if (this.destroyed || this.pendingDevices.has(device)) return this.state;
        this.pendingDevices.add(device);
        try {
            if (isLive(this.devices[device])) {
                this.devices[device].stop();
                this.devices[device] = null;
            } else if (!await this.openDevice(device) && !this.destroyed) {
                this.notify(device === 'mic' ? 'Could not access the microphone' : 'Could not access the camera');
            }
            await this.refresh();
            return this.state;
        } finally {
            this.pendingDevices.delete(device);
        }
    }

    toggleMic() {
        return this.toggleDevice('mic');
    }

    toggleCamera() {
        return this.toggleDevice('camera');
    }

    async toggleShare() {
        if (this.destroyed || this.pendingShare) return this.state;
        if (this.displayStream) {
            await this.stopShare(this.displayStream);
            return this.state;
        }
        if (!navigator.mediaDevices?.getDisplayMedia) {
            this.notify('Screen sharing is unavailable in this browser');
            return this.state;
        }

        this.pendingShare = true;
        try {
            this.startAudioMix();
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 24, max: 30 } },
                audio: true,
                systemAudio: 'include'
            });
            const [video] = stream.getVideoTracks();
            if (this.destroyed || !isLive(video)) {
                stopStream(stream);
                this.closeAudioMix();
                return this.state;
            }
            if ('contentHint' in video) video.contentHint = 'detail';
            this.displayStream = stream;
            video.addEventListener('ended', () => void this.stopShare(stream), { once: true });
            const [audio] = stream.getAudioTracks();
            if (audio) {
                audio.addEventListener('ended', () => void this.refresh(), { once: true });
            } else {
                this.closeAudioMix();
            }
            await this.refresh();
        } catch (error) {
            this.closeAudioMix();
            if (!this.destroyed && error.name !== 'NotAllowedError') {
                this.notify('Could not share your screen');
            }
        } finally {
            this.pendingShare = false;
        }
        return this.state;
    }

    async stopShare(stream) {
        if (this.displayStream !== stream) return;
        this.displayStream = null;
        stopStream(stream);
        this.closeAudioMix();
        await this.refresh();
    }

    startAudioMix() {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        try {
            const context = new AudioContextClass();
            this.audioMix = { context, destination: null, inputs: new Map() };
            const destination = context.createMediaStreamDestination();
            destination.channelCount = 1;
            this.audioMix.destination = destination;
            context.onstatechange = () => {
                if (this.audioMix?.context === context && this.displayStream) void this.refresh();
            };
            // Resume during the same user gesture as the browser's display picker.
            void context.resume().catch(() => {});
        } catch {
            this.closeAudioMix();
        }
    }

    closeAudioMix() {
        if (!this.audioMix) return;
        const { context, destination, inputs } = this.audioMix;
        this.audioMix = null;
        context.onstatechange = null;
        for (const source of inputs.values()) source.disconnect();
        stopStream(destination?.stream);
        void context.close().catch(() => {});
    }

    outgoingAudio() {
        const mic = this.state.mic ? this.devices.mic : null;
        const sharedAudio = this.displayStream?.getAudioTracks().find(isLive);
        const mix = this.audioMix;
        if (mix) {
            const tracks = [mic, sharedAudio].filter(Boolean);
            for (const [track, source] of mix.inputs) {
                if (tracks.includes(track)) continue;
                source.disconnect();
                mix.inputs.delete(track);
            }
            if (tracks.length === 2 && mix.context.state === 'running') {
                try {
                    for (const track of tracks) {
                        if (mix.inputs.has(track)) continue;
                        const source = mix.context.createMediaStreamSource(new MediaStream([track]));
                        source.connect(mix.destination);
                        mix.inputs.set(track, source);
                    }
                    return mix.destination.stream.getAudioTracks()[0];
                } catch {
                    this.closeAudioMix();
                }
            }
        }
        return mic || sharedAudio || null;
    }

    setIceServers(servers) {
        const iceServers = Array.isArray(servers) ? [...stunServers, ...servers] : stunServers;
        if (JSON.stringify(iceServers) === JSON.stringify(this.iceServers)) return;
        this.iceServers = iceServers;
        for (const { pc } of this.peers.values()) {
            if (pc.signalingState === 'closed' || !pc.getConfiguration) continue;
            try {
                pc.setConfiguration({ ...pc.getConfiguration(), iceServers });
            } catch (error) {
                console.warn('Could not refresh meeting ICE settings', error);
            }
        }
    }

    localTracks() {
        const { camera, sharing } = this.state;
        return {
            audio: this.outgoingAudio(),
            video: sharing ? this.displayStream.getVideoTracks()[0] : camera ? this.devices.camera : null
        };
    }

    syncStream(stream, tracks) {
        for (const track of stream.getTracks()) {
            if (!tracks.includes(track)) stream.removeTrack(track);
        }
        for (const track of tracks) {
            if (!stream.getTracks().includes(track)) stream.addTrack(track);
        }
    }

    async refresh() {
        if (this.destroyed) return;
        const state = this.state;
        if (state.camera) this.devices.camera.enabled = !state.sharing;
        const { audio, video } = this.localTracks();
        this.syncStream(this.preview, [video].filter(Boolean));
        this.syncStream(this.outbound, [audio, video].filter(Boolean));
        this.onLocal(this.preview, state);
        await Promise.all(Array.from(this.peers, ([userId, peer]) =>
            this.queue(userId, peer, () => this.syncSenders(peer))
        ));
    }

    async replaceSenderTrack(peer, sender, track) {
        try {
            await sender.replaceTrack(track);
        } catch (error) {
            if (this.destroyed || peer.pc.signalingState === 'closed') return;
            if (!this.state.sharing || track?.kind !== 'video' ||
                error.name !== 'InvalidModificationError' || !track.applyConstraints) throw error;
            await track.applyConstraints({ width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 24 } });
            await sender.replaceTrack(track);
        }
    }

    async syncSenders(peer) {
        const tracks = this.localTracks();
        await Promise.all(mediaKinds.map(async kind => {
            const sender = peer.senders[kind];
            const track = tracks[kind];
            if (!sender || sender.track === track) return;
            try {
                await this.replaceSenderTrack(peer, sender, track);
            } catch (error) {
                if (peer.pc.signalingState === 'closed') return;
                console.warn('Could not update outgoing ' + kind, error);
                this.notify(kind === 'video' ? 'Could not update outgoing video' : 'Could not update outgoing audio');
            }
        }));
    }

    addPeer(userId, initiate = false, participantId = null) {
        if (this.destroyed) return Promise.resolve();
        let peer = this.peers.get(userId);
        if (peer && participantId && peer.participantId && peer.participantId !== participantId) {
            this.removePeer(userId);
            peer = null;
        }
        if (!peer) {
            try {
                const pc = new RTCPeerConnection({ iceServers: this.iceServers });
                peer = {
                    pc, participantId, initiate,
                    stream: new MediaStream(), senders: {}, completedLocalIce: new Set(),
                    candidates: [], outgoingCandidates: [],
                    queue: Promise.resolve(), restarts: 0, status: 'connecting'
                };
                this.peers.set(userId, peer);
                this.onStatus(userId, 'connecting');
                pc.onicecandidate = ({ candidate }) => {
                    if (this.peers.get(userId) !== peer) return;
                    if (candidate) {
                        if (candidate.candidate === '' && candidate.usernameFragment) {
                            peer.completedLocalIce.add(candidate.usernameFragment);
                        }
                        this.queueLocalCandidate(userId, peer, candidate);
                    } else if (pc.iceGatheringState === 'complete') {
                        // Some browsers send only the gathering-complete event.
                        for (const fragment of iceFragments(pc.localDescription)) {
                            if (peer.completedLocalIce.has(fragment)) continue;
                            peer.completedLocalIce.add(fragment);
                            this.queueLocalCandidate(userId, peer, { candidate: '', usernameFragment: fragment });
                        }
                    }
                };
                pc.ontrack = ({ track }) => {
                    const update = () => {
                        if (this.peers.get(userId) === peer) this.onRemote(userId, peer.stream);
                    };
                    if (!peer.stream.getTracks().includes(track)) peer.stream.addTrack(track);
                    track.addEventListener('mute', update);
                    track.addEventListener('unmute', update);
                    track.addEventListener('ended', () => {
                        peer.stream.removeTrack(track);
                        update();
                    }, { once: true });
                    update();
                };
                pc.onconnectionstatechange = () => this.watchConnection(userId, peer);
                pc.oniceconnectionstatechange = () => this.watchConnection(userId, peer);
                this.scheduleRecovery(userId, peer, ICE_TIMEOUT);
            } catch (error) {
                console.warn('Could not create a meeting peer connection', error);
                this.onStatus(userId, 'failed');
                return Promise.resolve();
            }
        }
        if (participantId) peer.participantId = participantId;
        if (!initiate) return peer.queue;
        return this.queue(userId, peer, async () => {
            if (peer.pc.localDescription || peer.pc.remoteDescription) return;
            await this.offer(userId, peer);
        });
    }

    async offer(userId, peer, restart = false) {
        const { pc } = peer;
        if (pc.signalingState === 'have-local-offer') {
            await pc.setLocalDescription({ type: 'rollback' });
        }
        if (pc.signalingState !== 'stable') return;

        const tracks = this.localTracks();
        this.syncStream(this.outbound, Object.values(tracks).filter(Boolean));
        for (const kind of mediaKinds) {
            if (peer.senders[kind]) continue;
            // Attach available capture tracks as part of the first offer.
            peer.senders[kind] = tracks[kind]
                ? pc.addTrack(tracks[kind], this.outbound)
                : pc.addTransceiver(kind, { direction: 'sendrecv', streams: [this.outbound] }).sender;
        }
        await this.describe(userId, peer, await pc.createOffer({ iceRestart: restart }));
    }

    watchConnection(userId, peer) {
        if (this.peers.get(userId) !== peer) return;
        const { connectionState, iceConnectionState } = peer.pc;
        const probing = peer.keepRecovering && peer.restarts >= MAX_RESTARTS;
        if (transportConnected(peer.pc)) {
            if (peer.videoStalled) return;
            clearTimeout(peer.recovery);
            peer.recovery = null;
            peer.restarts = 0;
            this.setStatus(userId, peer, 'connected');
        } else if (connectionState === 'failed' || iceConnectionState === 'failed') {
            this.setStatus(userId, peer, 'reconnecting');
            this.scheduleRecovery(userId, peer, probing ? BACKGROUND_ICE_TIMEOUT : 300, true);
        } else if (connectionState === 'disconnected' || iceConnectionState === 'disconnected') {
            this.setStatus(userId, peer, 'reconnecting');
            this.scheduleRecovery(userId, peer, probing ? BACKGROUND_ICE_TIMEOUT : 3500, true);
        } else if (!peer.recovery) {
            this.scheduleRecovery(userId, peer, ICE_TIMEOUT);
        }
    }

    setStatus(userId, peer, value) {
        if (peer.status === value) return;
        peer.status = value;
        this.onStatus(userId, value);
    }

    async getPeerStats(userId) {
        const pc = this.peers.get(userId)?.pc;
        if (!pc || pc.signalingState === 'closed') return null;
        try {
            return await pc.getStats();
        } catch {
            return null;
        }
    }

    setPeerVideoExpected(userId, expected, sharing = false) {
        const peer = this.peers.get(userId);
        if (!peer || (peer.expectVideo === expected && peer.expectScreen === sharing)) return;
        peer.expectVideo = expected;
        peer.expectScreen = sharing;
        peer.videoSample = null;
        peer.videoRevision = (peer.videoRevision || 0) + 1;
        if (!expected && peer.videoStalled) {
            peer.videoStalled = false;
            this.watchConnection(userId, peer);
        }
        this.updateVideoMonitor();
    }

    updateVideoMonitor() {
        const active = [...this.peers.values()].some(peer => peer.expectVideo);
        if (active && !this.videoMonitor) {
            this.videoMonitor = setInterval(() => {
                for (const [userId, peer] of this.peers) void this.sampleInboundVideo(userId, peer);
            }, VIDEO_SAMPLE_MS);
        } else if (!active && this.videoMonitor) {
            clearInterval(this.videoMonitor);
            this.videoMonitor = null;
        }
    }

    async sampleInboundVideo(userId, peer) {
        const { pc } = peer;
        if (!peer.expectVideo || !transportConnected(pc) ||
            (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
            peer.videoSample = null;
            return;
        }
        if (peer.samplingVideo || !pc.getStats) return;
        peer.samplingVideo = true;
        const revision = peer.videoRevision;
        try {
            const stats = await pc.getStats();
            if (this.peers.get(userId) !== peer || revision !== peer.videoRevision || !transportConnected(pc)) return;
            let decoded = null;
            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && (report.kind || report.mediaType) === 'video' &&
                    Number.isFinite(report.framesDecoded)) {
                    decoded = (decoded ?? 0) + report.framesDecoded;
                }
            });
            const live = peer.stream.getVideoTracks().some(track => isLive(track) && !track.muted);
            const now = performance.now();
            const previous = peer.videoSample;
            const fresh = !previous || now - previous.at > VIDEO_SAMPLE_MS * 3;
            // A static shared screen can legitimately produce no new frames.
            const progressing = Boolean(live && (decoded === null ||
                (decoded > 0 && (peer.expectScreen || fresh || decoded !== previous.decoded))));
            const lastProgress = fresh || progressing ? now : previous.lastProgress;
            peer.videoSample = { at: now, decoded, lastProgress };
            if (progressing && peer.videoStalled) {
                peer.videoStalled = false;
                this.watchConnection(userId, peer);
            } else if (!peer.videoStalled && now - lastProgress >= VIDEO_STALL_MS) {
                peer.videoStalled = true;
                this.setStatus(userId, peer, 'reconnecting');
                if (peer.initiate) this.scheduleRecovery(userId, peer, 300, true);
            }
        } catch {
            // Statistics are advisory and may be unavailable during a browser transition.
        } finally {
            peer.samplingVideo = false;
        }
    }

    keepProbing(userId) {
        const peer = this.peers.get(userId);
        if (!peer || peer.keepRecovering) return;
        peer.keepRecovering = true;
        if (peer.initiate && peer.status !== 'connected' && !peer.recovery) {
            this.scheduleRecovery(userId, peer, 1200);
        }
    }

    scheduleRecovery(userId, peer, delay, replace = false) {
        if (peer.recovery && !replace) return;
        clearTimeout(peer.recovery);
        peer.recovery = setTimeout(() => {
            peer.recovery = null;
            void this.queue(userId, peer, async () => {
                if (peer.status === 'connected') return;
                // The original offerer owns restarts, so both ends never offer at once.
                if (!peer.initiate || (peer.restarts >= MAX_RESTARTS && !peer.keepRecovering)) {
                    this.setStatus(userId, peer, 'failed');
                    return;
                }
                peer.restarts++;
                this.setStatus(userId, peer, 'reconnecting');
                this.scheduleRecovery(userId, peer, peer.restarts > MAX_RESTARTS ? BACKGROUND_ICE_TIMEOUT : ICE_TIMEOUT);
                await this.offer(userId, peer, true);
            });
        }, delay);
    }

    queue(userId, peer, operation) {
        peer.queue = peer.queue.then(() => {
            if (this.peers.get(userId) === peer) return operation();
        }).catch(error => {
            if (this.peers.get(userId) === peer) console.warn('Meeting media update failed', error);
        });
        return peer.queue;
    }

    sendCandidate(userId, peer, candidate) {
        return this.send('ice-candidate', { to: userId, toParticipantId: peer.participantId, data: { candidate } }) !== false;
    }

    queueLocalCandidate(userId, peer, candidate) {
        if (peer.descriptionSent && this.sendCandidate(userId, peer, candidate)) return;
        if (peer.outgoingCandidates.length >= MAX_ICE_CANDIDATES) peer.outgoingCandidates.shift();
        peer.outgoingCandidates.push(candidate);
    }

    flushLocalSignals(userId, peer) {
        const sdp = peer.pc.localDescription;
        if (!sdp) return;
        if (!peer.descriptionSent) {
            peer.descriptionSent = this.send(sdp.type, {
                to: userId, toParticipantId: peer.participantId, data: { sdp }
            }) !== false;
            if (!peer.descriptionSent) return;
        }
        for (const candidate of peer.outgoingCandidates.splice(0)) {
            if (candidateMatches(sdp, candidate)) this.queueLocalCandidate(userId, peer, candidate);
        }
    }

    signalingResumed() {
        for (const [userId, peer] of this.peers) {
            void this.queue(userId, peer, () => this.flushLocalSignals(userId, peer));
        }
    }

    async describe(userId, peer, description) {
        peer.descriptionSent = false;
        const fragments = iceFragments(description);
        peer.completedLocalIce = new Set([...peer.completedLocalIce].filter(fragment => fragments.has(fragment)));
        await peer.pc.setLocalDescription(description);
        if (this.peers.get(userId) !== peer) return;
        this.flushLocalSignals(userId, peer);
    }

    async applyCandidate(pc, candidate) {
        try {
            await pc.addIceCandidate(candidate);
        } catch (error) {
            if (pc.signalingState !== 'closed') console.warn('Could not apply a meeting ICE candidate', error);
        }
    }

    configureAnswer(peer) {
        const { pc } = peer;
        const tracks = this.localTracks();
        this.syncStream(this.outbound, Object.values(tracks).filter(Boolean));
        for (const transceiver of pc.getTransceivers()) {
            if (transceiver.mid === null) continue;
            const { kind } = transceiver.receiver.track;
            peer.senders[kind] = transceiver.sender;
            if (!transceiver.sender.track && tracks[kind] && !pc.currentRemoteDescription) {
                // addTrack reuses the offered, unbound transceiver on its first answer.
                try {
                    const attached = pc.addTrack(tracks[kind], this.outbound);
                    if (attached !== transceiver.sender) pc.removeTrack(attached);
                } catch (error) {
                    console.warn('Could not attach initial outgoing ' + kind, error);
                }
            }
            transceiver.direction = 'sendrecv';
        }
    }

    async handleSignal({ type, from, fromParticipantId, data }) {
        if (this.destroyed || !from || !data) return;
        if (!this.peers.has(from)) await this.addPeer(from, false, fromParticipantId);
        const peer = this.peers.get(from);
        if (!peer || (fromParticipantId && peer.participantId && fromParticipantId !== peer.participantId)) return;

        return this.queue(from, peer, async () => {
            const { pc } = peer;
            if (type === 'ice-candidate' && data.candidate) {
                if (candidateMatches(pc.remoteDescription, data.candidate)) {
                    await this.applyCandidate(pc, data.candidate);
                } else if (peer.candidates.length < MAX_ICE_CANDIDATES) {
                    peer.candidates.push(data.candidate);
                }
                return;
            }
            if ((type !== 'offer' && type !== 'answer') || data.sdp?.type !== type) return;
            if (type === 'answer' && pc.signalingState !== 'have-local-offer') return;
            await pc.setRemoteDescription(data.sdp);
            for (const candidate of peer.candidates.splice(0)) {
                if (candidateMatches(pc.remoteDescription, candidate)) await this.applyCandidate(pc, candidate);
            }
            if (type === 'offer') {
                if (peer.status !== 'connected') this.setStatus(from, peer, 'connecting');
                this.scheduleRecovery(from, peer, ICE_TIMEOUT, true);
                this.configureAnswer(peer);
                await this.describe(from, peer, await pc.createAnswer());
                await this.syncSenders(peer);
            }
        });
    }

    removePeer(userId) {
        const peer = this.peers.get(userId);
        if (!peer) return;
        this.peers.delete(userId);
        this.updateVideoMonitor();
        clearTimeout(peer.recovery);
        peer.pc.ontrack = null;
        peer.pc.onicecandidate = null;
        peer.pc.onconnectionstatechange = null;
        peer.pc.oniceconnectionstatechange = null;
        peer.pc.close();
        this.onRemoteRemoved(userId);
    }

    destroy() {
        this.destroyed = true;
        for (const userId of this.peers.keys()) this.removePeer(userId);
        for (const track of Object.values(this.devices)) track?.stop();
        this.devices = { mic: null, camera: null };
        stopStream(this.displayStream);
        this.displayStream = null;
        this.closeAudioMix();
        this.syncStream(this.preview, []);
        this.syncStream(this.outbound, []);
    }
}
