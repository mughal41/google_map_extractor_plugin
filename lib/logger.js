export class Logger {
  constructor(debug = false, sink = console) {
    this.debugEnabled = debug;
    this.sink = sink;
  }

  debug(code, context = {}) {
    if (this.debugEnabled) this.sink.debug?.(`[MapsExtractor] ${code}`, context);
  }

  info(code, context = {}) {
    if (this.debugEnabled) this.sink.info?.(`[MapsExtractor] ${code}`, context);
  }

  warn(code, context = {}) {
    this.sink.warn?.(`[MapsExtractor] ${code}`, context);
  }

  error(code, context = {}) {
    this.sink.error?.(`[MapsExtractor] ${code}`, context);
  }
}
