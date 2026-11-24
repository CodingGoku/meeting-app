import { initIcons, setIcon } from './icons.js?v=8';
import { MeetingMedia } from './media.js?v=8';
import { RelayMedia } from './relay-media.js?v=8';
import { mountCallSettings } from './call-settings.js?v=8';

const $ = id => document.getElementById(id);
const lobby = $('lobby');
const meeting = $('meeting');
const inputName = $('display-name');
const inputRoom = $('room-input');
const lobbyForm = $('lobby-form');
const lobbyInputs = [...lobbyForm.elements];
const notes = $('meeting-notes');
const reactions = [
  ['👍', 'Thumbs up'], ['👏', 'Applause'], ['❤️', 'Heart'],
  ['🎉', 'Celebrate'], ['😂', 'Laugh'], ['😮', 'Surprised']
];
const sidebarTabs = ['people', 'chat', 'notes'];
const roomCodePattern = /^[A-Z0-9]{4,16}$/;
const resumeKey = 'meetstream_active';
const relayHeaderSize = 37;
const relayDeadlineMs = 3500;
const relayEncoder = new TextEncoder();
const relayDecoder = new TextDecoder();
const fallbackStorage = new Map();
let active = null;
let mode = 'join';
let openPanel = null;
let unread = 0;
let theme;

function load(key) {
  try {
    return localStorage.getItem(key) ?? fallbackStorage.get(key);
  } catch {
    return fallbackStorage.get(key);
  }
}

function save(key, value) {
  fallbackStorage.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // The app can still run in this tab with storage disabled or full.
  }
}

function preferredInputs() {
  try {
    const saved = JSON.parse(load('meetstream_inputs') || '{}');
    return {
      mic: typeof saved.mic === 'string' ? saved.mic : '',
      camera: typeof saved.camera === 'string' ? saved.camera : ''
    };
  } catch {
    return { mic: '', camera: '' };
  }
}

function notify(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  const stack = $('toast-stack');
  if (stack.children.length >= 3) stack.firstElementChild.remove();
  stack.append(toast);
  setTimeout(() => toast.remove(), 3600);
}

function applyTheme(value) {
  theme = value === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#e2f4ff' : '#0b2337';
  document.querySelectorAll('[data-theme-toggle]').forEach(button => {
    const label = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
    button.setAttribute('aria-label', label);
    button.title = label;
    setIcon(button, theme === 'light' ? 'moon' : 'sun');
  });
}

function normalizeRoom(value = '') {
  if (typeof value !== 'string') return '';
  let code = value.trim();
  if (/^https?:\/\//i.test(code)) {
    try {
      code = new URL(code).searchParams.get('room') || '';
    } catch {
      return '';
    }
  }
  code = code.toUpperCase();
  return roomCodePattern.test(code) ? code : '';
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}

function makeUserId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function getRecentRooms() {
  try {
    const rooms = JSON.parse(load('meetstream_recent') || '[]');
    return rooms.filter(item => normalizeRoom(item?.code) && Number.isFinite(item?.time)).slice(0, 4);
  } catch {
    return [];
  }
}

function setMode(value) {
  mode = value;
  const joining = mode === 'join';
  $('join-mode').setAttribute('aria-pressed', String(joining));
  $('create-mode').setAttribute('aria-pressed', String(!joining));
  $('lobby-heading').textContent = joining ? 'Join a meeting' : 'Start a meeting';
  $('lobby-description').textContent = joining
    ? 'Enter a room code or paste an invite link.'
    : 'Create a room and share the invite with anyone.';
  $('enter-label').textContent = joining ? 'Join meeting' : 'Start meeting';
  setIcon($('enter-button').firstElementChild, joining ? 'logIn' : 'video');
  $('room-field').hidden = !joining;
  inputRoom.required = joining;
  inputRoom.setCustomValidity('');
}

function chooseRoom(code) {
  setMode('join');
  inputRoom.value = code;
  (inputName.value.trim() ? $('enter-button') : inputName).focus();
}

function renderRecentRooms() {
  const list = $('recent-list');
  const rooms = getRecentRooms();
  list.replaceChildren();
  $('recent').hidden = rooms.length === 0;
  for (const { code, time } of rooms) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const icon = document.createElement('span');
    const room = document.createElement('span');
    const date = document.createElement('span');
    button.type = 'button';
    button.className = 'recent-row';
    setIcon(icon, 'clock');
    room.className = 'recent-code';
    room.textContent = code;
    date.className = 'recent-date';
    date.textContent = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(time);
    button.append(icon, room, date);
    button.addEventListener('click', () => {
      if (!active) chooseRoom(code);
    });
    item.append(button);
    list.append(item);
  }
}

function rememberRoom(session) {
  const history = getRecentRooms().filter(item => item.code !== session.room);
  save('meetstream_recent', JSON.stringify([{ code: session.room, time: Date.now() }, ...history].slice(0, 4)));
  save('meetstream_name', session.name);
  save('meetstream_room', session.room);
}

function rememberActiveMeeting(session) {
  try {
    const { mic, camera } = session.mediaState;
    sessionStorage.setItem(resumeKey, JSON.stringify({ room: session.room, name: session.name, mic, camera }));
  } catch {
    // Reload can always return to the lobby when session storage is disabled.
  }
}

function getInitials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join('').toLocaleUpperCase() || '?';
}

