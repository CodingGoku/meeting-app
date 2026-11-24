const sampleRateOut = 16000;
const packetSamples = 640;
const bias = 0x84;

function encodeSample(sample) {
    const pcm = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
    const sign = pcm < 0 ? 0x80 : 0;
    const magnitude = Math.min(Math.abs(pcm), 32635) + bias;
    let exponent = 7;
    for (let bit = 0x4000; exponent > 0 && !(magnitude & bit); bit >>= 1) exponent--;
    const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
    return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

class RelayAudioCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.samplesPerOutput = sampleRate / sampleRateOut;
        this.weight = 0;
        this.total = 0;
        this.packet = new Uint8Array(packetSamples);
        this.offset = 0;
        this.canSend = true;
        this.port.onmessage = () => { this.canSend = true; };
    }

    process(inputs) {
        const mono = inputs[0]?.[0];
        if (!mono) return true;
        for (const sample of mono) {
            let remaining = 1;
            // Carry fractional input samples across output samples and render blocks.
            while (remaining > 1e-9) {
                const weight = Math.min(remaining, this.samplesPerOutput - this.weight);
                this.total += sample * weight;
                this.weight += weight;
                remaining -= weight;
                if (this.weight + 1e-9 < this.samplesPerOutput) continue;
                this.packet[this.offset++] = encodeSample(this.total / this.samplesPerOutput);
                this.weight = 0;
                this.total = 0;
                if (this.offset !== packetSamples) continue;

                this.offset = 0;
                if (!this.canSend) continue;
                this.canSend = false;
                this.port.postMessage(this.packet, [this.packet.buffer]);
                this.packet = new Uint8Array(packetSamples);
            }
        }
        return true;
    }
}

registerProcessor('relay-audio-capture', RelayAudioCapture);
