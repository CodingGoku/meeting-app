import { initIcons, setIcon } from './icons.js?v=5';

const meeting = document.getElementById('meetingUI');
const fullscreen = document.getElementById('fullscreenBtn');
const themeButtons = document.querySelectorAll('[data-theme-toggle]');
const shortcuts = document.getElementById('shortcuts-dialog');

function applyTheme(value) {
  const light = value === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]').content = light ? '#eeeff7' : '#10111b';
  for (const button of themeButtons) {
    const label = light ? 'Switch to dark theme' : 'Switch to light theme';
    button.setAttribute('aria-label', label);
    button.title = label;
    setIcon(button, light ? 'moon' : 'sun');
  }
}

function syncFullscreenButton() {
  const expanded = Boolean(document.fullscreenElement);
  const label = expanded ? 'Exit full screen' : 'Enter full screen';
  fullscreen.setAttribute('aria-label', label);
  fullscreen.title = label;
  setIcon(fullscreen, expanded ? 'fullscreenExit' : 'fullscreen');
}

initIcons(document);
try {
  applyTheme(localStorage.getItem('meetstream_theme'));
} catch {
  applyTheme('dark');
}

for (const button of themeButtons) {
  button.addEventListener('click', () => {
    const value = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(value);
    try {
      localStorage.setItem('meetstream_theme', value);
    } catch {
      // The selection still applies in this tab when storage is unavailable.
    }
  });
}
document.querySelectorAll('[data-shortcuts]').forEach(button => {
  button.addEventListener('click', () => shortcuts.showModal());
});

const controls = [
  { id: 'micBtn', flag: 'mic-off', icon: 'mic', offIcon: 'micOff', on: 'Mute microphone (1)', off: 'Unmute microphone (1)' },
  { id: 'camBtn', flag: 'cam-off', icon: 'video', offIcon: 'videoOff', on: 'Turn off camera (2)', off: 'Turn on camera (2)' },
  { id: 'screenBtn', flag: 'screen-active', icon: 'screen', on: 'Stop sharing', off: 'Share screen (3)' }
];
for (const { id, flag, icon, offIcon = icon, on, off } of controls) {
  const button = document.getElementById(id);
  const refresh = () => {
    const flagged = button.classList.contains(flag);
    const enabled = flag === 'screen-active' ? flagged : !flagged;
    button.setAttribute('aria-pressed', String(enabled));
    button.title = enabled ? on : off;
    setIcon(button.firstElementChild, enabled ? icon : offIcon);
  };
  new MutationObserver(refresh).observe(button, { attributes: true, attributeFilter: ['class'] });
  refresh();
}

document.addEventListener('fullscreenchange', syncFullscreenButton);
syncFullscreenButton();

// Put legacy UI feedback above a fullscreen meeting without changing its handlers.
new MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement) || !node.matches('.toast, .share-dialog')) continue;
      if (node.matches('.share-dialog')) {
        node.setAttribute('role', 'dialog');
        node.setAttribute('aria-label', 'Share your screen');
      } else {
        node.setAttribute('role', 'status');
      }
      if (document.fullscreenElement === meeting) meeting.append(node);
    }
  }
}).observe(document.body, { childList: true });

new MutationObserver(() => {
  if (meeting.style.display === 'none' && meeting.contains(document.fullscreenElement)) {
    void document.exitFullscreen().catch(() => {});
  }
}).observe(meeting, { attributes: true, attributeFilter: ['style'] });