function updateRoster(session) {
  const count = session.people.size;
  $('count-label').textContent = count === 1 ? '1 participant' : count + ' participants';
  $('stage-empty').hidden = count !== 1 || !session.ready;
  const list = $('people-list');
  list.replaceChildren();
  for (const person of session.people.values()) {
    const row = document.createElement('li');
    const avatar = document.createElement('span');
    const name = document.createElement('span');
    row.className = 'participant-row';
    avatar.className = 'roster-avatar';
    avatar.textContent = getInitials(person.name);
    avatar.setAttribute('aria-hidden', 'true');
    name.className = 'participant-name';
    name.textContent = person.name + (person.id === session.id ? ' (you)' : '');
    row.append(avatar, name);
    if (person.raised) {
      const hand = document.createElement('span');
      hand.className = 'participant-hand';
      hand.title = 'Hand raised';
      hand.setAttribute('aria-label', 'Hand raised');
      setIcon(hand, 'hand');
      row.append(hand);
    }
    if (person.media?.mic === false) {
      const mute = document.createElement('span');
      mute.className = 'participant-muted';
      mute.title = 'Microphone muted';
      mute.setAttribute('aria-label', 'Microphone muted');
      setIcon(mute, 'micOff');
      row.append(mute);
    }
    person.tile.querySelector('.tile-hand').hidden = !person.raised;
    list.append(row);
  }
}

function setPin(session, id) {
  session.pinned = session.pinned === id ? null : id;
  $('video-grid').classList.toggle('has-pin', Boolean(session.pinned));
  for (const person of session.people.values()) {
    const pinned = person.id === session.pinned;
    const button = person.tile.querySelector('.tile-pin');
    person.tile.classList.toggle('is-pinned', pinned);
    button.setAttribute('aria-pressed', String(pinned));
    button.setAttribute('aria-label', pinned ? 'Unpin ' + person.name : 'Pin ' + person.name);
    button.title = pinned ? 'Unpin video' : 'Pin video';
  }
}

function setPerson(session, id, name, raised = false, media) {
  let person = session.people.get(id);
  if (!person) {
    const tile = $('tile-template').content.firstElementChild.cloneNode(true);
    initIcons(tile);
    const video = tile.querySelector('video');
    video.muted = id === session.id;
    tile.querySelector('.tile-pin').addEventListener('click', () => setPin(session, id));
    const fullscreen = tile.querySelector('.tile-fullscreen');
    fullscreen.addEventListener('click', () => toggleFullscreen(tile));
    person = { id, tile, video, canvas: tile.querySelector('canvas'), local: id === session.id };
    if (!person.local) {
      video.addEventListener('loadeddata', () => scheduleDirectSelection(session, person));
      video.addEventListener('playing', () => scheduleDirectSelection(session, person));
    }
    session.people.set(id, person);
    $('video-grid').append(tile);
  }
  person.name = name;
  person.raised = raised;
  const avatar = person.tile.querySelector('.avatar');
  avatar.textContent = getInitials(name);
  const hue = Array.from(id).reduce((sum, symbol) => sum + symbol.codePointAt(0), 0) % 65;
  avatar.style.setProperty('--avatar-hue', String(208 + hue));
  person.tile.querySelector('.tile-name').textContent = name + (id === session.id ? ' (you)' : '');
  const pinLabel = (session.pinned === id ? 'Unpin ' : 'Pin ') + name;
  person.tile.querySelector('.tile-pin').setAttribute('aria-label', pinLabel);
  person.tile.querySelector('.tile-fullscreen').setAttribute('aria-label', 'Fullscreen ' + name);
  if (media) setPersonMedia(session, person, media);
  return person;
}

function removePerson(session, id) {
  if (session.pinned === id) setPin(session, id);
  const person = session.people.get(id);
  clearTimeout(person?.relayTimer);
  clearTimeout(person?.directTimer);
  if (person?.relayRegistered) {
    session.relayPeople.delete(person.participantId);
    session.relay.removePeer(person.participantId);
    if (!session.relayPeople.size) stopMediaConnection(session);
  }
  person?.tile.remove();
  session.people.delete(id);
  syncMeetingActions(session);
}

function showStream(person, stream, hasVideo) {
  if (!person) return;
  const source = stream?.getTracks().length ? stream : null;
  if (person.video.srcObject !== source) person.video.srcObject = source;
  person.tile.classList.toggle('has-video', hasVideo);
}

function setPersonMedia(session, person, state) {
  if (person.relayed && (person.media?.sharing !== state.sharing || person.media?.camera !== state.camera)) {
    person.relayFrame = false;
  }
  person.media = state;
  person.tile.classList.toggle('is-sharing', state.sharing);
  person.tile.querySelector('.tile-sharing').hidden = !state.sharing;
  person.tile.querySelector('.tile-muted').hidden = state.mic !== false;
  if (person.relayed) updateRelayTile(person);
  if (!person.local) {
    session.media.setPeerVideoExpected(person.id, state.camera || state.sharing, state.sharing);
    renderRemote(session, person, person.directStream);
  }
  syncMeetingActions(session);
}

function renderRemote(session, person, stream) {
  if (!person || (person.relayed && !person.directRecovery)) return;
  person.directStream = stream;
  const hasVideo = (person.media == null || person.media.camera || person.media.sharing) &&
    Boolean(stream?.getVideoTracks().some(track => !track.muted && track.readyState === 'live'));
  showStream(person, stream, hasVideo);
  if (stream?.getTracks().some(track => !track.muted && track.readyState === 'live') &&
      person.video.paused && !person.playAttempt) playRemote(session, person);
  scheduleDirectSelection(session, person);
}

