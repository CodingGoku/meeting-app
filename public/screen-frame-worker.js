import { readTrackFrames } from './screen-frame-source.js?v=9';

let ownedTrack;
let cancel;
let acknowledge;

function finish() {
    ownedTrack?.stop();
    self.postMessage({ closed: true });
    self.close();
}

self.onmessage = ({ data }) => {
    if (data === 'next') {
        acknowledge?.();
        acknowledge = null;
    } else if (data === 'stop') {
        cancel?.();
        acknowledge?.();
        finish();
    } else if (!cancel && (data.track || data.handle)) {
        ownedTrack = data.track;
        try {
            cancel = readTrackFrames(data.handle || ownedTrack, frame => {
                const next = new Promise(resolve => { acknowledge = resolve; });
                self.postMessage({ frame }, [frame]);
                return next;
            }, finish);
        } catch {
            finish();
        }
    }
};
