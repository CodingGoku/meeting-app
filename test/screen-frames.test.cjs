const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const source = readFileSync(path.join(__dirname, '../public/screen-frame-source.js'));

test('reads screen frames without a preview and releases frames and reader on stop', async t => {
    const { openDisplayFrames } = await import('data:text/javascript;base64,' + source.toString('base64'));
    const saved = globalThis.MediaStreamTrackProcessor;
    t.after(() => { globalThis.MediaStreamTrackProcessor = saved; });

    let controller;
    let processorTrack;
    let bufferSize;
    let deliveredFrame;
    let frameClosed = 0;
    let sourceEnded = false;
    let sourceCancelled = false;
    const track = { stop() { throw new Error('Closing the relay must keep the display track live'); } };
    let deliver;
    const delivered = new Promise(resolve => { deliver = resolve; });

    globalThis.MediaStreamTrackProcessor = class {
        constructor({ track, maxBufferSize }) {
            processorTrack = track;
            bufferSize = maxBufferSize;
            this.readable = new ReadableStream({
                start(control) { controller = control; },
                cancel() { sourceCancelled = true; }
            });
        }
    };

    const stop = openDisplayFrames(track, frame => {
        deliveredFrame = frame;
        deliver();
    }, () => { sourceEnded = true; });
    t.after(stop);
    const frame = { close() { frameClosed++; } };
    controller.enqueue(frame);
    await delivered;
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(processorTrack, track);
    assert.equal(bufferSize, 1);
    assert.equal(deliveredFrame, frame);
    assert.equal(frameClosed, 1);
    stop();
    assert.equal(sourceCancelled, true);
    assert.equal(sourceEnded, false);
});