function playRemote(session, person) {
  const video = person.video;
  person.playAttempt = video.play().then(() => {
    if (!video.muted) person.awaitingAudio = false;
  }).catch(async error => {
    if (error.name !== 'NotAllowedError' || video.muted || person.relayed) return;
    // Some browsers require a tap for incoming audio, including listen-only joins.
    person.awaitingAudio = true;
    video.muted = true;
    syncMeetingActions(session);
    await video.play().catch(() => {});
  }).finally(() => {
    person.playAttempt = null;
    syncMeetingActions(session);
  });
}

function syncMeetingActions(session) {
  if (active !== session) return;
  const people = [...session.people.values()];
  $('enable-audio').hidden = !session.relayAudioBlocked && !people.some(person => person.awaitingAudio);
  $('retry-media').hidden = !session.ready || !people.some(person => person.connection === 'failed');
  $('video-grid').classList.toggle('has-share', people.some(person => person.media?.sharing));
  if (!session.ready) return;
  const remote = people.filter(person => !person.local);
  let label = 'Connected';
  if (remote.some(person => person.connection === 'failed')) label = 'Media needs attention';
  else if (remote.some(person => person.connection === 'reconnecting')) label = 'Reconnecting media…';
  else if (remote.some(person => !['connected', 'relayed'].includes(person.connection))) label = 'Connecting media…';
  else if (remote.some(person => person.relayed)) label = 'Server relay';
  setConnection(label);
}

function updatePeerStatus(session, id, status) {
  const person = session.people.get(id);
  if (!person || active !== session) return;
  person.directStatus = status;
  if (status === 'connected') person.hadDirect = true;
  if (person.relayRegistered) {
    scheduleDirectSelection(session, person);
  } else if (status === 'connected') {
    clearTimeout(person.relayTimer);
    person.relayTimer = null;
  } else if (status === 'failed' || status === 'reconnecting') {
    scheduleRelay(session, person, status === 'failed' ? 0 : person.hadDirect ? 700 : relayDeadlineMs);
  }
  displayPeerStatus(session, person, person.relayed ? 'relayed' : status);
}

function displayPeerStatus(session, person, status) {
  person.connection = status;
  const badge = person.tile.querySelector('.tile-connection');
  badge.hidden = status === 'connected';
  badge.textContent = {
    connecting: 'Connecting…', reconnecting: 'Reconnecting…',
    failed: 'Media unavailable', relayed: 'Server relay'
  }[status] || '';
  syncMeetingActions(session);
}

function scheduleRelay(session, person, delay = relayDeadlineMs) {
  if (!session.canRelay || !person.canRelay || person.relayRegistered || person.directStatus === 'connected') return;
  if (person.relayTimer && delay > 0) return;
  clearTimeout(person.relayTimer);
  person.relayTimer = setTimeout(() => {
    person.relayTimer = null;
    if (active === session && session.ready && person.directStatus !== 'connected' && !person.relayRegistered) {
      send(session, 'relay-request', { toParticipantId: person.participantId });
      scheduleRelay(session, person, 2500);
    }
  }, delay);
}

function addRemotePerson(session, info, initiate) {
  const previous = session.people.get(info.userId);
  if (previous && previous.participantId !== info.participantId) {
    session.media.removePeer(info.userId);
    removePerson(session, info.userId);
  }
  const person = setPerson(session, info.userId, info.userName, info.raised, info.media);
  person.participantId = info.participantId;
  person.canRelay = info.relayMedia === true;
  person.directRecovery = info.directRecovery === true;
  if (!person.relayRegistered || person.directRecovery) {
    void session.media.addPeer(info.userId, initiate, info.participantId);
  }
  if (person.media) {
    session.media.setPeerVideoExpected(person.id, person.media.camera || person.media.sharing, person.media.sharing);
  }
  if (info.relayed) startMediaRelay(session, info);
  if (person.relayRegistered) publishRelayPreference(session, person);
  else scheduleRelay(session, person, person.directStatus === 'failed' ? 0 : relayDeadlineMs);
}

function startMediaRelay(session, { userId, participantId, encodedVideo }) {
  const person = session.people.get(userId);
  if (!person || person.participantId !== participantId || person.relayRegistered || !person.canRelay) return;
  clearTimeout(person.relayTimer);
  person.relayTimer = null;
  person.relayRegistered = true;
  person.relayed = true;
  person.relayAddress = relayEncoder.encode(participantId);
  person.awaitingAudio = false;
  person.video.muted = true;
  if (person.directRecovery) session.media.keepProbing(userId);
  else session.media.removePeer(userId);
  session.relayPeople.set(participantId, person);
  session.relay.addPeer(participantId, encodedVideo === true);
  connectMedia(session);
  displayPeerStatus(session, person, 'relayed');
  renderRemote(session, person, person.directStream);
  if (session.relayPeople.size === 1) {
    notify('Direct media couldn’t connect. Audio and video are using the meeting server.');
  }
}

function publishRelayPreference(session, person) {
  if (!person.relayRegistered || !person.directRecovery) return;
  send(session, 'relay-preference', {
    to: person.id, toParticipantId: person.participantId,
    data: { directReady: !person.relayed }
  });
}

function needsRelay(person) {
  if (person.directStatus !== 'connected') return true;
  if (!person.relayed) return false;

  const state = person.media;
  const stream = person.directStream;
  const live = track => !track.muted && track.readyState === 'live';
  if (state?.camera || state?.sharing) {
    if (!stream?.getVideoTracks().some(live) || person.video.readyState < 2) return true;
  }
  if (state?.mic && !stream?.getAudioTracks().some(live)) return true;
  return !state && !stream?.getTracks().some(live);
}

