(async () => {
  try {
    await import(chrome.runtime.getURL('content.js'));
  } catch (error) {
    console.error('[MapsExtractor] CONTENT_BOOTSTRAP_FAILED', error);
  }
})();
