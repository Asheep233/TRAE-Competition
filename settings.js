'use strict';

// Presentation preferences stay separate from drafts and device integration.
(() => {
  const STORAGE_KEY = 'diandian-settings-v1';
  const DEFAULT_FONT_SIZE = 'large';
  const labels = { standard: '标准字体', large: '大字体', extra: '特大字体' };
  let preferences = { fontSize: DEFAULT_FONT_SIZE };

  const isValidSize = size => Object.prototype.hasOwnProperty.call(labels, size);
  const getPreferences = () => ({ ...preferences });

  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (stored && isValidSize(stored.fontSize)) preferences.fontSize = stored.fontSize;
  } catch {
    // The large default also works when browser storage is unavailable.
  }

  function render(message) {
    document.body.dataset.fontSize = preferences.fontSize;
    document.querySelectorAll('button[data-font-size]').forEach(button => {
      const active = button.dataset.fontSize === preferences.fontSize;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const status = document.getElementById('fontSizeStatus');
    if (status) status.textContent = message || `当前使用${labels[preferences.fontSize]}。更改会立即应用到整个页面。`;
  }

  function setFontSize(size) {
    if (!isValidSize(size)) return getPreferences();
    preferences.fontSize = size;
    let saved = true;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      saved = false;
    }
    render(`已使用${labels[size]}。${saved ? '下次打开会保留此设置。' : '此设置已在当前页面生效。'}`);
    window.dispatchEvent(new CustomEvent('diandian:preferenceschange', { detail: getPreferences() }));
    return getPreferences();
  }

  render();
  document.querySelectorAll('button[data-font-size]').forEach(button => {
    button.addEventListener('click', () => setFontSize(button.dataset.fontSize));
  });
  document.getElementById('resetSettings')?.addEventListener('click', () => setFontSize(DEFAULT_FONT_SIZE));

  // A small public interface for future settings or account integrations.
  window.DianDianSettings = Object.freeze({ getPreferences, setFontSize });
})();
