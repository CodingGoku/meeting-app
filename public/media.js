const stunServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

const isLive = track => track?.readyState === 'live';
const stopStream = stream => stream?.getTracks().forEach(track => track.stop());
const ICE_TIMEOUT = 11000;
const MAX_RESTARTS = 2;
const BACKGROUND_ICE_TIMEOUT = 25000;
const mediaKinds = ['audio', 'video'];
const cameraConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };

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

    async prepare({ mic, camera }) {
        if (mic && camera && navigator.mediaDevices?.getUserMedia) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: cameraConstraints });
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
        this.devices[device]?.stop();
        this.devices[device] = track;
        if (device === 'camera' && 'contentHint' in track) track.contentHint = 'motion';
        track.addEventListener('ended', () => {
            if (this.devices[device] !== track) return;
            this.devices[device] = null;
            void this.refresh();
        }, { once: true });
    }

    async openDevice(device) {
        if (!navigator.mediaDevices?.getUserMedia) return false;
        const kind = device === 'mic' ? 'audio' : 'video';
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ [kind]: device === 'camera' ? cameraConstraints : true });
            const [track] = stream.getTracks();
            this.setDevice(device, track);
            return isLive(this.devices[device]);
        } catch {
            return false;
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

    async toggleShare(includeAudio = false) {
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
            if (includeAudio) this.startAudioMix();
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 24, max: 30 } },
                audio: includeAudio
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
                if (includeAudio) this.notify('The selected source did not provide shared audio');
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
        this.iceServers = Array.isArray(servers) ? [...stunServers, ...servers] : stunServers;
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
                    stream: new MediaStream(), senders: {},
                    candidates: [], outgoingCandidates: [],
                    queue: Promise.resolve(), restarts: 0, status: 'connecting'
                };
                this.peers.set(userId, peer);
                this.onStatus(userId, 'connecting');
                pc.onicecandidate = ({ candidate }) => {
                    if (!candidate || this.peers.get(userId) !== peer) return;
                    if (peer.descriptionSent) this.sendCandidate(userId, peer, candidate);
                    else peer.outgoingCandidates.push(candidate);
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
        if (connectionState === 'connected' ||
            (!connectionState && ['connected', 'completed'].includes(iceConnectionState))) {
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
        this.send('ice-candidate', { to: userId, toParticipantId: peer.participantId, data: { candidate } });
    }

    async describe(userId, peer, description) {
        peer.descriptionSent = false;
        await peer.pc.setLocalDescription(description);
        if (this.peers.get(userId) !== peer) return;
        const { localDescription: sdp } = peer.pc;
        peer.descriptionSent = this.send(sdp.type, { to: userId, toParticipantId: peer.participantId, data: { sdp } }) !== false;
        if (peer.descriptionSent) {
            for (const candidate of peer.outgoingCandidates.splice(0)) this.sendCandidate(userId, peer, candidate);
        }
    }

    candidateMatches(pc, candidate) {
        const sdp = pc.remoteDescription?.sdp;
        return Boolean(sdp && (!candidate.usernameFragment ||
            sdp.split(/\r?\n/).includes('a=ice-ufrag:' + candidate.usernameFragment)));
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
                if (this.candidateMatches(pc, data.candidate)) {
                    await this.applyCandidate(pc, data.candidate);
                } else if (peer.candidates.length < 192) {
                    peer.candidates.push(data.candidate);
                }
                return;
            }
            if ((type !== 'offer' && type !== 'answer') || data.sdp?.type !== type) return;
            if (type === 'answer' && pc.signalingState !== 'have-local-offer') return;
            await pc.setRemoteDescription(data.sdp);
            for (const candidate of peer.candidates.splice(0)) {
                if (this.candidateMatches(pc, candidate)) await this.applyCandidate(pc, candidate);
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
