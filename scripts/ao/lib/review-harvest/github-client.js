import { spawn } from 'node:child_process';

const SAFE_RESPONSE_HEADERS = new Set([
  'content-type',
  'date',
  'etag',
  'last-modified',
  'link',
  'retry-after',
  'x-github-api-version-selected',
  'x-github-media-type',
  'x-github-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'x-ratelimit-used',
]);

function parseHeaders(text) {
  const lines = text.split(/\r?\n/);
  const statusMatch = lines.shift()?.match(/^HTTP\/\S+\s+(\d+)/i);
  const headers = {};
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (!SAFE_RESPONSE_HEADERS.has(key)) continue;
    headers[key] = line.slice(separator + 1).trim();
  }
  return {
    status: statusMatch ? Number(statusMatch[1]) : null,
    headers,
  };
}

export function parseGhApiResponse(stdout, stderr = '', processStatus = 0) {
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
  let separator = bytes.indexOf(Buffer.from('\r\n\r\n'));
  let separatorLength = 4;
  if (separator < 0) {
    separator = bytes.indexOf(Buffer.from('\n\n'));
    separatorLength = 2;
  }
  if (separator < 0) {
    return {
      status: null,
      headers: {},
      body: Buffer.alloc(0),
      process_status: processStatus,
      stderr: String(stderr ?? ''),
    };
  }
  const headerBlock = bytes.subarray(0, separator).toString('utf8');
  const parsed = parseHeaders(headerBlock);
  return {
    ...parsed,
    body: bytes.subarray(separator + separatorLength),
    process_status: processStatus,
    stderr: String(stderr ?? ''),
  };
}

function defaultSpawn(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({
      status,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

export function createGhApiProvider({ run = defaultSpawn, env = process.env } = {}) {
  return {
    async get(endpoint, parameters = {}) {
      const args = [
        'api',
        '--include',
        '--method',
        'GET',
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        'X-GitHub-Api-Version: 2022-11-28',
        endpoint.replace(/^\//, ''),
      ];
      for (const key of Object.keys(parameters).sort((left, right) => left.localeCompare(right))) {
        args.push('-f', `${key}=${parameters[key]}`);
      }
      const result = await run('gh', args, { env });
      return parseGhApiResponse(result.stdout, result.stderr, result.status);
    },
  };
}

export function parseJsonBody(response, label) {
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON response for ${label}: ${error.message}`);
  }
}

export function hasNextPage(headers) {
  return /<[^>]+>;\s*rel="next"/.test(String(headers?.link ?? ''));
}

function secondsUntil(resetEpochSeconds, nowMs) {
  const resetMs = Number(resetEpochSeconds) * 1000;
  if (!Number.isFinite(resetMs)) return null;
  return Math.max(1, Math.ceil((resetMs - nowMs) / 1000) + 1);
}

export function createRateLimitGuard({
  provider,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  thresholds = { core: 1500, graphql: 1500, search: 10 },
  onEvent = () => {},
  maxAttempts = 6,
} = {}) {
  if (!provider || typeof provider.get !== 'function') throw new Error('GitHub provider is required');

  async function waitFor(seconds, event) {
    onEvent({ ...event, wait_seconds: seconds });
    await sleep(seconds * 1000);
    onEvent({ event: 'rate_limit_resumed', resource: event.resource ?? null });
  }

  async function check(resource) {
    const response = await provider.get('/rate_limit');
    if (response.status !== 200 || response.process_status !== 0) {
      throw new Error(`Rate-limit preflight failed (${response.status ?? 'no-http-status'}): ${response.stderr}`);
    }
    const body = parseJsonBody(response, '/rate_limit');
    const snapshot = {
      core: body?.resources?.core ?? null,
      graphql: body?.resources?.graphql ?? null,
      search: body?.resources?.search ?? null,
    };
    onEvent({ event: 'rate_limit_query', requested_resource: resource, snapshot });
    for (const name of ['core', 'graphql', ...(resource === 'search' ? ['search'] : [])]) {
      const rate = snapshot[name];
      if (!rate || Number(rate.remaining) >= thresholds[name]) continue;
      const waitSeconds = secondsUntil(rate.reset, now());
      if (waitSeconds == null) throw new Error(`Rate limit ${name} below reserve without reset evidence`);
      await waitFor(waitSeconds, {
        event: 'rate_limit_paused',
        resource: name,
        remaining: rate.remaining,
        threshold: thresholds[name],
        reset: rate.reset,
      });
      return check(resource);
    }
    return snapshot;
  }

  async function get(endpoint, parameters = {}, { resource = 'core' } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await provider.get(endpoint, parameters);
      const remaining = Number(response.headers?.['x-ratelimit-remaining']);
      const reset = response.headers?.['x-ratelimit-reset'];
      const retryAfter = Number(response.headers?.['retry-after']);
      const bodyText = response.body.toString('utf8');
      const secondary = response.status === 429
        || (response.status === 403 && /secondary rate limit|abuse detection/i.test(bodyText));
      const primary = response.status === 403 && remaining === 0;
      const transient = response.status == null
        || response.status >= 500
        || /timeout|timed out|connection reset|temporary failure|tls handshake/i.test(response.stderr);

      if (response.status >= 200 && response.status < 300 && response.process_status === 0) {
        return response;
      }
      if (!secondary && !primary && response.status !== 429 && !transient) {
        throw new Error(`GitHub GET failed ${endpoint} (${response.status ?? 'no-http-status'}): ${response.stderr || bodyText}`);
      }
      if (attempt === maxAttempts) {
        throw new Error(`GitHub rate-limit recovery exhausted for ${endpoint}`);
      }
      const headerWait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
      const resetWait = primary ? secondsUntil(reset, now()) : null;
      const backoff = Math.min(300, 2 ** (attempt - 1));
      await waitFor(headerWait ?? resetWait ?? backoff, {
        event: transient
          ? 'transient_request_retry'
          : (secondary ? 'secondary_rate_limit_paused' : 'primary_rate_limit_paused'),
        resource,
        endpoint,
        attempt,
        status: response.status,
        remaining: Number.isFinite(remaining) ? remaining : null,
        reset: reset ?? null,
      });
    }
    throw new Error(`Unreachable GitHub request state for ${endpoint}`);
  }

  return { check, get };
}