function scheduleDirectSelection(session, person) {
  if (active !== session || !person.relayRegistered || !person.directRecovery) return;
  const useRelay = needsRelay(person);
  if (useRelay === person.relayed) {
    clearTimeout(person.directTimer);
    person.directTimer = null;
    return;
  }
  if (person.directTimer && person.pendingRelayMode === useRelay) return;
  clearTimeout(person.directTimer);
  person.pendingRelayMode = useRelay;
  // Wait for the direct stream to play before exposing it. Brief ICE errors can heal.
  const delay = useRelay ? (person.directStatus === 'failed' ? 0 : 350) : 650;
  person.directTimer = setTimeout(() => {
    person.directTimer = null;
    if (active !== session || session.people.get(person.id) !== person || useRelay !== needsRelay(person)) return;
    person.relayed = useRelay;
    person.relayFrame = false;
    person.awaitingAudio = false;
    if (useRelay) person.video.muted = true;
    session.relay.setReceiving(person.participantId, useRelay);
    updateRelayTile(person);
    if (!useRelay) {
      person.video.muted = false;
      if (person.video.srcObject && !person.playAttempt) playRemote(session, person);
    }
    displayPeerStatus(session, person, useRelay ? 'relayed' : 'connected');
    publishRelayPreference(session, person);
  }, delay);
}

function updateRelayTile(person) {
  const visible = person.relayed && person.relayFrame && (person.media == null || person.media.camera || person.media.sharing);
  person.tile.classList.toggle('has-relay-video', Boolean(visible));
}

function drawRelayFrame(session, participantId, image) {
  const person = session.relayPeople.get(participantId);
  if (active !== session || !person?.relayed) return;
  const { canvas } = person;
  const width = image.displayWidth ?? image.width;
  const height = image.displayHeight ?? image.height;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  canvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0);
  const metrics = person.relayMetrics ||= { frames: 0 };
  metrics.frames++;
  metrics.width = width;
  metrics.height = height;
  metrics.codec = image.displayWidth ? 'VP8' : 'JPEG';
  person.relayFrame = true;
  updateRelayTile(person);
}

function sendRelayFrame(session, participantId, kind, payload) {
  const signal = session.ready && session.socket?.readyState === WebSocket.OPEN ? session.socket : null;
  const media = session.mediaReady && session.relaySocket?.readyState === WebSocket.OPEN ? session.relaySocket : null;
  // Put large pictures on the media socket. Audio packets can use signaling while it is available.
  const videoPacket = kind === 1 || kind === 3;
  const socket = videoPacket ? media || signal : signal || media;
  const person = session.relayPeople.get(participantId);
  const queueLimit = videoPacket ? (socket === media ? 24 : 8) : 64;
  if (active !== session || !person || !socket || socket.bufferedAmount > queueLimit * 1024) return false;
  const packet = new Uint8Array(relayHeaderSize + payload.byteLength);
  packet[0] = kind;
  packet.set(person.relayAddress, 1);
  packet.set(payload, relayHeaderSize);
  try {
    socket.send(packet);
    return true;
  } catch {
    return false;
  }
}

function receiveRelayFrame(session, data) {
  if (!session.relayPeople.size || data.byteLength <= relayHeaderSize) return;
  const packet = new Uint8Array(data);
  const participantId = relayDecoder.decode(packet.subarray(1, relayHeaderSize));
  if (session.relayPeople.has(participantId)) {
    session.relay.receive(participantId, packet[0], packet.subarray(relayHeaderSize));
  }
}

function meetingSocketUrl(path) {
  const url = new URL(path, location.origin);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

function stopMediaConnection(session) {
  clearTimeout(session.mediaRetry);
  const socket = session.relaySocket;
  session.relaySocket = null;
  session.mediaReady = false;
  socket?.close();
}

function connectMedia(session) {
  if (active !== session || !session.canUseMediaSocket || !session.relayPeople.size ||
      session.relaySocket?.readyState <= WebSocket.OPEN) return;
  clearTimeout(session.mediaRetry);
  const socket = new WebSocket(meetingSocketUrl('/media'));
  socket.binaryType = 'arraybuffer';
  session.relaySocket = socket;
  const bindTimeout = setTimeout(() => socket.close(), 4500);
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
      type: 'bind-media', roomId: session.room, userId: session.id, connectionKey: session.connectionKey
    }));
  });
  socket.addEventListener('message', event => {
    if (active !== session || session.relaySocket !== socket) return;
    if (event.data instanceof ArrayBuffer) {
      receiveRelayFrame(session, event.data);
    } else {
      try {
        if (JSON.parse(event.data).type !== 'media-ready') return;
        clearTimeout(bindTimeout);
        session.mediaReady = true;
        session.mediaFailures = 0;
      } catch {
        // Only a binding acknowledgement and media frames belong on this connection.
      }
    }
  });
  socket.addEventListener('close', () => {
    clearTimeout(bindTimeout);
    if (active !== session || session.relaySocket !== socket) return;
    session.relaySocket = null;
    session.mediaReady = false;
    session.mediaFailures++;
    const delay = Math.min(8000, 700 * 2 ** Math.min(session.mediaFailures - 1, 4));
    session.mediaRetry = setTimeout(() => connectMedia(session), delay);
  });
}

function updateToggle(button, enabled, label) {
  button.setAttribute('aria-pressed', String(enabled));
  button.title = label;
}

