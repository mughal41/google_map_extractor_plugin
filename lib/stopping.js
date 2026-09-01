export function endOfListTextFound(feed, document) {
  const text = `${feed?.innerText || ''} ${document?.body?.innerText || ''}`;
  return /you(?:'|’)?ve reached the end of the list/i.test(text);
}

export function nextStallState(previous, { newUnique, scrollHeight, atBottom }) {
  return {
    noNewCycles: newUnique === 0 ? previous.noNewCycles + 1 : 0,
    stableHeightCycles: scrollHeight === previous.lastScrollHeight
      ? previous.stableHeightCycles + 1 : 0,
    lastScrollHeight: scrollHeight,
    atBottom
  };
}

export function shouldStopScrolling(state, explicitEnd = false) {
  return explicitEnd || state.noNewCycles >= 3 ||
    (state.atBottom && state.stableHeightCycles >= 3);
}
