// free-model-aggregator-02: one server, two client wires, a real free model
// behind every answer.
//
// The trial runs this server as `node /bot/main.ts` from the repository root,
// with Node 22's standard library alone (nothing is installed; TypeScript
// runs directly, and a relative import needs its .ts extension). The env is
// at $MAKEFUN_ENV_URL; model calls go through the grader's gateway at
// $OPENAI_BASE_URL, an OpenAI-compatible endpoint that reaches OpenRouter on
// the key pushed to the competition. The brief at $MAKEFUN_PROMPT_FILE
// carries the free model list (gateway id, published rating, capabilities)
// and the six prompts' manifest, in the order the env sends them.
//
// The server:
//   1. listens on 0.0.0.0 at a free port (never 8080: the env owns it on one
//      layout);
//   2. POSTs $MAKEFUN_ENV_URL/register {"protocol_version": 1, "port": <port>,
//      "catalog": <catalog>};
//   3. serves GET /v1/models (in the shape of the auth header it got:
//      x-api-key means Anthropic, Authorization means OpenAI),
//      POST /v1/chat/completions and POST /v1/messages, each with a JSON
//      body or with server-sent events;
//   4. answers each prompt by dialling a free model through the gateway.
//      OPENAI_API_KEY in the sandbox is a dummy the gateway swaps for the
//      OpenRouter key pushed to the competition; the real key never enters
//      the sandbox;
//   5. polls GET $MAKEFUN_ENV_URL/work every 100 ms and exits 0 when the env
//      says {"done": true}. A process still running when the wall ends
//      scores zero, so it never waits for anything else.
//
// ROUTING (quality is 60% of the score)
//   For each prompt the candidates are the brief's free models that meet the
//   prompt's requirements, best first by the brief's rating_milli. The head
//   of the list is the best-rated model at the prompt's requirements, which
//   is exactly what the quality column pays for; the tail is the failover
//   order.
//
// FAILOVER (10% of the score)
//   A gateway call answered with a 4xx or a 5xx is not an answer: the server
//   retries a 5xx once on the same model, then fails over to the next free
//   model that meets the prompt. A 429 goes straight to failover (retrying
//   the same rate-limited model wastes a call), and a 401/403 gives up at
//   once (no model answers without a key). Models refused in this trial are
//   cooled down: later prompts skip them unless no other candidate remains.
//   Every refusal a retry or a failover recovered from is reported on the
//   response in the `x-makefun-upstream-failures` header, the only way the
//   failover column can see it. At most 4 gateway calls per prompt, so a
//   trial spends at most 24 of its 60.
//
// DETERMINISM
//   Every choice is a function of the brief, the requests and the gateway's
//   answers: no wall clock and no unseeded randomness in anything sent. The
//   only clock reads are local timeouts that never reach a request; the
//   poll interval is a timer, not a timestamp.
//
// `node main.ts --list` prints the same catalog JSON the register body
// carries, byte for byte, and exits 0 before any server starts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  freeModels,
  isRecord,
  rankedCandidates,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this server reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The gateway refuses a call with no output cap, or one over this. */
const MAX_OUTPUT_TOKENS = 8192;
/** Default output cap when the client names none. */
const DEFAULT_OUTPUT_TOKENS = 1024;
/** Most gateway calls spent on one prompt (retry + failovers). */
const MAX_ATTEMPTS_PER_PROMPT = 4;
/** One gateway call may take this long before it counts as refused. */
const DIAL_TIMEOUT_MS = 8000;
/** The whole dialling of one prompt must fit inside the client's 30 s. */
const PROMPT_DIAL_BUDGET_MS = 28000;
/** Fixed pause between two attempts of one prompt. */
const RETRY_PAUSE_MS = 250;
/** The failures header holds at most this many rows. */
const MAX_FAILURE_ROWS = 8;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which manifest row the request now arriving is: the brief's prompts arrive in order. */
let manifestIndex = 0;
/** Models a gateway call refused in this trial: later prompts skip them. */
const refusedModels = new Set<string>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the
 * OpenAI-compatible root (`…/v1` on the trial network); a base that does not
 * already end in `/v1` gets one, so both spellings reach the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1')
    ? `${GATEWAY_URL}/chat/completions`
    : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({
    id: model.id,
    provider: model.provider,
    display_name: model.display_name,
  }));
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) {
        vision = true;
      }
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
    json: format === 'json_object' || format === 'json_schema',
  };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The gateway refuses a call with no output cap, or one over the cap. */
function withOutputCap(body: Json): Json {
  const out = { ...body };
  const maxTokens = out.max_tokens;
  const maxCompletion = out.max_completion_tokens;
  if (typeof maxTokens !== 'number' && typeof maxCompletion !== 'number') {
    out.max_tokens = DEFAULT_OUTPUT_TOKENS;
  }
  if (typeof out.max_tokens === 'number' && out.max_tokens > MAX_OUTPUT_TOKENS) {
    out.max_tokens = MAX_OUTPUT_TOKENS;
  }
  if (typeof out.max_completion_tokens === 'number' && out.max_completion_tokens > MAX_OUTPUT_TOKENS) {
    out.max_completion_tokens = MAX_OUTPUT_TOKENS;
  }
  return out;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function sendError(
  res: ServerResponse,
  wire: 'openai' | 'anthropic',
  status: number,
  type: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message), extraHeaders);
  else sendJson(res, status, openAIError(message, type, null), extraHeaders);
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') {
    sendJson(res, 200, anthropicModelList(list));
  } else {
    sendJson(res, 200, openAIModelList(list));
  }
}

/** One refused gateway call, as the failures header reports it. */
interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

