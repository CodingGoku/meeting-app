export function readTrackFrames(track, onFrame, onEnd) {
    const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
    let stopped = false;

    async function pump() {
        try {
            while (!stopped) {
                const { done, value } = await reader.read();
                if (done) break;
                try {
                    if (!stopped) await onFrame(value);
                } finally {
                    value.close();
                }
            }
        } catch {
            // The caller can return to preview-based capture if the source closes unexpectedly.
        } finally {
            reader.releaseLock();
            if (!stopped) onEnd();
        }
    }

    void pump();
    return () => {
        if (stopped) return;
        stopped = true;
        void reader.cancel().catch(() => {});
    };
}

export function openDisplayFrames(track, onFrame, onEnd) {
    if (typeof MediaStreamTrackProcessor === 'function') {
        try {
            return readTrackFrames(track, onFrame, onEnd);
        } catch {
            // Some browsers expose the processor only in a worker.
        }
    }
    if (typeof Worker !== 'function' || typeof VideoFrame !== 'function') return null;

    let worker;
    let clone;
    try {
        worker = new Worker(new URL('./screen-frame-worker.js?v=9', import.meta.url), { type: 'module' });
        const handle = typeof MediaStreamTrackHandle === 'function' ? new MediaStreamTrackHandle(track) : null;
        clone = handle ? null : track.clone();
        worker.postMessage(handle ? { handle } : { track: clone }, [handle || clone]);
    } catch {
        clone?.stop();
        worker?.terminate();
        return null;
    }

    let stopped = false;
    let stopTimeout;
    const dispose = () => {
        clearTimeout(stopTimeout);
        worker.terminate();
        if (stopped) return;
        stopped = true;
        onEnd();
    };
    worker.onerror = dispose;
    worker.onmessageerror = dispose;
    worker.onmessage = ({ data }) => {
        if (data.closed) {
            dispose();
            return;
        }
        const frame = data.frame;
        if (!frame) return;
        try {
            if (!stopped) onFrame(frame);
        } finally {
            frame.close();
            if (!stopped) worker.postMessage('next');
        }
    };
    return () => {
        if (stopped) return;
        stopped = true;
        worker.postMessage('stop');
        stopTimeout = setTimeout(() => worker.terminate(), 1000);
    };
}