function renderMedia(session, stream, state) {
  if (active !== session) return;
  const changed = ['camera', 'mic', 'sharing'].some(key => state[key] !== session.mediaState[key]);
  session.mediaState = state;
  if (session.ready && changed) {
    rememberActiveMeeting(session);
    if (session.hasMediaState) send(session, 'media-state', state);
  }
  const person = session.people.get(session.id);
  setPersonMedia(session, person, state);
  if (changed) updateRoster(session);
  person.tile.classList.toggle('is-mirrored', state.camera && !state.sharing);
  showStream(person, stream, state.camera || state.sharing);
  session.relay?.setLocal(state.camera || state.sharing ? person.video : null,
    session.media.outbound.getAudioTracks()[0] || null, state.sharing);
  const mic = $('mic-button');
  const camera = $('camera-button');
  mic.classList.toggle('is-off', !state.mic);
  camera.classList.toggle('is-off', !state.camera);
  updateToggle(mic, state.mic, state.mic ? 'Mute microphone (M)' : 'Unmute microphone (M)');
  updateToggle(camera, state.camera, state.camera ? 'Turn off camera (V)' : 'Turn on camera (V)');
  updateToggle($('share-button'), state.sharing, state.sharing ? 'Stop sharing' : 'Share screen (S)');
  setIcon(mic.firstElementChild, state.mic ? 'mic' : 'micOff');
  setIcon(camera.firstElementChild, state.camera ? 'video' : 'videoOff');
}

function setConnection(value) {
  if ($('connection-label').textContent !== value) $('connection-label').textContent = value;
  $('connection-indicator').classList.toggle('is-waiting', !['Connected', 'Server relay'].includes(value));
}

function tick(session) {
  const seconds = Math.floor((Date.now() - session.started) / 1000);
  const two = number => String(number).padStart(2, '0');
  const minutes = Math.floor(seconds / 60);
  $('meeting-timer').textContent = minutes < 60
    ? two(minutes) + ':' + two(seconds % 60)
    : two(Math.floor(minutes / 60)) + ':' + two(minutes % 60) + ':' + two(seconds % 60);
}

function send(session, type, payload = {}) {
  if (active !== session || !session.ready || session.socket?.readyState !== WebSocket.OPEN) return false;
  // Older signaling servers forward these sender fields directly.
  try {
    session.socket.send(JSON.stringify({ type, ...payload, from: session.id, fromName: session.name }));
    return true;
  } catch {
    return false;
  }
}

function appendChat(session, data) {
  const list = $('chat-messages');
  const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const message = document.createElement('article');
  const byline = document.createElement('div');
  const name = document.createElement('strong');
  const time = document.createElement('time');
  const text = document.createElement('p');
  const mine = data.userId === session.id;
  message.className = mine ? 'chat-message is-mine' : 'chat-message';
  byline.className = 'chat-byline';
  name.textContent = mine ? 'You' : data.userName;
  const when = new Date(data.timestamp);
  time.textContent = Number.isNaN(when.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(when);
  text.textContent = data.text;
  byline.append(name, time);
  message.append(byline, text);
  $('chat-empty').hidden = true;
  list.append(message);
  if (list.children.length > 201) list.children[1].remove();
  if (openPanel === 'chat' && (follow || mine)) list.scrollTop = list.scrollHeight;
  if (!mine && openPanel !== 'chat') setUnread(unread + 1);
}

function showReaction(session, data) {
  const layer = $('reaction-layer');
  if (layer.children.length >= 6) layer.firstElementChild.remove();
  const reaction = document.createElement('div');
  const emoji = document.createElement('span');
  const sender = document.createElement('span');
  reaction.className = 'reaction-burst';
  emoji.textContent = data.reaction;
  sender.textContent = data.userId === session.id ? 'You' : data.userName;
  reaction.append(emoji, sender);
  layer.append(reaction);
  setTimeout(() => reaction.remove(), 2300);
}

function handleMessage(session, data) {
  switch (data.type) {
    case 'existing-participants': {
      const ownParticipantId = data.yourInfo?.participantId;
      const resumed = data.resumed === true && ownParticipantId === session.participantId;
      const roster = new Set(data.participants.map(person => person.userId));
      for (const id of session.people.keys()) {
        if (id !== session.id && (!resumed || !roster.has(id))) {
          session.media.removePeer(id);
          removePerson(session, id);
        }
      }
      session.participantId = ownParticipantId;
      session.ready = true;
      session.failures = 0;
      clearTimeout(session.connectTimeout);
      if (!session.started) {
        session.started = Date.now();
        session.timer = setInterval(() => tick(session), 1000);
        rememberRoom(session);
      }
      session.hasMediaState = Boolean(data.yourInfo?.media);
      session.canRelay = data.mediaRelay === true;
      session.canUseMediaSocket = data.mediaSocket === true;
      session.media.setIceServers(data.iceServers);
      rememberActiveMeeting(session);
      for (const person of data.participants) {
        addRemotePerson(session, person, resumed && person.shouldOffer === true);
      }
      session.media.signalingResumed();
      if (session.hasMediaState) send(session, 'media-state', session.mediaState);
      if (session.people.get(session.id).raised) send(session, 'hand-raised', { raised: true });
      updateRoster(session);
      syncMeetingActions(session);
      connectMedia(session);
      break;
    }
    case 'user-joined':
      addRemotePerson(session, data, true);
      updateRoster(session);
      break;
    case 'offer':
    case 'answer':
    case 'ice-candidate': {
      const person = session.people.get(data.from);
      if (!person?.relayRegistered || person.directRecovery) void session.media.handleSignal(data);
      break;
    }
    case 'media-relay':
      startMediaRelay(session, data);
      break;
    case 'relay-preference': {
      const person = session.people.get(data.from);
      const directReady = data.data?.directReady;
      if (person?.relayRegistered && person.directRecovery &&
          person.participantId === data.fromParticipantId && typeof directReady === 'boolean') {
        session.relay.setSending(person.participantId, !directReady);
      }
      break;
    }
    case 'user-left':
      session.media.removePeer(data.userId);
      removePerson(session, data.userId);
      updateRoster(session);
      break;
    case 'chat-message':
      appendChat(session, data);
      break;
    case 'reaction':
      showReaction(session, data);
      break;
    case 'media-state': {
      const person = session.people.get(data.userId);
      if (!person || person.local || !data.media) break;
      setPersonMedia(session, person, data.media);
      updateRoster(session);
      break;
    }
    case 'hand-raised': {
      const person = session.people.get(data.userId);
      if (!person) break;
      person.raised = data.raised;
      if (data.userId === session.id) updateToggle($('hand-button'), data.raised, data.raised ? 'Lower hand (H)' : 'Raise hand (H)');
      updateRoster(session);
      break;
    }
    case 'error':
      notify(data.message || 'The meeting server returned an error.');
      if (!session.ready) {
        if (session.started) session.socket?.close(4000, 'Rejoin failed');
        else leaveMeeting();
      }
      break;
  }
}

function connect(session) {
  if (active !== session) return;
  const socket = new WebSocket(meetingSocketUrl('/'));
  socket.binaryType = 'arraybuffer';
  session.socket = socket;
  session.connectTimeout = setTimeout(() => socket.close(), 9000);
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
      type: 'join-room', roomId: session.room, userId: session.id, userName: session.name,
      connectionKey: session.connectionKey, media: session.mediaState, relayMedia: Boolean(session.relay),
      encodedVideo: session.encodedVideo, directRecovery: true
    }));
  });
  socket.addEventListener('message', event => {
    if (active !== session || socket !== session.socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      if (typeof event.data === 'string') handleMessage(session, JSON.parse(event.data));
      else if (event.data instanceof ArrayBuffer) receiveRelayFrame(session, event.data);
    } catch (error) {
      console.warn('Meeting message could not be processed', error);
    }
  });
  socket.addEventListener('close', () => {
    clearTimeout(session.connectTimeout);
    if (active !== session || socket !== session.socket) return;
    session.ready = false;
    // A brief signaling interruption does not invalidate an active call.
    session.failures += 1;
    setConnection(session.started ? 'Reconnecting…' : 'Connecting…');
    const delay = Math.min(6000, 700 * 2 ** Math.min(session.failures - 1, 4));
    session.retry = setTimeout(() => connect(session), delay);
  });
}

