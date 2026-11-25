export function mountDock(dock) {
  const buttons = [...dock.querySelectorAll('.dock-btn')];
  const motion = matchMedia('(prefers-reduced-motion: no-preference)');
  const hoverMotion = matchMedia('(min-width: 620px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)');
  let pointerX = 0;
  let frame = 0;
  let feedback;

  function clearWave() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    for (const button of buttons) {
      button.style.removeProperty('--dock-scale');
      button.style.removeProperty('--dock-lift');
    }
  }

  function updateWave() {
    frame = 0;
    // Read the stationary hit targets before changing any artwork transforms.
    const bounds = buttons.map(button => button.getBoundingClientRect());
    buttons.forEach((button, index) => {
      const { left, width } = bounds[index];
      const distance = Math.min(1, Math.abs(pointerX - left - width / 2) / (width * 2.4));
      const influence = (1 + Math.cos(distance * Math.PI)) / 2;
      button.style.setProperty('--dock-scale', (1 + influence * .52).toFixed(3));
      button.style.setProperty('--dock-lift', (influence * 12).toFixed(2) + 'px');
    });
  }

  dock.addEventListener('pointermove', event => {
    if (!hoverMotion.matches || event.pointerType === 'touch' ||
        dock.querySelector('.reaction-popover:not([hidden])')) return;
    pointerX = event.clientX;
    if (!frame) frame = requestAnimationFrame(updateWave);
  }, { passive: true });
  dock.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch') clearWave();
  }, { passive: true });
  dock.addEventListener('pointerleave', clearWave);
  dock.addEventListener('pointercancel', clearWave);
  window.addEventListener('blur', clearWave);
  hoverMotion.addEventListener('change', clearWave);
  motion.addEventListener('change', () => feedback?.cancel());

  dock.addEventListener('click', event => {
    const button = event.target.closest('.dock-btn');
    if (!button || button.disabled) return;
    if (button.classList.contains('leave-button')) {
      clearWave();
      feedback?.cancel();
      return;
    }
    if (button.getAttribute('aria-expanded') === 'true') clearWave();
    if (!motion.matches) return;
    feedback?.cancel();
    feedback = button.querySelector('.dock-art').animate([
      { translate: '0 0' },
      { translate: '0 -6px', offset: .4 },
      { translate: '0 0', offset: .73 },
      { translate: '0 -2px', offset: .86 },
      { translate: '0 0' }
    ], { duration: 320, easing: 'ease-out' });
  });

  dock.addEventListener('pointerover', event => {
    const button = event.target.closest('.dock-btn');
    if (button && !button.contains(event.relatedTarget)) dock.classList.remove('hints-dismissed');
  });
  dock.addEventListener('focusin', () => dock.classList.remove('hints-dismissed'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') dock.classList.add('hints-dismissed');
  });
  dock.addEventListener('keydown', event => {
    const index = buttons.indexOf(event.target);
    if (index < 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

    let next = index;
    switch (event.key) {
      case 'ArrowLeft': next = (index - 1 + buttons.length) % buttons.length; break;
      case 'ArrowRight': next = (index + 1) % buttons.length; break;
      case 'Home': next = 0; break;
      case 'End': next = buttons.length - 1; break;
      default: return;
    }
    event.preventDefault();
    buttons[next].focus();
  });
}
