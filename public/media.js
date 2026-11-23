const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
        urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443'],
        username: 'openrelayproject',
        credential: 'openrelayproject'
    }
];

const isLive = track => track?.readyState === 'live';
const stopStream = stream => stream?.getTracks().forEach(track => track.stop());

export class MeetingMedia {
    constructor({ send, onLocal, onRemote, onRemoteRemoved, notify }) {
        this.send = send;
        this.onLocal = onLocal;
        this.onRemote = onRemote;
        this.onRemoteRemoved = onRemoteRemoved;
        this.notify = notify;
        this.preview = new MediaStream();
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
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
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
            const stream = await navigator.mediaDevices.getUserMedia({ [kind]: true });
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
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: includeAudio });
            const [video] = stream.getVideoTracks();
            if (this.destroyed || !isLive(video)) {
                stopStream(stream);
                this.closeAudioMix();
                return this.state;
            }
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

    async refresh() {
        if (this.destroyed) return;
        const state = this.state;
        const camera = state.camera ? this.devices.camera : null;
        if (camera) camera.enabled = !state.sharing;
        const video = state.sharing ? this.displayStream.getVideoTracks()[0] : camera;
        for (const track of this.preview.getVideoTracks()) {
            if (track !== video) this.preview.removeTrack(track);
        }
        if (video && !this.preview.getVideoTracks().includes(video)) this.preview.addTrack(video);
        this.onLocal(this.preview, state);
        await Promise.all(Array.from(this.peers.entries(), ([userId, peer]) =>
            this.queue(userId, peer, () => this.syncSenders(peer))
        ));
    }

    async syncSenders(peer) {
        const state = this.state;
        const video = state.sharing ? this.displayStream.getVideoTracks()[0] : this.devices.camera;
        const audio = this.outgoingAudio();
        const updates = [];
        if (peer.videoSender && peer.videoSender.track !== video) {
            updates.push(peer.videoSender.replaceTrack(isLive(video) ? video : null));
        }
        if (peer.audioSender && peer.audioSender.track !== audio) {
            updates.push(peer.audioSender.replaceTrack(audio));
        }
        await Promise.all(updates);
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
                const pc = new RTCPeerConnection({ iceServers });
                peer = {
                    pc,
                    participantId,
                    stream: new MediaStream(),
                    candidates: [],
                    queue: Promise.resolve(),
                    audioSender: null,
                    videoSender: null
                };
                this.peers.set(userId, peer);
                pc.onicecandidate = ({ candidate }) => {
                    if (candidate) this.send('ice-candidate', { to: userId, data: { candidate } });
                };
                pc.ontrack = ({ track }) => {
                    const update = () => {
                        if (this.peers.get(userId) === peer) this.onRemote(userId, peer.stream);
                    };
                    peer.stream.addTrack(track);
                    track.addEventListener('mute', update);
                    track.addEventListener('unmute', update);
                    track.addEventListener('ended', () => {
                        peer.stream.removeTrack(track);
                        update();
                    }, { once: true });
                    update();
                };
                pc.onconnectionstatechange = () => {
                    if (pc.connectionState === 'failed' && this.peers.get(userId) === peer) {
                        this.onRemoteRemoved(userId);
                        this.notify('Could not connect meeting media to a participant');
                    }
                };
            } catch {
                if (!this.unavailableReported) {
                    this.unavailableReported = true;
                    this.notify('Calling is unavailable in this browser');
                }
                return Promise.resolve();
            }
        }
        if (participantId) peer.participantId = participantId;
        if (!initiate) return peer.queue;
        return this.queue(userId, peer, async () => {
            const { pc } = peer;
            if (pc.localDescription || pc.remoteDescription) return;
            const options = { direction: 'sendrecv', streams: [this.preview] };
            peer.audioSender = pc.addTransceiver('audio', options).sender;
            peer.videoSender = pc.addTransceiver('video', options).sender;
            await this.syncSenders(peer);
            await pc.setLocalDescription(await pc.createOffer());
            this.sendDescription(userId, peer);
        });
    }

    queue(userId, peer, operation) {
        peer.queue = peer.queue.then(() => {
            if (this.peers.get(userId) === peer) return operation();
        }).catch(error => {
            if (this.peers.get(userId) === peer) console.warn('Meeting media update failed', error);
        });
        return peer.queue;
    }

    sendDescription(userId, peer) {
        if (this.peers.get(userId) !== peer) return;
        const { localDescription: sdp } = peer.pc;
        this.send(sdp.type, { to: userId, data: { sdp } });
    }

    async handleSignal({ type, from, data }) {
        if (this.destroyed || !from || !data) return;
        if (!this.peers.has(from)) await this.addPeer(from);
        const peer = this.peers.get(from);
        if (!peer) return;

        return this.queue(from, peer, async () => {
            const { pc } = peer;
            if (type === 'ice-candidate' && data.candidate) {
                if (pc.remoteDescription) {
                    await pc.addIceCandidate(data.candidate);
                } else if (peer.candidates.length < 256) {
                    peer.candidates.push(data.candidate);
                }
                return;
            }
            if ((type !== 'offer' && type !== 'answer') || data.sdp?.type !== type) return;
            if (type === 'answer' && pc.signalingState !== 'have-local-offer') return;
            await pc.setRemoteDescription(data.sdp);
            for (const candidate of peer.candidates.splice(0)) {
                try {
                    await pc.addIceCandidate(candidate);
                } catch (error) {
                    console.warn('Could not apply a meeting ICE candidate', error);
                }
            }
            if (type === 'offer') {
                for (const transceiver of pc.getTransceivers()) {
                    if (transceiver.mid === null) continue;
                    transceiver.direction = 'sendrecv';
                    if (transceiver.receiver.track.kind === 'audio') peer.audioSender = transceiver.sender;
                    if (transceiver.receiver.track.kind === 'video') peer.videoSender = transceiver.sender;
                    transceiver.sender.setStreams?.(this.preview);
                }
                await this.syncSenders(peer);
                await pc.setLocalDescription(await pc.createAnswer());
                this.sendDescription(from, peer);
            }
        });
    }

    removePeer(userId) {
        const peer = this.peers.get(userId);
        if (!peer) return;
        this.peers.delete(userId);
        peer.pc.ontrack = null;
        peer.pc.onicecandidate = null;
        peer.pc.onconnectionstatechange = null;
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
        for (const track of this.preview.getTracks()) this.preview.removeTrack(track);
    }
}