function setBusy(value) {
  lobbyInputs.forEach(element => { element.disabled = value; });
  $('join-mode').disabled = value;
  $('create-mode').disabled = value;
  lobbyForm.setAttribute('aria-busy', String(value));
  $('enter-label').textContent = value ? 'Opening meeting…' : mode === 'join' ? 'Join meeting' : 'Start meeting';
}

async function enterMeeting(room, name) {
  if (active) return;
  const session = {
    id: makeUserId(), connectionKey: makeUserId(), room, name, people: new Map(), pinned: null,
    mediaState: {}, failures: 0, mediaFailures: 0, relayPeople: new Map()
  };
  active = session;
  const devices = { mic: $('start-mic').checked, camera: $('start-camera').checked };
  setBusy(true);
  setPerson(session, session.id, name);
  renderMedia(session, null, { mic: false, camera: false, sharing: false });
  updateRoster(session);
  try {
    session.media = new MeetingMedia({
      send: (type, payload) => send(session, type, payload),
      onLocal: (stream, state) => renderMedia(session, stream, state),
      onRemote: (id, stream) => renderRemote(session, session.people.get(id), stream),
      onRemoteRemoved: id => {
        const person = session.people.get(id);
        if (!person) return;
        person.directStream = null;
        showStream(person, null, false);
      },
      onStatus: (id, status) => updatePeerStatus(session, id, status),
      notify
    });
    session.relay = new RelayMedia({
      sendFrame: (id, kind, payload) => sendRelayFrame(session, id, kind, payload),
      onVideo: (id, image) => drawRelayFrame(session, id, image),
      onAudioBlocked: blocked => {
        session.relayAudioBlocked = blocked;
        syncMeetingActions(session);
      },
      notify
    });
    void session.relay.enableAudio();
    const [encodedVideo] = await Promise.all([
      RelayMedia.supportsEncodedVideo(),
      session.media.prepare({ ...devices, inputIds: preferredInputs() })
    ]);
    if (active === session) save('meetstream_inputs', JSON.stringify(session.media.inputIds));
    session.encodedVideo = encodedVideo;
    if (active !== session) return;
    save('meetstream_devices', JSON.stringify(devices));
    $('room-code').textContent = room;
    $('meeting-timer').textContent = '00:00';
    notes.value = load('meetstream_notes_' + room) || '';
    $('download-notes').disabled = !notes.value.trim();
    document.querySelectorAll('.chat-message').forEach(element => element.remove());
    $('chat-empty').hidden = false;
    updateToggle($('hand-button'), false, 'Raise hand (H)');
    setUnread(0);
    setConnection('Connecting…');
    lobby.hidden = true;
    meeting.hidden = false;
    $('invite-button').focus();
    connect(session);
  } catch (error) {
    console.warn('Unable to start meeting', error);
    leaveMeeting();
    notify('The meeting could not start in this browser.');
  } finally {
    if (active === session || !active) setBusy(false);
  }
}

