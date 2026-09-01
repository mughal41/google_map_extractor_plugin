// Custom autocomplete dropdown. Chrome's native <datalist> popup cannot be
// styled and overflows the extension popup, so suggestions render in an owned
// listbox that stays inside the shell. APG combobox pattern: filtered options,
// arrow-key navigation, Enter selects, Esc closes (and is consumed so it never
// dismisses the extension popup).
export function filterOptions(options, query, limit = 60) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return options.slice(0, limit);
  const starts = [];
  const includes = [];
  for (const option of options) {
    const lower = option.toLowerCase();
    if (lower.startsWith(needle)) starts.push(option);
    else if (lower.includes(needle)) includes.push(option);
  }
  return [...starts, ...includes].slice(0, limit);
}

const EDGE = 8;
let panelCount = 0;

export function attachCombobox(input, getOptions, { onSelect } = {}) {
  const doc = input.ownerDocument;
  const panelId = `combo-panel-${panelCount += 1}`;
  const panel = doc.createElement('div');
  panel.id = panelId;
  panel.className = 'combo-panel';
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;
  doc.body.append(panel);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', panelId);

  let current = [];
  let active = -1;
  let suppressRender = false;

  function position() {
    const rect = input.getBoundingClientRect();
    panel.style.minWidth = `${Math.round(rect.width)}px`;
    panel.style.left = `${Math.round(Math.max(EDGE, Math.min(rect.left, window.innerWidth - panel.offsetWidth - EDGE)))}px`;
    const below = rect.bottom + 4;
    if (below + panel.offsetHeight > window.innerHeight - EDGE) {
      panel.style.top = `${Math.round(Math.max(EDGE, rect.top - panel.offsetHeight - 4))}px`;
    } else {
      panel.style.top = `${Math.round(below)}px`;
    }
  }

  function close() {
    panel.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function setActive(index) {
    active = index;
    for (const [i, el] of [...panel.children].entries()) {
      el.classList.toggle('active', i === index);
      el.setAttribute('aria-selected', i === index ? 'true' : 'false');
    }
    if (index >= 0) {
      input.setAttribute('aria-activedescendant', `${panelId}-o${index}`);
      panel.children[index]?.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function select(value) {
    input.value = value;
    suppressRender = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    suppressRender = false;
    close();
    onSelect?.(value);
  }

  function render() {
    if (suppressRender) return;
    current = filterOptions(getOptions() || [], input.value);
    if (!current.length) { close(); return; }
    panel.innerHTML = '';
    for (const [index, value] of current.entries()) {
      const item = doc.createElement('div');
      item.id = `${panelId}-o${index}`;
      item.className = 'combo-option';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      item.textContent = value;
      item.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        select(value);
      });
      panel.append(item);
    }
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    panel.scrollTop = 0;
    setActive(-1);
    position();
  }

  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (panel.hidden) { render(); return; }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + current.length) % current.length);
    } else if (event.key === 'Enter') {
      if (!panel.hidden && active >= 0) {
        event.preventDefault();
        select(current[active]);
      } else {
        close();
      }
    } else if (event.key === 'Escape') {
      if (!panel.hidden) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    } else if (event.key === 'Tab') {
      close();
    }
  });
  doc.addEventListener('scroll', close, true);
  window.addEventListener('blur', close);
  return { close, render };
}
