(() => {
  if (window.__mapsLightExtractorInstalled) return;
  window.__mapsLightExtractorInstalled = true;

  const MAX_BODY_CHARS = 2_000_000;
  const interestingUrl = (url) => /(?:\/maps\/|batchexecute|preview\/search)/i.test(String(url || ''));

  function emit(body) {
    if (typeof body !== 'string' || body.length === 0) return;
    window.postMessage({
      source: 'maps-light-extractor',
      type: 'MAPS_PAYLOAD',
      body: body.slice(0, MAX_BODY_CHARS)
    }, location.origin);
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const result = originalFetch.apply(this, args);
    result.then((response) => {
      const length = Number(response.headers.get('content-length') || 0);
      const type = response.headers.get('content-type') || '';
      if (interestingUrl(response.url) && (!length || length <= MAX_BODY_CHARS) &&
          /json|text|javascript|octet-stream/i.test(type)) {
        response.clone().text().then(emit).catch(() => undefined);
      }
    }).catch(() => undefined);
    return result;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__mapsLightExtractorUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (interestingUrl(this.__mapsLightExtractorUrl)) {
      this.addEventListener('load', () => {
        if ((this.responseType === '' || this.responseType === 'text') && typeof this.responseText === 'string') {
          emit(this.responseText);
        }
      }, { once: true });
    }
    return originalSend.apply(this, args);
  };
})();