function leaveMeeting({ returnToLobby = true } = {}) {
  const session = active;
  if (!session) return;
  send(session, 'leave-room');
  active = null;
  clearTimeout(session.retry);
  clearTimeout(session.connectTimeout);
  clearInterval(session.timer);
  session.socket?.close();
  stopMediaConnection(session);
  for (const person of session.people.values()) {
    clearTimeout(person.relayTimer);
    clearTimeout(person.directTimer);
  }
  session.relay?.destroy();
  session.media?.destroy();
  if (!returnToLobby) return;
  try {
    sessionStorage.removeItem(resumeKey);
  } catch {
    // Session storage is optional.
  }

  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  setPin(session, null);
  $('video-grid').replaceChildren();
  $('people-list').replaceChildren();
  $('reaction-layer').replaceChildren();
  setSidebar(null);
  setReactionPicker(false);
  meeting.hidden = true;
  lobby.hidden = false;
  setMode('join');
  inputRoom.value = session.room;
  renderRecentRooms();
  $('lobby-heading').focus();
}

function makeInvite(room) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', room);
  return url.href;
}

function openInvite() {
  if (!active) return;
  $('invite-link').value = makeInvite(active.room);
  $('invite-dialog').showModal();
  $('invite-link').select();
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    notify(label + ' copied');
  } catch {
    $('invite-link').focus();
    $('invite-link').select();
    notify('Clipboard unavailable. Copy the selected link, or use the room code in the header.');
  }
}

async function toggleFullscreen(target = meeting) {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await target.requestFullscreen();
  } catch {
    notify('Fullscreen is unavailable in this browser.');
  }
}

document.addEventListener('fullscreenchange', () => {
  for (const button of meeting.querySelectorAll('#fullscreen-button, .tile-fullscreen')) {
    const tile = button.closest('.video-tile');
    const expanded = document.fullscreenElement === (tile || meeting);
    const name = tile?.querySelector('.tile-name').textContent;
    const label = expanded ? 'Exit full screen' : name ? 'Full screen for ' + name : 'Enter full screen';
    button.setAttribute('aria-label', label);
    button.title = label;
    setIcon(button, expanded ? 'fullscreenExit' : 'fullscreen');
  }
});

function setUnread(count) {
  unread = count;
  const badge = $('chat-unread');
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? '99+' : String(count);
  $('chat-button').setAttribute('aria-label', count ? 'Chat, ' + count + ' unread' : 'Chat');
}

function setSidebar(panel) {
  openPanel = panel;
  $('inspector').hidden = !panel;
  $('meeting-body').classList.toggle('has-inspector', Boolean(panel));
  for (const name of sidebarTabs) {
    const selected = name === (panel || 'people');
    const tab = $(name + '-tab');
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(name + '-panel').hidden = !selected;
    $(name + '-button').setAttribute('aria-pressed', String(name === panel));
  }
  if (panel === 'chat') {
    setUnread(0);
    const messages = $('chat-messages');
    messages.scrollTop = messages.scrollHeight;
  }
}

function setReactionPicker(open) {
  $('reactions').hidden = !open;
  $('reaction-button').setAttribute('aria-expanded', String(open));
}

function meetingAction(type, payload) {
  if (active && !send(active, type, payload)) {
    notify('Waiting for the meeting connection.');
    return false;
  }
  return Boolean(active);
}

function toggleHand() {
  const person = active?.people.get(active.id);
  if (person) meetingAction('hand-raised', { raised: !person.raised });
}

function toggleShare() {
  if (active?.mediaState.sharing) active.media.toggleShare();
  else if (active) $('share-dialog').showModal();
}

for (const [emoji, name] of reactions) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', name);
  button.title = name;
  button.textContent = emoji;
  button.addEventListener('click', () => {
    meetingAction('reaction', { reaction: emoji });
    setReactionPicker(false);
    $('reaction-button').focus();
  });
  $('reactions').append(button);
}

document.querySelectorAll('[data-theme-toggle]').forEach(button => button.addEventListener('click', () => {
  applyTheme(theme === 'dark' ? 'light' : 'dark');
  save('meetstream_theme', theme);
}));
document.querySelectorAll('[data-shortcuts]').forEach(button => button.addEventListener('click', () => {
  button.closest('dialog[open]')?.close();
  $('shortcuts-dialog').showModal();
}));
$('join-mode').addEventListener('click', () => setMode('join'));
$('create-mode').addEventListener('click', () => setMode('create'));
$('clear-recent').addEventListener('click', () => {
  save('meetstream_recent', '[]');
  save('meetstream_room', '');
  renderRecentRooms();
  $('lobby-heading').focus();
});
inputName.addEventListener('input', () => inputName.setCustomValidity(''));
inputRoom.addEventListener('input', () => inputRoom.setCustomValidity(''));
lobbyForm.addEventListener('submit', event => {
  event.preventDefault();
  const name = inputName.value.trim();
  if (!name) {
    inputName.setCustomValidity('Enter a display name.');
    inputName.reportValidity();
    return;
  }
  const room = mode === 'create' ? makeRoomCode() : normalizeRoom(inputRoom.value);
  if (!room) {
    inputRoom.setCustomValidity('Enter a room code or a valid meeting invite link.');
    inputRoom.reportValidity();
    return;
  }
  enterMeeting(room, name);
});

