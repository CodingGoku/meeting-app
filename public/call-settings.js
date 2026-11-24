const inputKinds = { mic: 'audioinput', camera: 'videoinput' };
const inputLabels = { mic: 'Microphone', camera: 'Camera' };
const sampleInterval = 2000;

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function inboundOfKind(stats, kind) {
  let selected;
  for (const item of stats.values()) {
    if (item.type !== 'inbound-rtp' || (item.kind || item.mediaType) !== kind) continue;
    if (!selected || (item.bytesReceived || 0) > (selected.bytesReceived || 0)) selected = item;
  }
  return selected;
}

function selectedPair(stats) {
  for (const item of stats.values()) {
    if (item.type === 'transport' && item.selectedCandidatePairId) {
      const pair = stats.get(item.selectedCandidatePairId);
      if (pair) return pair;
    }
  }
  for (const item of stats.values()) {
    if (item.type === 'candidate-pair' && item.nominated && item.state === 'succeeded') return item;
  }
  return null;
}

function measureWebRTC(stats, previous, videoExpected) {
  const pair = selectedPair(stats);
  const video = videoExpected ? inboundOfKind(stats, 'video') : null;
  const audio = inboundOfKind(stats, 'audio');
  const inbound = video || audio;
  const sample = inbound ? {
    id: inbound.id, at: inbound.timestamp, frames: inbound.framesDecoded,
    received: inbound.packetsReceived, lost: inbound.packetsLost
  } : null;
  const continued = sample && previous?.id === sample.id && sample.at > previous.at;
  const packets = continued ? sample.received - previous.received : 0;
  const lost = continued ? Math.max(0, sample.lost - previous.lost) : 0;
  const fps = finite(video?.framesPerSecond) ?? (video && continued && sample.frames >= previous.frames
    ? finite((sample.frames - previous.frames) * 1000 / (sample.at - previous.at)) : null);
  const turn = [pair?.localCandidateId, pair?.remoteCandidateId].some(id => stats.get(id)?.candidateType === 'relay');
  const codec = video?.codecId ? stats.get(video.codecId)?.mimeType?.split('/')[1] : null;
  return {
    transport: turn ? 'WebRTC via TURN' : 'WebRTC',
    roundTrip: finite(pair?.currentRoundTripTime),
    loss: packets + lost > 0 ? finite(lost / (packets + lost)) : null,
    width: finite(video?.frameWidth), height: finite(video?.frameHeight), fps, codec, sample
  };
}

function describe(metrics) {
  const details = [metrics.transport];
  if (metrics.width && metrics.height) {
    const rate = metrics.fps === null ? '' : ' at ' + Math.round(metrics.fps) + ' fps';
    const codec = metrics.codec ? ' (' + metrics.codec + ')' : '';
    details.push(metrics.width + '×' + metrics.height + rate + codec);
  }
  if (metrics.roundTrip !== null) details.push(Math.round(metrics.roundTrip * 1000) + ' ms round trip');
  if (metrics.loss !== null) details.push((metrics.loss * 100).toFixed(1) + '% packet loss');
  return details.join(' · ');
}

