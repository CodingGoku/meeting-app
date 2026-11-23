import { initIcons, setIcon } from './icons.js?v=3';
import { MeetingMedia } from './media.js?v=3';

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
  theme = value === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#eeeff7' : '#10111b';
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
    person = { id, tile, video, local: id === session.id };
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
  person.media = state;
  person.tile.classList.toggle('is-sharing', state.sharing);
  person.tile.querySelector('.tile-sharing').hidden = !state.sharing;
  person.tile.querySelector('.tile-muted').hidden = state.mic !== false;
  if (!person.local) renderRemote(session, person, person.video.srcObject);
  syncMeetingActions(session);
}

function renderRemote(session, person, stream) {
  if (!person) return;
  const hasVideo = (person.media == null || person.media.camera || person.media.sharing) &&
    Boolean(stream?.getVideoTracks().some(track => !track.muted && track.readyState === 'live'));
  showStream(person, stream, hasVideo);
  if (stream?.getTracks().some(track => !track.muted && track.readyState === 'live') &&
      person.video.paused && !person.playAttempt) playRemote(session, person);
}

function playRemote(session, person) {
  const video = person.video;
  person.playAttempt = video.play().then(() => {
    if (!video.muted) person.awaitingAudio = false;
  }).catch(async error => {
    if (error.name !== 'NotAllowedError' || video.muted) return;
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
  $('enable-audio').hidden = !people.some(person => person.awaitingAudio);
  $('retry-media').hidden = !session.ready || !people.some(person => person.connection === 'failed');
  $('video-grid').classList.toggle('has-share', people.some(person => person.media?.sharing));
  if (!session.ready) return;
  const remote = people.filter(person => !person.local);
  let label = 'Connected';
  if (remote.some(person => person.connection === 'failed')) label = 'Media needs attention';
  else if (remote.some(person => person.connection === 'reconnecting')) label = 'Reconnecting media…';
  else if (remote.some(person => person.connection !== 'connected')) label = 'Connecting media…';
  setConnection(label);
}

function updatePeerStatus(session, id, status) {
  const person = session.people.get(id);
  if (!person || active !== session) return;
  person.connection = status;
  const badge = person.tile.querySelector('.tile-connection');
  badge.hidden = status === 'connected';
  badge.textContent = { connecting: 'Connecting…', reconnecting: 'Reconnecting…', failed: 'Media unavailable' }[status] || '';
  syncMeetingActions(session);
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
  $('connection-indicator').classList.toggle('is-waiting', value !== 'Connected');
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
  session.socket.send(JSON.stringify({ type, ...payload, from: session.id, fromName: session.name }));
  return true;
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
    case 'existing-participants':
      session.ready = true;
      session.failures = 0;
      clearTimeout(session.connectTimeout);
      if (!session.started) {
        session.started = Date.now();
        session.timer = setInterval(() => tick(session), 1000);
        rememberRoom(session);
      }
      session.hasMediaState = Boolean(data.yourInfo?.media);
      session.media.setIceServers(data.iceServers);
      rememberActiveMeeting(session);
      for (const person of data.participants) {
        setPerson(session, person.userId, person.userName, person.raised, person.media);
        void session.media.addPeer(person.userId, false, person.participantId);
      }
      if (session.hasMediaState) send(session, 'media-state', session.mediaState);
      if (session.people.get(session.id).raised) send(session, 'hand-raised', { raised: true });
      updateRoster(session);
      syncMeetingActions(session);
      break;
    case 'user-joined':
      setPerson(session, data.userId, data.userName, data.raised, data.media);
      updateRoster(session);
      void session.media.addPeer(data.userId, true, data.participantId);
      break;
    case 'offer':
    case 'answer':
    case 'ice-candidate':
      void session.media.handleSignal(data);
      break;
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
      if (!session.ready) leaveMeeting();
      break;
  }
}

function connect(session) {
  const url = new URL(location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  const socket = new WebSocket(url);
  session.socket = socket;
  session.connectTimeout = setTimeout(() => socket.close(), 9000);
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
      type: 'join-room', roomId: session.room, userId: session.id, userName: session.name,
      connectionKey: session.connectionKey, media: session.mediaState
    }));
  });
  socket.addEventListener('message', event => {
    if (active !== session || socket !== session.socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      handleMessage(session, JSON.parse(event.data));
    } catch (error) {
      console.warn('Meeting message could not be processed', error);
    }
  });
  socket.addEventListener('close', () => {
    clearTimeout(session.connectTimeout);
    if (active !== session || socket !== session.socket) return;
    session.ready = false;
    for (const id of session.people.keys()) {
      if (id === session.id) continue;
      session.media.removePeer(id);
      removePerson(session, id);
    }
    updateRoster(session);
    session.failures += 1;
    if (session.failures > 4) {
      leaveMeeting();
      notify('Connection lost. You can rejoin from the lobby.');
      return;
    }
    setConnection(session.started ? 'Reconnecting…' : 'Connecting…');
    session.retry = setTimeout(() => connect(session), 800 * 2 ** (session.failures - 1));
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
    mediaState: {}, failures: 0
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
      onRemoteRemoved: id => showStream(session.people.get(id), null, false),
      onStatus: (id, status) => updatePeerStatus(session, id, status),
      notify
    });
    await session.media.prepare(devices);
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
document.querySelectorAll('[data-shortcuts]').forEach(button => button.addEventListener('click', () => $('shortcuts-dialog').showModal()));
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
