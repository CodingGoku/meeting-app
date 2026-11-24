const videoKind = 1;
const audioKind = 2;
const maxVideoBytes = 128 * 1024 - 37;
const maxVideoEdge = 1440;
const audioSampleRate = 16000;
const audioPacketBytes = 640;
const videoInterval = 125;
const audioLead = 0.08;
const maxAudioAhead = 0.28;
const screenProfiles = [[maxVideoEdge, 0.82], [maxVideoEdge, 0.68], [1200, 0.74], [960, 0.69], [720, 0.64]];
const cameraProfiles = [[640, 0.71], [480, 0.66], [360, 0.6]];

const decodedSamples = Float32Array.from({ length: 256 }, (_, code) => {
    const value = (~code) & 0xff;
    const magnitude = (((value & 0x0f) << 3) + 0x84) << ((value >> 4) & 7);
    return (value & 0x80 ? 0x84 - magnitude : magnitude - 0x84) / 32768;
});

function validVideoFrame(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.byteLength > maxVideoBytes) return false;
    let offset = 2;
    while (offset + 3 < bytes.byteLength && bytes[offset++] === 0xff) {
        while (bytes[offset] === 0xff) offset++;
        const marker = bytes[offset++];
        const length = (bytes[offset] << 8) | bytes[offset + 1];
        if (marker === 0xda || length < 2 || offset + length > bytes.byteLength) return false;
        if (marker >= 0xc0 && marker <= 0xc2 && length >= 8) {
            const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
            const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
            return width > 0 && width <= maxVideoEdge && height > 0 && height <= maxVideoEdge;
        }
        offset += length;
    }
    return false;
}

export class RelayMedia {
    constructor({ sendFrame, onVideo, onAudioBlocked, notify = () => {} }) {
        this.sendFrame = sendFrame;
        this.onVideo = onVideo;
        this.onAudioBlocked = onAudioBlocked;
        this.notify = notify;
        this.peers = new Map();
        this.reported = new Set();
        this.frameVersion = 0;
        this.captureVersion = 0;
        this.videoProfile = 0;
        this.goodFrames = 0;
    }

    setLocal(videoElement, audioTrack, sharing) {
        if (this.destroyed) return;
        this.video = videoElement;
        if (this.sharing !== sharing) {
            this.videoProfile = 0;
            this.goodFrames = 0;
        }
        this.sharing = sharing;
        this.frameVersion++;
        if (this.audioTrack === audioTrack) return;
        this.audioTrack = audioTrack;
        this.stopAudioCapture();
        this.startAudioCapture();
    }

    addPeer(participantId) {
        if (this.destroyed || this.peers.has(participantId)) return;
        this.peers.set(participantId, { audioNodes: new Set(), nextAudioAt: 0 });
        if (this.peers.size === 1) {
            this.frameTimer = setInterval(() => this.captureVideo(), videoInterval);
            this.captureVideo();
            this.startAudioCapture();
        }
        this.refreshAudioState();
    }

    removePeer(participantId) {
        const peer = this.peers.get(participantId);
        if (!peer) return;
        this.peers.delete(participantId);
        for (const node of peer.audioNodes) node.stop();
        if (this.peers.size === 0) {
            clearInterval(this.frameTimer);
            this.frameVersion++;
            this.stopAudioCapture();
        }
        this.refreshAudioState();
    }

