// The brief: the free model list and the prompt manifest, read from
// $MAKEFUN_PROMPT_FILE, plus the catalog document the entry registers.
//
// The brief is prose with two JSON documents inside it. Each document carries
// a `schema` member under this competition's prefix; this file finds them by
// that member and by the arrays they hold, never by prose. A document may
// spell its lists under the sibling contest's names (`ratings` for models,
// `manifest` for prompts), so both spellings are accepted.
//
// Everything here is a pure function of the brief file: no clock, no random
// numbers. That is what makes `--list` and the register body the same
// document, byte for byte, on a live pass and on its replay.

import { readFileSync } from 'node:fs';

export const MODELS_SCHEMA = 'free-model-aggregator-02/models/v1';
export const PROMPTS_SCHEMA = 'free-model-aggregator-02/prompts/v1';

const SCHEMA_PREFIX = 'free-model-aggregator-02/';
export const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1';
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';

export type Json = Record<string, unknown>;

export function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One free model as the brief lists it. `id` is the id the gateway routes. */
export interface ModelRow {
  id: string;
  provider: string;
  display_name: string;
  /** The house's published rating in milli-points: the quality column's currency. */
  rating_milli: number;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  free: boolean;
}

/** What one prompt needs from the model that serves it. */
export interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

/** One prompt the client will send, in the order the brief lists them. */
export interface PromptRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  requires: Requirement;
}

export interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
  error: string | null;
}

export interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

export interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: 'openai';
  models: CatalogModel[];
}

/** What `--list` prints and what the register body carries: the same document. */
export interface CatalogReport {
  providers: CatalogProvider[];
}

export interface Capabilities {
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

/** Scan `text` for top-level JSON objects that carry a string `schema`. */
function schemaDocuments(text: string): Json[] {
  const found: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = closingBrace(text, start);
    if (end < 0) continue;
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(parsed) && typeof parsed.schema === 'string') found.push(parsed);
    } catch {
      // Not a JSON object on its own; keep scanning.
    }
  }
  return found;
}

/** Index of the `}` that closes the object opening at `start`, or -1. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** First document under this contest's prefix holding one of `keys` as an array. */
function documentWithArray(
  docs: readonly Json[],
  keys: readonly string[],
): { doc: Json; key: string } | null {
  for (const doc of docs) {
    if (!String(doc.schema ?? '').includes(SCHEMA_PREFIX)) continue;
    for (const key of keys) {
      if (Array.isArray(doc[key])) return { doc, key };
    }
  }
  return null;
}

/**
 * One model row. The id is the row's `id` (or `model`); a bare OpenRouter id
 * (`vendor/model:free`) under a provider named `openrouter` is spelled the
 * way the gateway routes it (`openrouter/vendor/model:free`). A row is free
 * unless it says `free: false`; a paid row is never routed.
 */
function modelRow(value: unknown): ModelRow | null {
  if (!isRecord(value)) return null;
  const raw = asString(value.id) !== '' ? asString(value.id) : asString(value.model);
  if (raw === '') return null;
  const provider = asString(value.provider) !== '' ? asString(value.provider) : asString(value.wire);
  const id =
    provider === 'openrouter' && !raw.toLowerCase().startsWith('openrouter/')
      ? `openrouter/${raw}`
      : raw;
  return {
    id,
    provider: provider === '' ? 'openrouter' : provider,
    display_name: asString(value.display_name) !== '' ? asString(value.display_name) : raw,
    rating_milli: asNumberOrNull(value.rating_milli) ?? 0,
    context_length: asNumberOrNull(value.context_length),
    tools: asBoolOrNull(value.tools),
    vision: asBoolOrNull(value.vision),
    json: asBoolOrNull(value.json),
    free: value.free !== false,
  };
}

function promptRow(value: unknown): PromptRow | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (id === '') return null;
  const req = isRecord(value.requires) ? value.requires : {};
  const requires: Requirement = {};
  if (req.tools === true) requires.tools = true;
  if (req.vision === true) requires.vision = true;
  if (req.json === true) requires.json = true;
  if (typeof req.min_context === 'number' && Number.isFinite(req.min_context)) {
    requires.min_context = req.min_context;
  }
  return {
    id,
    api: value.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: value.stream === true,
    weight: value.weight === 2 ? 2 : 1,
    requires,
  };
}

/** Read the brief at `path`: its model list and its prompt manifest. */
export function readBrief(path: string): Brief {
  if (path === '') {
    return { models: [], prompts: [], error: 'MAKEFUN_PROMPT_FILE is not set' };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { models: [], prompts: [], error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = schemaDocuments(text);
  const modelsDoc = documentWithArray(docs, ['models', 'ratings']);
  if (modelsDoc === null) {
    return { models: [], prompts: [], error: `the brief at ${path} holds no ${MODELS_SCHEMA} document` };
  }
  const models = (modelsDoc.doc[modelsDoc.key] as unknown[]).flatMap((v) => {
    const row = modelRow(v);
    return row === null ? [] : [row];
  });
  const promptsDoc = documentWithArray(docs, ['prompts', 'manifest']);
  if (promptsDoc === null) {
    return { models, prompts: [], error: `the brief at ${path} holds no ${PROMPTS_SCHEMA} document` };
  }
  const prompts = (promptsDoc.doc[promptsDoc.key] as unknown[]).flatMap((v) => {
    const row = promptRow(v);
    return row === null ? [] : [row];
  });
  return { models, prompts, error: null };
}

/** The models this entry may dial: the brief's free ones, in brief order. */
export function freeModels(brief: Brief): ModelRow[] {
  return brief.models.filter((m) => m.free);
}

export function capabilitiesOf(model: ModelRow): Capabilities {
  return {
    context_length: model.context_length,
    tools: model.tools,
    vision: model.vision,
    json: model.json,
  };
}

/** Whether a model's capabilities meet a prompt's requirements. Unknown never meets. */
export function meetsRequirements(requires: Requirement, caps: Capabilities): boolean {
  if (requires.tools === true && caps.tools !== true) return false;
  if (requires.vision === true && caps.vision !== true) return false;
  if (requires.json === true && caps.json !== true) return false;
  if (
    requires.min_context !== undefined &&
    (caps.context_length === null || caps.context_length < requires.min_context)
  ) {
    return false;
  }
  return true;
}

/**
 * The free models that can serve a prompt, best first: highest published
 * rating wins, ties broken by id so the order is the same on every pass.
 * Quality is 60% of the score and is the served model's rating over the best
 * rating at the prompt's requirements, so the head of this list is the whole
 * quality game; the tail is the failover order.
 */
export function rankedCandidates(brief: Brief, requires: Requirement): ModelRow[] {
  return freeModels(brief)
    .filter((m) => meetsRequirements(requires, capabilitiesOf(m)))
    .sort((a, b) => {
      if (b.rating_milli !== a.rating_milli) return b.rating_milli - a.rating_milli;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * The catalog the brief's free model list makes: one provider, the models it
 * serves, each once.
 *
 * base_url is the provider's public endpoint, never the gateway's trial-local
 * address: the gateway's origin differs between a live pass and its replay,
 * and the catalog is part of the state export a replay must reproduce byte
 * for byte.
 */
export function buildCatalog(brief: Brief): CatalogReport {
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const model of brief.models) {
    if (!model.free || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push({ id: model.id, free: true, context_length: model.context_length });
  }
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'openrouter',
        base_url: OPENROUTER_PUBLIC_BASE,
        key_env: OPENROUTER_KEY_ENV,
        wire: 'openai',
        models,
      },
    ],
  };
}