export function mountCallSettings({ getSession, getInputIds, saveInputIds, notify }) {
  const dialog = document.getElementById('call-settings');
  const deviceStatus = document.getElementById('device-status');
  const selects = { mic: document.getElementById('select-microphone'), camera: document.getElementById('select-camera') };
  const diagnostics = document.getElementById('call-diagnostics');
  const status = document.getElementById('diagnostics-status');
  const rows = document.getElementById('diagnostics-peers');
  const copyButton = document.getElementById('copy-diagnostics');
  const copyText = document.getElementById('diagnostics-text');
  let timer;
  let sampling = false;
  let report = '';
  let previous = new Map();
  let openVersion = 0;

  async function updateDevices() {
    const version = openVersion;
    let devices = [];
    try {
      devices = await navigator.mediaDevices?.enumerateDevices() || [];
    } catch {
      // System defaults can still be used when enumeration is unsupported.
    }
    if (version !== openVersion || !dialog.open) return;
    const selected = getSession()?.media?.inputIds || getInputIds();
    for (const [key, select] of Object.entries(selects)) {
      const available = devices.filter(device => device.kind === inputKinds[key] && device.deviceId && device.deviceId !== 'default');
      select.replaceChildren(new Option('System default', ''));
      available.forEach((device, index) => {
        select.add(new Option(device.label || inputLabels[key] + ' ' + (index + 1), device.deviceId));
      });
      if (selected[key] && !available.some(device => device.deviceId === selected[key])) {
        select.add(new Option('Previously selected device', selected[key]));
      }
      select.value = selected[key] || '';
    }
    deviceStatus.textContent = devices.some(device => device.label)
      ? 'Your choices are saved on this device.'
      : 'Device names appear after the browser grants camera or microphone access.';
  }

  async function refreshDiagnostics() {
    const session = getSession();
    diagnostics.hidden = !session;
    if (!session || sampling || document.hidden || !dialog.open) return;
    const version = openVersion;
    sampling = true;
    try {
      const participants = [...session.people.values()].filter(person => !person.local);
      const snapshots = await Promise.all(participants.map(async person => {
        const prior = previous.get(person.id);
        const videoExpected = person.media == null || person.media.camera || person.media.sharing;
        if (person.relayed) {
          const frame = person.relayMetrics;
          const sample = frame && videoExpected && person.relayFrame ? { ...frame, at: performance.now() } : null;
          const fps = sample && prior?.path === 'relay' && prior.sample && sample.at > prior.sample.at
            ? finite((sample.frames - prior.sample.frames) * 1000 / (sample.at - prior.sample.at)) : null;
          return {
            person, path: 'relay', sample,
            summary: describe({
              transport: 'Server relay', width: sample?.width, height: sample?.height,
              codec: sample?.codec, fps, roundTrip: null, loss: null
            })
          };
        }

        const rtc = await session.media.getPeerStats(person.id);
        if (rtc && person.connection === 'connected') {
          const metrics = measureWebRTC(rtc, prior?.path === 'webrtc' ? prior.sample : null, videoExpected);
          return { person, path: 'webrtc', sample: metrics.sample, summary: describe(metrics) };
        }
        const label = { connecting: 'Connecting media', reconnecting: 'Recovering media', failed: 'Media unavailable' };
        return { person, summary: label[person.connection] || 'Waiting for media' };
      }));
      if (version !== openVersion || getSession() !== session || !dialog.open) return;

      previous = new Map(snapshots.map(snapshot => [snapshot.person.id, snapshot]));
      const connection = session.ready ? 'Signaling connected' : 'Signaling reconnecting';
      status.textContent = snapshots.length ? connection : connection + ' · Waiting for another participant';
      rows.replaceChildren();
      for (const { person, summary } of snapshots) {
        const row = document.createElement('div');
        const name = document.createElement('dt');
        const details = document.createElement('dd');
        name.textContent = person.name;
        details.textContent = summary;
        row.append(name, details);
        rows.append(row);
      }
      report = ['MeetStream Pro connection diagnostics', connection, ...snapshots.map((item, index) =>
        'Participant ' + (index + 1) + ': ' + item.summary)].join('\n');
      copyButton.disabled = false;
    } finally {
      sampling = false;
    }
  }

  for (const [key, select] of Object.entries(selects)) {
    select.addEventListener('change', async () => {
      const deviceId = select.value;
      const session = getSession();
      select.disabled = true;
      try {
        if (session && !await session.media.setInputDevice(key, deviceId)) {
          notify('Could not switch ' + inputLabels[key].toLowerCase() + '.');
        } else {
          saveInputIds({ ...getInputIds(), [key]: deviceId });
        }
      } catch {
        notify('Could not switch ' + inputLabels[key].toLowerCase() + '.');
      } finally {
        select.disabled = false;
        void updateDevices();
      }
    });
  }

  for (const button of document.querySelectorAll('[data-call-settings]')) {
    button.addEventListener('click', () => {
      if (dialog.open) return;
      openVersion++;
      copyText.hidden = true;
      copyButton.disabled = true;
      dialog.showModal();
      void updateDevices();
      void refreshDiagnostics();
      timer = setInterval(() => void refreshDiagnostics(), sampleInterval);
    });
  }
  dialog.addEventListener('close', () => {
    openVersion++;
    clearInterval(timer);
    previous.clear();
    report = '';
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (dialog.open) void updateDevices();
  });
  copyButton.addEventListener('click', async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      notify('Connection diagnostics copied.');
    } catch {
      copyText.value = report;
      copyText.hidden = false;
      copyText.focus();
      copyText.select();
    }
  });
}