$('invite-button').addEventListener('click', openInvite);
$('empty-invite').addEventListener('click', openInvite);
$('copy-invite').addEventListener('click', () => copy($('invite-link').value, 'Invite link'));
$('copy-code').addEventListener('click', () => copy(active.room, 'Room code'));
$('fullscreen-button').addEventListener('click', () => toggleFullscreen());
$('enable-audio').addEventListener('click', () => {
  const session = active;
  if (!session) return;
  if (session.relayAudioBlocked) void session.relay.enableAudio();
  for (const person of session.people.values()) {
    if (!person.awaitingAudio || person.local) continue;
    person.video.muted = false;
    playRemote(session, person);
  }
});
$('retry-media').addEventListener('click', () => {
  active?.socket?.close(4000, 'Retry media');
});
$('mic-button').addEventListener('click', () => active?.media.toggleMic());
$('camera-button').addEventListener('click', () => active?.media.toggleCamera());
$('share-button').addEventListener('click', toggleShare);
$('start-share').addEventListener('click', () => {
  $('share-dialog').close();
  active?.media.toggleShare($('share-audio').checked);
});
$('hand-button').addEventListener('click', toggleHand);
$('reaction-button').addEventListener('click', () => setReactionPicker($('reactions').hidden));
$('leave-button').addEventListener('click', () => leaveMeeting());
$('close-inspector').addEventListener('click', () => {
  const previous = openPanel;
  setSidebar(null);
  if (previous) $(previous + '-button').focus();
});
for (const name of sidebarTabs) {
  $(name + '-button').addEventListener('click', () => setSidebar(openPanel === name ? null : name));
  $(name + '-tab').addEventListener('click', () => setSidebar(name));
}
$('inspector').querySelector('[role=tablist]').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = sidebarTabs.indexOf(openPanel);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? sidebarTabs.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : -1) + sidebarTabs.length) % sidebarTabs.length;
  setSidebar(sidebarTabs[next]);
  $(sidebarTabs[next] + '-tab').focus();
});
$('chat-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !active) return;
  if (Date.now() - (active.lastChat || 0) < 450) {
    notify('Give it a moment before sending another message.');
    return;
  }
  if (meetingAction('chat-message', { text })) {
    active.lastChat = Date.now();
    input.value = '';
  }
});
notes.addEventListener('input', () => {
  if (!active) return;
  save('meetstream_notes_' + active.room, notes.value);
  $('download-notes').disabled = !notes.value.trim();
});
$('download-notes').addEventListener('click', () => {
  if (!active || !notes.value.trim()) return;
  const url = URL.createObjectURL(new Blob([notes.value], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'MeetStream-' + active.room + '-notes.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.addEventListener('click', event => {
  if (!event.target.closest('.reaction-control')) setReactionPicker(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('reactions').hidden) {
    setReactionPicker(false);
    $('reaction-button').focus();
    return;
  }
  if (!active || meeting.hidden || event.defaultPrevented || event.repeat ||
      event.altKey || event.ctrlKey || event.metaKey || document.querySelector('dialog[open]') ||
      event.target.closest('input, textarea, select, [contenteditable]')) return;
  const actions = {
    m: () => active.media.toggleMic(),
    v: () => active.media.toggleCamera(),
    3: () => active.media.toggleShare(true),
    s: toggleShare,
    h: toggleHand,
    c: () => { setSidebar('chat'); $('chat-input').focus(); },
    n: () => { setSidebar('notes'); notes.focus(); },
    f: () => toggleFullscreen()
  };
  actions[1] = actions.m;
  actions[2] = actions.v;
  const action = actions[event.key.toLowerCase()];
  if (action) {
    event.preventDefault();
    action();
  }
});
window.addEventListener('pagehide', () => leaveMeeting({ returnToLobby: false }));
window.addEventListener('pageshow', event => {
  if (event.persisted && !active && !meeting.hidden) location.reload();
});

initIcons(document);
mountCallSettings({
  getSession: () => meeting.hidden ? null : active,
  getInputIds: preferredInputs,
  saveInputIds: ids => save('meetstream_inputs', JSON.stringify(ids)),
  notify
});
applyTheme(load('meetstream_theme'));
inputName.value = load('meetstream_name') || '';
const invitedRoom = normalizeRoom(new URL(location.href).searchParams.get('room') || '');
inputRoom.value = invitedRoom || normalizeRoom(load('meetstream_room') || '');
try {
  const defaults = JSON.parse(load('meetstream_devices') || '{}');
  $('start-mic').checked = defaults.mic !== false;
  $('start-camera').checked = defaults.camera !== false;
} catch {
  // Default controls are set in the lobby markup.
}
setMode('join');
renderRecentRooms();
window.addEventListener('load', () => {
  if (active) return;
  try {
    const savedSession = JSON.parse(sessionStorage.getItem(resumeKey) || 'null');
    if (savedSession && normalizeRoom(savedSession.room) && typeof savedSession.name === 'string' &&
        (!invitedRoom || invitedRoom === savedSession.room)) {
      inputName.value = savedSession.name;
      inputRoom.value = savedSession.room;
      $('start-mic').checked = savedSession.mic === true;
      $('start-camera').checked = savedSession.camera === true;
      enterMeeting(savedSession.room, savedSession.name);
    }
  } catch {
    // Malformed or unavailable session storage leaves the lobby ready for manual entry.
  }
}, { once: true });
