const videoKind = 1;
const audioKind = 2;
const encodedVideoKind = 3;
const videoControlKind = 4;
const encodedHeaderSize = 11;
const vp8Codec = 'vp8';
const maxVideoBytes = 128 * 1024 - 37;
const maxVideoEdge = 1440;
const maxEncodedEdge = 1920;
const maxEncodedPixels = 1920 * 1080;
const audioSampleRate = 16000;
const audioPacketBytes = 640;
const videoInterval = 125;
const videoFrameRate = 24;
const keyframeInterval = 850;
const audioLead = 0.08;
const maxAudioAhead = 0.28;
const screenProfiles = [[maxVideoEdge, 0.82], [maxVideoEdge, 0.68], [1200, 0.74], [960, 0.69], [720, 0.64]];
const cameraProfiles = [[640, 0.71], [480, 0.66], [360, 0.6]];
const encodedScreenProfiles = [[1920, 2_700_000], [1600, 1_950_000], [1280, 1_300_000], [960, 800_000]];
const encodedCameraProfiles = [[1280, 1_450_000], [960, 950_000], [640, 550_000], [480, 350_000]];

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
    static async supportsEncodedVideo() {
        if (typeof VideoEncoder !== 'function' || typeof VideoDecoder !== 'function' ||
            typeof VideoFrame !== 'function' || typeof EncodedVideoChunk !== 'function') return false;
        try {
            const [encoder, decoder] = await Promise.all([
                VideoEncoder.isConfigSupported({
                    codec: vp8Codec, width: 640, height: 360, bitrate: 550_000,
                    framerate: videoFrameRate, latencyMode: 'realtime'
                }),
                VideoDecoder.isConfigSupported({ codec: vp8Codec, optimizeForLatency: true })
            ]);
            return encoder.supported && decoder.supported;
        } catch {
            return false;
        }
    }

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
        this.encodedProfile = 0;
        this.encodedGoodFrames = 0;
        this.frameSequence = 0;
        this.lastJpegAt = -Infinity;
    }

    setLocal(videoElement, audioTrack, sharing) {
        if (this.destroyed) return;
        if (this.video !== videoElement || this.sharing !== sharing) {
            this.closeEncoder();
            this.encodedProfile = 0;
            this.encodedGoodFrames = 0;
        }
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

    addPeer(participantId, encodedVideo = false) {
        if (this.destroyed || this.peers.has(participantId)) return;
        this.peers.set(participantId, {
            sending: true, receiving: true, sendEncoded: encodedVideo, receiveEncoded: encodedVideo,
            needsKeyframe: true, audioNodes: new Set(), nextAudioAt: 0, decoderErrors: 0
        });
        if (this.peers.size === 1) {
            this.frameTimer = setInterval(() => this.captureFrames(), 1000 / videoFrameRate);
            this.captureFrames();
            this.startAudioCapture();
        }
        this.refreshAudioState();
    }

    removePeer(participantId) {
        const peer = this.peers.get(participantId);
        if (!peer) return;
        this.peers.delete(participantId);
        this.stopPeerPlayback(peer);
        if (this.peers.size === 0) {
            clearInterval(this.frameTimer);
            this.frameVersion++;
        }
        this.releaseIdleCapture();
        this.refreshAudioState();
    }

    setSending(participantId, enabled) {
        const peer = this.peers.get(participantId);
        if (!peer || peer.sending === enabled) return;
        peer.sending = enabled;
        if (enabled) {
            peer.needsKeyframe = true;
            this.startAudioCapture();
        } else {
            this.releaseIdleCapture();
        }
        this.refreshAudioState();
    }

    setReceiving(participantId, enabled) {
        const peer = this.peers.get(participantId);
        if (!peer || peer.receiving === enabled) return;
        peer.receiving = enabled;
        if (!enabled) this.stopPeerPlayback(peer);
        else if (peer.receiveEncoded) this.requestKeyframe(participantId, peer);
        this.refreshAudioState();
    }

    releaseIdleCapture() {
        const peers = [...this.peers.values()];
        if (!peers.some(peer => peer.sending)) this.stopAudioCapture();
        if (!peers.some(peer => peer.sending && peer.sendEncoded)) this.closeEncoder();
    }

    stopPeerPlayback(peer) {
        for (const node of peer.audioNodes) node.stop();
        peer.audioNodes.clear();
        peer.nextAudioAt = 0;
        this.closeDecoder(peer);
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
        if (kind === videoControlKind && peer.sendEncoded && bytes.byteLength === 1) {
            if (bytes[0] === 1) this.markKeyframeRequested(peer);
            if (bytes[0] === 2) {
                peer.sendEncoded = false;
                this.releaseIdleCapture();
            }
            return;
        }
        if (!peer.receiving) return;
        if (kind === encodedVideoKind && peer.receiveEncoded) {
            this.decodeEncodedVideo(participantId, peer, bytes);
        }
        if (kind === videoKind && !peer.decodingVideo && validVideoFrame(bytes)) {
            this.closeDecoder(peer);
            void this.renderVideo(participantId, peer, bytes);
        }
        if (kind === audioKind && bytes.byteLength === audioPacketBytes) this.renderAudio(peer, bytes);
    }

    captureFrames() {
        const peers = [...this.peers.values()];
        const now = performance.now();
        if (!this.codecFailed && peers.some(peer => peer.sending && peer.sendEncoded)) this.encodeVideo(now);
        if (now - this.lastJpegAt >= videoInterval &&
            peers.some(peer => peer.sending && (!peer.sendEncoded || this.codecFailed))) {
            this.lastJpegAt = now;
            void this.captureVideo();
        }
    }

    markKeyframeRequested(peer) {
        peer.needsKeyframe = true;
        if (!peer.sending) return;
        const now = performance.now();
        const previous = peer.lastKeyframeRequest;
        peer.lastKeyframeRequest = now;
        peer.recentKeyframeRequests = previous != null && now - previous < 1100
            ? (peer.recentKeyframeRequests || 0) + 1 : 1;
        if (peer.recentKeyframeRequests < 3) return;
        const peers = [...this.peers.values()].filter(candidate => candidate.sending && candidate.sendEncoded);
        if (peers.some(candidate => (candidate.recentKeyframeRequests ?? 0) < 2 ||
            now - candidate.lastKeyframeRequest > 1100)) return;
        this.lowerEncodedProfile();
        for (const candidate of peers) candidate.recentKeyframeRequests = 0;
    }

    encoderBacklogged(now) {
        const blocked = this.encoder?.encodeQueueSize >= 2;
        this.pressureSince ??= now;
        this.pressureSamples = (this.pressureSamples || 0) + 1;
        if (blocked) this.pressureDrops = (this.pressureDrops || 0) + 1;
        if (now - this.pressureSince >= 1100) {
            if (this.pressureDrops >= 6 && this.pressureDrops / this.pressureSamples >= 0.25) {
                this.lowerEncodedProfile();
            }
            this.pressureSince = now;
            this.pressureSamples = 0;
            this.pressureDrops = 0;
        }
        return blocked;
    }

    encodeVideo(now) {
        const video = this.video;
        if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight || this.encoderBacklogged(now)) return;
        if (video.srcObject && !video.srcObject.getVideoTracks().some(track => track.readyState === 'live')) return;

        const profiles = this.sharing ? encodedScreenProfiles : encodedCameraProfiles;
        const [edge, bitrate] = profiles[this.encodedProfile];
        const scale = Math.min(1, edge / Math.max(video.videoWidth, video.videoHeight),
            Math.sqrt(maxEncodedPixels / (video.videoWidth * video.videoHeight)));
        const width = Math.max(2, 2 * Math.floor(video.videoWidth * scale / 2));
        const height = Math.max(2, 2 * Math.floor(video.videoHeight * scale / 2));
        const sending = [...this.peers.values()].filter(peer => peer.sending && peer.sendEncoded);
        const budget = Math.min(bitrate, Math.round(18_000_000 / sending.length));
        try {
            if (!this.encoder || this.encoderWidth !== width || this.encoderHeight !== height || this.encoderBitrate !== budget) {
                this.startEncoder(width, height, budget);
            }
            const elapsed = now - this.lastKeyframeAt;
            const keyFrame = elapsed >= keyframeInterval ||
                (elapsed >= 280 && sending.some(peer => peer.needsKeyframe));
            if (keyFrame) this.lastKeyframeAt = now;
            // The encoder scales to its configured dimensions without a canvas redraw.
            const frame = new VideoFrame(video, { timestamp: Math.round(now * 1000) });
            try {
                this.encoder.encode(frame, { keyFrame });
            } finally {
                frame.close();
            }
        } catch {
            this.failEncodedCapture();
        }
    }

    startEncoder(width, height, bitrate) {
        this.closeEncoder();
        const encoder = new VideoEncoder({
            output: chunk => {
                if (this.encoder === encoder) this.sendEncodedVideo(chunk, width, height);
            },
            error: () => {
                if (this.encoder === encoder) this.failEncodedCapture();
            }
        });
        this.encoder = encoder;
        this.encoderWidth = width;
        this.encoderHeight = height;
        this.encoderBitrate = bitrate;
        this.lastKeyframeAt = -Infinity;
        this.pressureSince = null;
        this.pressureSamples = 0;
        this.pressureDrops = 0;
        this.lateEncodedFrames = 0;
        encoder.configure({
            codec: vp8Codec, width, height, bitrate, framerate: videoFrameRate,
            latencyMode: 'realtime', alpha: 'discard', contentHint: this.sharing ? 'detail' : 'motion'
        });
    }

    closeEncoder() {
        const encoder = this.encoder;
        this.encoder = null;
        if (encoder && encoder.state !== 'closed') encoder.close();
    }

    failEncodedCapture() {
        this.codecFailed = true;
        this.closeEncoder();
    }

    lowerEncodedProfile(oversized = false) {
        const profiles = this.sharing ? encodedScreenProfiles : encodedCameraProfiles;
        if (this.encodedProfile < profiles.length - 1) this.encodedProfile++;
        else if (oversized) this.failEncodedCapture();
        this.encodedGoodFrames = 0;
        this.encodedDrops = 0;
    }

    sendEncodedVideo(chunk, width, height) {
        const key = chunk.type === 'key';
        const delay = performance.now() - chunk.timestamp / 1000;
        this.lateEncodedFrames = delay > 110 ? this.lateEncodedFrames + 1 : 0;
        if (this.lateEncodedFrames === 5) this.lowerEncodedProfile();
        this.frameSequence = (this.frameSequence + 1) & 0xffff;
        if (chunk.byteLength > maxVideoBytes - encodedHeaderSize) {
            for (const peer of this.peers.values()) peer.needsKeyframe = true;
            this.lowerEncodedProfile(true);
            return;
        }

        const bytes = new Uint8Array(encodedHeaderSize + chunk.byteLength);
        const header = new DataView(bytes.buffer);
        header.setUint16(0, width);
        header.setUint16(2, height);
        header.setUint16(4, this.frameSequence);
        header.setUint32(6, Math.floor(chunk.timestamp / 1000));
        header.setUint8(10, Number(key));
        chunk.copyTo(bytes.subarray(encodedHeaderSize));

        let attempted = 0;
        let sent = 0;
        for (const [participantId, peer] of this.peers) {
            if (!peer.sending || !peer.sendEncoded || (peer.needsKeyframe && !key)) continue;
            attempted++;
            if (this.sendFrame(participantId, encodedVideoKind, bytes)) {
                peer.needsKeyframe = false;
                sent++;
            } else {
                peer.needsKeyframe = true;
            }
        }
        if (!attempted) return;
        if (!sent) {
            this.encodedGoodFrames = 0;
            this.encodedDrops = (this.encodedDrops || 0) + 1;
            if (this.encodedDrops >= 3) this.lowerEncodedProfile();
        } else {
            this.encodedDrops = 0;
            if (++this.encodedGoodFrames >= 160 && this.encodedProfile > 0) {
                this.encodedProfile--;
                this.encodedGoodFrames = 0;
            }
        }
    }

    closeDecoder(peer) {
        const decoder = peer.decoder;
        peer.decoder = null;
        peer.receiveSequence = null;
        if (decoder && decoder.state !== 'closed') decoder.close();
    }

    requestKeyframe(participantId, peer) {
        const now = performance.now();
        if (now - (peer.lastVideoControl || -Infinity) < 350) return;
        peer.lastVideoControl = now;
        this.sendFrame(participantId, videoControlKind, Uint8Array.of(peer.wantsJpeg ? 2 : 1));
    }

    decodeEncodedVideo(participantId, peer, bytes) {
        if (peer.wantsJpeg) {
            this.requestKeyframe(participantId, peer);
            return;
        }
        if (bytes.byteLength < encodedHeaderSize + 3 || bytes.byteLength > maxVideoBytes) return;
        const header = new DataView(bytes.buffer, bytes.byteOffset, encodedHeaderSize);
        const width = header.getUint16(0);
        const height = header.getUint16(2);
        const sequence = header.getUint16(4);
        const key = header.getUint8(10) === 1;
        if (!width || !height || width > maxEncodedEdge || height > maxEncodedEdge ||
            width * height > maxEncodedPixels) return;

        const now = performance.now();
        if (now - (peer.lastDecodedAt || now) > 2000) this.closeDecoder(peer);
        const distance = peer.receiveSequence == null ? null : (sequence - peer.receiveSequence) & 0xffff;
        if (distance === 0 || distance >= 0x8000) return;
        const needsDecoder = !peer.decoder || peer.decoder.state !== 'configured' ||
            peer.decoderWidth !== width || peer.decoderHeight !== height || peer.decoder.decodeQueueSize >= 3;
        if (!key && (needsDecoder || distance !== 1)) {
            this.closeDecoder(peer);
            this.requestKeyframe(participantId, peer);
            return;
        }
        try {
            if (needsDecoder || (key && distance !== 1)) this.startDecoder(participantId, peer, width, height);
            peer.receiveSequence = sequence;
            peer.lastDecodedAt = now;
            peer.decoder.decode(new EncodedVideoChunk({
                type: key ? 'key' : 'delta',
                timestamp: header.getUint32(6) * 1000,
                data: bytes.subarray(encodedHeaderSize)
            }));
        } catch {
            this.handleDecoderFailure(participantId, peer);
        }
    }

    startDecoder(participantId, peer, width, height) {
        this.closeDecoder(peer);
        const decoder = new VideoDecoder({
            output: frame => {
                try {
                    if (this.peers.get(participantId) === peer && peer.receiving && peer.decoder === decoder) {
                        peer.decoderErrors = 0;
                        this.onVideo(participantId, frame);
                    }
                } finally {
                    frame.close();
                }
            },
            error: () => {
                if (peer.decoder === decoder) this.handleDecoderFailure(participantId, peer);
            }
        });
        peer.decoder = decoder;
        peer.decoderWidth = width;
        peer.decoderHeight = height;
        decoder.configure({ codec: vp8Codec, codedWidth: width, codedHeight: height, optimizeForLatency: true });
    }

    handleDecoderFailure(participantId, peer) {
        this.closeDecoder(peer);
        if (++peer.decoderErrors >= 2) peer.wantsJpeg = true;
        this.requestKeyframe(participantId, peer);
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
                } else if (++this.goodFrames >= 24) {
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
            if (this.peers.get(participantId) === peer && peer.receiving) this.onVideo(participantId, bitmap);
        } catch {
            // A malformed or superseded individual JPEG can be discarded.
        } finally {
            bitmap?.close?.();
            peer.decodingVideo = false;
        }
    }

    refreshAudioState() {
        const active = [...this.peers.values()].some(peer => peer.sending || peer.receiving);
        const blocked = active && this.audioContext?.state !== 'running';
        if (this.audioBlocked !== blocked) {
            this.audioBlocked = blocked;
            this.onAudioBlocked(blocked);
        }
        if (!blocked) this.startAudioCapture();
    }

    startAudioCapture() {
        const context = this.audioContext;
        const track = this.audioTrack;
        if (![...this.peers.values()].some(peer => peer.sending) || context?.state !== 'running' ||
            track?.readyState !== 'live' || this.capture || this.capturePending) return;
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
        for (const [participantId, peer] of this.peers) {
            if (!peer.sending || (kind === videoKind && peer.sendEncoded && !this.codecFailed)) continue;
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
