const paths = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20.9 13.4A9 9 0 1 1 10.6 3.1a7.2 7.2 0 0 0 10.3 10.3Z"/>',
  keyboard: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8"/>',
  video: '<rect x="2.5" y="5.5" width="13" height="13" rx="2.5"/><path d="m15.5 10 6-3v10l-6-3"/>',
  videoOff: '<path d="M10 5.5h3a2.5 2.5 0 0 1 2.5 2.5v2l6-3v10l-2-1M15.5 15v1a2.5 2.5 0 0 1-2.5 2.5H5A2.5 2.5 0 0 1 2.5 16V8A2.5 2.5 0 0 1 3 6.5M3 3l18 18"/>',
  mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 10.5v1a6.5 6.5 0 0 0 13 0v-1M12 18v3.5m-3.5 0h7"/>',
  micOff: '<path d="M9 9v2.5a3 3 0 0 0 4.5 2.6M9.4 4A3 3 0 0 1 15 5.5V9m-9.5 1.5v1a6.5 6.5 0 0 0 11.1 4.6m1.9-4.6v-1M12 18v3.5m-3.5 0h7M3 3l18 18"/>',
  logIn: '<path d="M13 4h5.5A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5H13M3 12h12m-4-4 4 4-4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  fullscreen: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
  fullscreenExit: '<path d="M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  screen: '<rect x="2.5" y="4" width="19" height="13" rx="2.5"/><path d="M8 21h8m-4-4v4m0-7V7.5m-2.5 2.5L12 7.5l2.5 2.5"/>',
  phone: '<path d="M3 14a1.8 1.8 0 0 1 .5-2 13 13 0 0 1 17 0 1.8 1.8 0 0 1 .5 2l-.5 1.5a1.6 1.6 0 0 1-1.9 1l-2.6-.7a1.5 1.5 0 0 1-1.1-1.4v-1a9 9 0 0 0-5.8 0v1A1.5 1.5 0 0 1 8 15.8l-2.6.7a1.6 1.6 0 0 1-1.9-1Z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
};

export function setIcon(element, name = element.dataset.icon) {
  element.dataset.icon = name;
  element.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths[name] + '</svg>';
}

export function initIcons(root) {
  root.querySelectorAll('[data-icon]').forEach(element => setIcon(element));
}
