export function resolveNow(now) {
  if (typeof now === 'function') return resolveNow(now());
  if (typeof now === 'string' && now.trim() !== '') return now.trim();
  return new Date().toISOString();
}

export function compareIsoDescending(left, right) {
  return String(right ?? '').localeCompare(String(left ?? ''));
}

export function addMilliseconds(isoTimestamp, durationMs) {
  if (isoTimestamp == null || typeof isoTimestamp !== 'string' || isoTimestamp.trim() === '') {
    throw new Error(`Invalid timestamp: ${isoTimestamp}`);
  }
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${isoTimestamp}`);
  }

  return new Date(date.getTime() + durationMs).toISOString();
}
