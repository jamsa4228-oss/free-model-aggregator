# free-model-aggregator-02 — entry

One server that aggregates the 14 free OpenRouter models into a single
endpoint, speaking both the OpenAI wire (`POST /v1/chat/completions`) and
the Anthropic wire (`POST /v1/messages`), JSON and streaming.

## Run

```sh
node main.ts            # serves, registers with the env, polls /work, exits 0 on done
node main.ts --list     # prints the catalog JSON, byte-for-byte as registered
```

Environment (set by the grader's sandbox):

- `MAKEFUN_ENV_URL` — the trial env
- `MAKEFUN_PROMPT_FILE` — the brief (free models, ratings, prompt manifest)
- `OPENAI_BASE_URL` — the grader's gateway (OpenAI-compatible)
- `OPENAI_API_KEY` — the trial's dummy key; the gateway swaps it for the
  entrant's own OpenRouter key

## How it answers

- **Routing:** for each prompt, the free models that meet its requirements
  (tools / vision / JSON) in rating order, best first — the head of the list
  is the best-rated model at the prompt's requirements.
- **Failover:** a 5xx is retried once on the same model, then the next
  qualifying model is tried; a 429 goes straight to failover; a 401/403
  gives up at once. Models refused in this trial are cooled down for later
  prompts. Recovered refusals are reported on the response in the
  `x-makefun-upstream-failures` header.
- **Model field:** every answer and every streamed chunk names the model
  actually dialled (`openrouter/<id>`), because the gateway's own answer
  drops the prefix.
- **Determinism:** no clock or randomness in anything sent; choices follow
  the brief and the trial seed only.

## Files

- `main.ts` — the server: routes, dialling, failover, register, poll.
- `lib/providers.ts` — the brief parser, catalog builder, candidate ranking.
- `lib/wire.ts` — OpenAI/Anthropic translation and SSE relay.