    enableAudio() {
        if (this.destroyed) return;
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) {
            this.refreshAudioState();
            return;
        }
        try {
            if (!this.audioContext) {
                this.audioContext = new Context({ latencyHint: 'interactive' });
                this.audioContext.onstatechange = () => this.refreshAudioState();
            }
            if (this.audioContext.state !== 'running') {
                void this.audioContext.resume().then(() => this.refreshAudioState()).catch(() => this.refreshAudioState());
            }
        } catch {
            if (this.peers.size) this.report('audio', 'This browser could not start meeting audio over the relay.');
        }
        this.refreshAudioState();
    }

    receive(participantId, kind, bytes) {
        const peer = this.peers.get(participantId);
        if (!peer) return;
        if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
        if (kind === videoKind && !peer.decodingVideo && validVideoFrame(bytes)) {
            void this.renderVideo(participantId, peer, bytes);
        }
        if (kind === audioKind && bytes.byteLength === audioPacketBytes) this.renderAudio(peer, bytes);
    }

    async captureVideo() {
        const video = this.video;
        if (this.capturingFrame || !this.peers.size || !video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
        if (video.srcObject && !video.srcObject.getVideoTracks().some(track => track.readyState === 'live')) return;

        this.canvas ||= document.createElement('canvas');
        const canvas = this.canvas;
        const profiles = this.sharing ? screenProfiles : cameraProfiles;
        const version = this.frameVersion;
        this.capturingFrame = true;
        const currentFrame = () => !this.destroyed && version === this.frameVersion && this.peers.size;
        try {
            for (let attempt = 0; attempt < 2 && currentFrame(); attempt++) {
                const [edge, quality] = profiles[this.videoProfile];
                const scale = Math.min(1, edge / Math.max(video.videoWidth, video.videoHeight));
                const width = Math.max(1, Math.round(video.videoWidth * scale));
                const height = Math.max(1, Math.round(video.videoHeight * scale));
                if (canvas.width !== width) canvas.width = width;
                if (canvas.height !== height) canvas.height = height;
                canvas.getContext('2d').drawImage(video, 0, 0, width, height);
                const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
                if (!blob || !currentFrame()) return;
                if (blob.size > maxVideoBytes) {
                    this.videoProfile = Math.min(profiles.length - 1, this.videoProfile + 1);
                    this.goodFrames = 0;
                    continue;
                }
                const bytes = new Uint8Array(await blob.arrayBuffer());
                if (!currentFrame()) return;
                const sent = this.broadcast(videoKind, bytes);
                if (!sent) {
                    this.videoProfile = Math.min(profiles.length - 1, this.videoProfile + 1);
                    this.goodFrames = 0;
                } else if (sent === this.peers.size && ++this.goodFrames >= 24) {
                    this.videoProfile = Math.max(0, this.videoProfile - 1);
                    this.goodFrames = 0;
                }
                return;
            }
        } catch {
            this.report('video', 'This browser could not capture video for the meeting relay.');
        } finally {
            this.capturingFrame = false;
        }
    }

    async renderVideo(participantId, peer, bytes) {
        peer.decodingVideo = true;
        let bitmap;
        try {
            const blob = new Blob([bytes], { type: 'image/jpeg' });
            if (typeof createImageBitmap === 'function') {
                bitmap = await createImageBitmap(blob);
            } else {
                const url = URL.createObjectURL(blob);
                try {
                    const image = new Image();
                    bitmap = await new Promise((resolve, reject) => {
                        image.onload = () => resolve(image);
                        image.onerror = reject;
                        image.src = url;
                    });
                } finally {
                    URL.revokeObjectURL(url);
                }
            }
            if (this.peers.get(participantId) === peer) this.onVideo(participantId, bitmap);
        } catch {
            // A malformed or superseded individual JPEG can be discarded.
        } finally {
            bitmap?.close?.();
            peer.decodingVideo = false;
        }
    }

    refreshAudioState() {
        const blocked = this.peers.size > 0 && this.audioContext?.state !== 'running';
        if (this.audioBlocked !== blocked) {
            this.audioBlocked = blocked;
            this.onAudioBlocked(blocked);
        }
        if (!blocked) this.startAudioCapture();
    }

    startAudioCapture() {
        const context = this.audioContext;
        const track = this.audioTrack;
        if (!this.peers.size || context?.state !== 'running' || track?.readyState !== 'live' || this.capture || this.capturePending) return;
        if (!context.audioWorklet || typeof AudioWorkletNode !== 'function') {
            this.report('capture-audio', 'This browser cannot send microphone audio over the meeting relay.');
            return;
        }

        const version = this.captureVersion;
        this.capturePending = true;
        this.audioWorklet ||= context.audioWorklet.addModule(new URL('./relay-audio.js?v=4', import.meta.url));
        void this.audioWorklet.then(() => {
            if (version !== this.captureVersion || this.destroyed || !this.peers.size || track.readyState !== 'live') return;
            const source = context.createMediaStreamSource(new MediaStream([track]));
            const node = new AudioWorkletNode(context, 'relay-audio-capture', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                channelCount: 1,
                channelCountMode: 'explicit',
                outputChannelCount: [1]
            });
            this.capture = { source, node };
            node.port.onmessage = ({ data }) => {
                if (this.capture?.node !== node) return;
                try {
                    if (data instanceof Uint8Array && data.byteLength === audioPacketBytes) this.broadcast(audioKind, data);
                } finally {
                    node.port.postMessage(true);
                }
            };
            source.connect(node);
            // Keep the worklet running. It outputs silence to avoid local monitoring.
            node.connect(context.destination);
        }).catch(() => {
            if (version !== this.captureVersion || this.destroyed) return;
            this.stopAudioCapture();
            this.report('capture-audio', 'This browser could not start microphone audio over the meeting relay.');
        }).finally(() => {
            if (version === this.captureVersion) this.capturePending = false;
        });
    }

    stopAudioCapture() {
        this.captureVersion++;
        this.capturePending = false;
        if (!this.capture) return;
        const { source, node } = this.capture;
        this.capture = null;
        source.disconnect();
        node.port.onmessage = null;
        node.port.close();
        node.disconnect();
    }

    renderAudio(peer, bytes) {
        const context = this.audioContext;
        if (context?.state !== 'running') {
            this.refreshAudioState();
            return;
        }
        const now = context.currentTime;
        if (peer.nextAudioAt > now + maxAudioAhead) return;
        if (peer.nextAudioAt <= now + 0.01) peer.nextAudioAt = now + audioLead;

        const buffer = context.createBuffer(1, audioPacketBytes, audioSampleRate);
        const samples = buffer.getChannelData(0);
        for (let index = 0; index < audioPacketBytes; index++) samples[index] = decodedSamples[bytes[index]];
        const node = context.createBufferSource();
        node.buffer = buffer;
        node.connect(context.destination);
        peer.audioNodes.add(node);
        node.onended = () => {
            peer.audioNodes.delete(node);
            node.disconnect();
        };
        node.start(peer.nextAudioAt);
        peer.nextAudioAt += buffer.duration;
    }

    broadcast(kind, bytes) {
        let sent = 0;
        for (const participantId of this.peers.keys()) {
            if (this.sendFrame(participantId, kind, bytes)) sent++;
        }
        return sent;
    }

    report(kind, message) {
        if (this.reported.has(kind)) return;
        this.reported.add(kind);
        this.notify(message);
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        for (const participantId of this.peers.keys()) this.removePeer(participantId);
        this.stopAudioCapture();
        if (this.audioContext) {
            this.audioContext.onstatechange = null;
            if (this.audioContext.state !== 'closed') void this.audioContext.close().catch(() => {});
        }
    }
}
