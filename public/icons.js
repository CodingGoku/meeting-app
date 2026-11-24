const paths = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20.9 13.4A9 9 0 1 1 10.6 3.1a7.2 7.2 0 0 0 10.3 10.3Z"/>',
  keyboard: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8"/>',
  settings: '<path d="M5 3v4m0 4v10m7-18v10m0 4v4m7-18v2m0 4v12M2 7h6m1 6h6m1-8h6"/><circle cx="5" cy="9" r="2"/><circle cx="12" cy="15" r="2"/><circle cx="19" cy="7" r="2"/>',
  video: '<rect x="2.5" y="5.5" width="13" height="13" rx="2.5"/><path d="m15.5 10 6-3v10l-6-3"/>',
  videoOff: '<path d="M10 5.5h3a2.5 2.5 0 0 1 2.5 2.5v2l6-3v10l-2-1M15.5 15v1a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 16V8A2.5 2.5 0 0 1 3 6.5M3 3l18 18"/>',
  mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 10.5v1a6.5 6.5 0 0 0 13 0v-1M12 18v3.5m-3.5 0h7"/>',
  micOff: '<path d="M9 9v2.5a3 3 0 0 0 4.5 2.6M9.4 4A3 3 0 0 1 15 5.5V9m-9.5 1.5v1a6.5 6.5 0 0 0 11.1 4.6m1.9-4.6v-1M12 18v3.5m-3.5 0h7M3 3l18 18"/>',
  logIn: '<path d="M13 4h5.5A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5H13M3 12h12m-4-4 4 4-4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  link: '<path d="m10 13.5 4-4m-6 6-1 1a3.6 3.6 0 0 1-5 0 3.6 3.6 0 0 1 0-5l4-4a3.6 3.6 0 0 1 5 0m5 1 1-1a3.6 3.6 0 0 1 5 0 3.6 3.6 0 0 1 0 5l-4 4a3.6 3.6 0 0 1-5 0"/>',
  people: '<circle cx="9" cy="7.5" r="3"/><path d="M2.5 19v-1.5A4.5 4.5 0 0 1 7 13h4a4.5 4.5 0 0 1 4.5 4.5V19M16 4.6a3 3 0 0 1 0 5.8m2 2.7a4.5 4.5 0 0 1 3.5 4.4V19"/>',
  fullscreen: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
  fullscreenExit: '<path d="M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5"/>',
  volume: '<path d="M3 9v6h4l5 4V5L7 9H3Zm12 0a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  chat: '<path d="M20.5 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9l-4.5 1 1.1-4.3A8.5 8.5 0 1 1 20.5 11.5Z"/><path d="M8 11.5h.01m4 0h.01m4 0h.01"/>',
  note: '<path d="M14 3.5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9L14 3.5Zm0 0v6h6M8 13h8m-8 4h5"/>',
  send: '<path d="m21 3-7 18-3.5-7.5L3 10l18-7Zm0 0L10.5 13.5"/>',
  download: '<path d="M12 3.5v11m-4-4 4 4 4-4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  screen: '<rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M8 21h8m-4-4v4m0-7V7.5m-2.5 2.5L12 7.5l2.5 2.5"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14a4.5 4.5 0 0 0 8 0M9 9.5h.01m6 0h.01"/>',
  hand: '<path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V5a1.5 1.5 0 0 1 3 0v1a1.5 1.5 0 0 1 3 0v2a1.5 1.5 0 0 1 3 0v6a7 7 0 0 1-7 7h-1a6.5 6.5 0 0 1-5-2.4l-3.5-4.4a1.6 1.6 0 0 1 2.4-2.1L8 14m3-7.5V11m3-5v5m3-3v4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  pin: '<path d="m15 3 6 6-3 1-3 4v3l-1 1-3.5-3.5L5 20m5.5-5.5L7 11l1-1h3l3-4 1-3Z"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>'
};

export function setIcon(element, name = element.dataset.icon) {
  element.dataset.icon = name;
  element.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths[name] + '</svg>';
}

export function initIcons(root) {
  root.querySelectorAll('[data-icon]').forEach(element => setIcon(element));
}