/** The gateway error body's code (`error.code`, else `error.type`), at most 64 chars. */
function errorCodeOf(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && isRecord(value.error)) {
      if (typeof value.error.code === 'string' && value.error.code !== '') {
        return value.error.code.slice(0, 64);
      }
      if (typeof value.error.type === 'string') return value.error.type.slice(0, 64);
    }
  } catch {
    // Not JSON: no code.
  }
  return '';
}

function failuresHeader(failures: FailureRow[]): Record<string, string> {
  if (failures.length === 0) return {};
  const rows = failures.slice(0, MAX_FAILURE_ROWS);
  return { 'x-makefun-upstream-failures': JSON.stringify(rows) };
}

/** One gateway attempt: the response, or null when the call never reached it. */
async function dialOnce(model: string, body: Json): Promise<Response | null> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  try {
    return await fetch(chatCompletionsUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, model }),
      signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/** A served prompt's upstream answer: the model that served it and its response. */
interface ServedAnswer {
  model: ModelRow;
  response: Response;
}

/** What one dialling of a prompt produced: the answer, or null, plus its refusal trail. */
interface ServeResult {
  answer: ServedAnswer | null;
  failures: FailureRow[];
}

/**
 * Dial a prompt until one model serves it. The order is the rating order,
 * minus models this trial already refused (unless none remain). A 5xx is
 * retried once on the same model; a 429 goes straight to the next model; a
 * 401/403 gives up at once. At most MAX_ATTEMPTS_PER_PROMPT calls, inside
 * the client's 30 s. Returns null when no model served the prompt, with the
 * refusal trail the response header must report.
 */
async function serve(body: Json, requires: Requirement): Promise<ServeResult> {
  const ranked = rankedCandidates(brief, requires);
  const fresh = ranked.filter((m) => !refusedModels.has(m.id));
  const order = fresh.length > 0 ? fresh : ranked;
  const failures: FailureRow[] = [];
  const started = Date.now();
  let attempts = 0;
  let candidateIndex = 0;
  let retriedCurrent = false;
  while (attempts < MAX_ATTEMPTS_PER_PROMPT && candidateIndex < order.length) {
    if (Date.now() - started > PROMPT_DIAL_BUDGET_MS) break;
    const model = order[candidateIndex];
    const upstream = await dialOnce(model.id, withOutputCap(body));
    attempts += 1;
    if (upstream !== null && upstream.ok && upstream.body !== null) {
      return { answer: { model, response: upstream }, failures };
    }
    if (upstream === null) {
      // The call never reached the gateway: the model is not proven refused,
      // so do not cool it down, but do not spend another attempt on it now.
      candidateIndex += 1;
      retriedCurrent = false;
    } else {
      const status = upstream.status;
      const text = await upstream.text().catch(() => '');
      failures.push({ status, code: errorCodeOf(text), model: model.id });
      refusedModels.add(model.id);
      if (status === 401 || status === 403) break;
      if (status >= 500 && status < 600 && !retriedCurrent) {
        // One retry on the same model for a server error.
        retriedCurrent = true;
      } else {
        candidateIndex += 1;
        retriedCurrent = false;
      }
    }
    if (attempts < MAX_ATTEMPTS_PER_PROMPT && candidateIndex < order.length) {
      await sleep(RETRY_PAUSE_MS);
    }
  }
  return { answer: null, failures };
}

/** A prompt no model served, as a 502 in the client's wire, with its trail. */
function giveUp(
  res: ServerResponse,
  wire: 'openai' | 'anthropic',
  failures: FailureRow[],
): void {
  const last = failures[failures.length - 1];
  const detail = last === undefined ? '' : `: the gateway answered HTTP ${last.status}`;
  sendError(
    res,
    wire,
    502,
    wire === 'anthropic' ? 'api_error' : 'upstream_error',
    `no free model served this prompt${detail}`,
    failuresHeader(failures),
  );
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by a free model. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) {
    sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
    return;
  }
  const requires = requirementsFor(body);
  const { answer: served, failures } = await serve({ ...body, model: 'auto' }, requires);
  if (served === null) {
    giveUp(res, 'openai', failures);
    return;
  }
  const { model, response: upstream } = served;
  const headers = failuresHeader(failures);
  if (body.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...headers,
    });
    try {
      for await (const frame of openAIStreamWithModel(upstream.body as ReadableStream<Uint8Array>, model.id)) {
        res.write(frame);
      }
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIJsonWithModel(isRecord(answer) ? answer : {}, model.id), headers);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) {
    sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
    return;
  }
  const requires = requirementsFor(body);
  const { answer: served, failures } = await serve(anthropicToOpenAI(body, 'auto'), requires);
  if (served === null) {
    giveUp(res, 'anthropic', failures);
    return;
  }
  const { model, response: upstream } = served;
  const headers = failuresHeader(failures);
  if (body.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...headers,
    });
    try {
      for await (const event of anthropicEventsFromOpenAI(upstream.body as ReadableStream<Uint8Array>, model.id)) {
        res.write(event);
      }
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await upstream.json();
  sendJson(res, 200, openAIToAnthropic(isRecord(answer) ? answer : {}, model.id), headers);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(
    res,
    url.pathname === '/v1/messages' ? 'anthropic' : 'openai',
    404,
    'not_found',
    `no route ${req.method ?? ''} ${url.pathname}`,
  );
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
      }
      const reply: unknown = await res.json();
      if (isRecord(reply) && typeof reply.requests === 'number') {
        log(`registered: the trial holds ${reply.requests} prompts`);
      }
      return;
    } catch (err) {
      lastError = err;
      await sleep(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the
    // one built object and stop before any server starts. A process whose
    // stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) {
        sendError(
          res,
          req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai',
          500,
          'internal_error',
          'the server failed to answer',
        );
      }
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
