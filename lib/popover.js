// Accessible info-popover ("toggletip") controller. One delegated controller,
// one reusable panel, exactly one popover open at a time. Hover opens a
// transient popover after a short intent delay; click / Enter / Space pins it;
// Esc closes it and is consumed so it never dismisses the whole extension
// popup; outside clicks close pinned popovers. Panels are clamped inside the
// popup window because Chrome hard-clips anything that overhangs it.
import { GLOSSARY } from './glossary.js';

const ICON_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
  + '<circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.6"/>'
  + '<circle cx="8" cy="4.8" r="1" fill="currentColor"/>'
  + '<rect x="7.2" y="7" width="1.6" height="4.6" rx=".8" fill="currentColor"/></svg>';

const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 180;
const EDGE = 8;

export function initPopovers(doc = document) {
  const panel = doc.getElementById('popover');
  if (!panel) return;
  let openTrigger = null;
  let pinned = false;
  let openTimer = 0;
  let closeTimer = 0;

  for (const button of doc.querySelectorAll('button.info')) {
    const entry = GLOSSARY[button.dataset.info];
    button.innerHTML = ICON_SVG;
    button.setAttribute('aria-label', `About: ${entry ? entry.title : button.dataset.info}`);
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'popover');
  }

  function position(trigger) {
    const rect = trigger.getBoundingClientRect();
    panel.style.maxWidth = '280px';
    const { offsetWidth: width, offsetHeight: height } = panel;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE));
    let top = rect.bottom + 7;
    if (top + height > window.innerHeight - EDGE) top = rect.top - height - 7;
    if (top < EDGE) top = EDGE;
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  function open(trigger, pin) {
    const entry = GLOSSARY[trigger.dataset.info];
    if (!entry) return;
    if (openTrigger && openTrigger !== trigger) close();
    openTrigger = trigger;
    pinned = pinned || pin;
    panel.innerHTML = '';
    const title = doc.createElement('h3');
    title.textContent = entry.title;
    const body = doc.createElement('p');
    body.textContent = entry.body;
    panel.append(title, body);
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    position(trigger);
    if (pin) {
      const live = doc.getElementById('live-status');
      if (live) live.textContent = `${entry.title}. ${entry.body}`;
    }
  }

  function close() {
    if (!openTrigger) return;
    openTrigger.setAttribute('aria-expanded', 'false');
    openTrigger = null;
    pinned = false;
    panel.hidden = true;
  }

  doc.addEventListener('pointerover', (event) => {
    const trigger = event.target.closest?.('button.info');
    if (trigger) {
      clearTimeout(closeTimer);
      if (openTrigger === trigger) return;
      clearTimeout(openTimer);
      openTimer = setTimeout(() => open(trigger, false), HOVER_OPEN_MS);
      return;
    }
    if (panel.contains(event.target)) { clearTimeout(closeTimer); return; }
    clearTimeout(openTimer);
    if (openTrigger && !pinned) {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(close, HOVER_CLOSE_MS);
    }
  });

  doc.addEventListener('pointerout', (event) => {
    // relatedTarget === null means the pointer left the popup window entirely,
    // so no further pointerover will ever fire to tidy up the timers.
    if (event.relatedTarget) return;
    clearTimeout(openTimer);
    if (openTrigger && !pinned) {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(close, HOVER_CLOSE_MS);
    }
  });

  // Scrolling an inner view moves the trigger but not the fixed panel:
  // re-anchor pinned popovers while the trigger stays visible, close once it
  // scrolls under the top bar or status bar, dismiss transient ones outright.
  // Capture phase because scroll events do not bubble.
  doc.addEventListener('scroll', () => {
    if (!openTrigger) return;
    if (!pinned) { close(); return; }
    const rect = openTrigger.getBoundingClientRect();
    if (rect.bottom < 56 || rect.top > window.innerHeight - 34) close();
    else position(openTrigger);
  }, true);

  doc.addEventListener('click', (event) => {
    const trigger = event.target.closest?.('button.info');
    if (trigger) {
      event.preventDefault();
      clearTimeout(openTimer);
      if (openTrigger === trigger && pinned) close();
      else { pinned = false; open(trigger, true); }
      return;
    }
    if (!panel.contains(event.target)) close();
  });

  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !openTrigger) return;
    event.preventDefault();
    event.stopPropagation();
    const trigger = openTrigger;
    close();
    trigger.focus();
  }, true);

  window.addEventListener('blur', () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    close();
  });
}
