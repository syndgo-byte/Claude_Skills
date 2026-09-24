---
name: token-router
description: Before starting a coding task with more than one step, pick the cheapest Claude model that can do it (Haiku, Sonnet, Opus, Fable) and hand the work to a subagent on that model when it differs from yours. Skip for quick questions answered from context already loaded.
---

# Token router

Bigger models cost more per token. Most work does not need the biggest one.
`scripts/route.js` picks the model with local rules; unclear cases go to a free external classifier
(no API key). The choice itself uses no Claude tokens.

## Why this saves tokens

The skill runs on top of whatever model the session already is. Opus costs roughly 2x Sonnet's usage
per token, so the session model is the biggest lever — pick it deliberately, don't rely on routing alone:

- **Run the session on Sonnet, not Opus.** Every turn of reading the conversation, calling tools, and
  reviewing results happens at the session model's rate. An Opus session pays Opus rates for that
  regardless of what gets delegated. A Sonnet session pays Sonnet rates for it, and only escalates to
  `opus` for the few tasks that need it.
- **Small work goes down to Haiku**, cheaper than Sonnet.
- **The routing decision itself is free**: local rules run instantly with no model call; the fallback
  classifier is a keyless external endpoint, not Claude.

```
Session (e.g. Sonnet)
   │  before starting a multi-step task
   ▼
route.js — local rules (instant, 0 tokens)
   │
   ├─ confident match ───────────────────────► route decided
   │
   └─ unclear ──► free classifier (keyless, ~1-6s, 0 Claude tokens)
                     │
                     ├─ answered ──► route decided
                     └─ no answer (queue/timeout) ──► sonnet (default)

route vs. session model
   │
   ├─ route == session model ──► do it here, no delegation
   ├─ route == haiku          ──► Agent tool, model:"haiku"   (down)
   ├─ route == opus           ──► Agent tool, model:"opus"    (up)
   └─ route == fable          ──► off by default (--fable on; uses extra credits)
                                        │
                                        ▼
                          verify diff/tests, fold back only a short summary
```

This beats defaulting everything to Opus: routine work runs at Sonnet or Haiku rates, and Opus is spent
only where the task actually needs its judgement. It is not free of overhead — a subagent starts with an
empty context, so delegating work smaller than the handoff itself can cost more than doing it inline (see
"When to use" below).

## When to use

- Before a task that will take several tool calls: searching, implementing, fixing, refactoring, designing.
- Not for a short answer, or when the work is smaller than the handoff. A subagent starts with an empty
  context, so delegating tiny work costs more than doing it.

## Steps

1. Run the router with a one-sentence summary of the task (any language):

   ```bash
   node "<this skill dir>/scripts/route.js" "<task summary>"
   ```

   It prints one line of JSON, for example `{"route":"haiku","by":"rules","why":"..."}`.
   `route` is `haiku`, `sonnet`, `opus`, `fable`, or `self` (routing turned off).

2. Compare `route` with the model you are running on:

   - Same model, or `self`: do the work yourself.
   - Different model: use the Agent tool with `model: "<route>"`. Give self-contained instructions (files,
     acceptance criteria). Ask for back only the changed files and a short summary.

   This works in both directions: a Sonnet session hands design work up to `opus`; an Opus session hands
   lookups down to `haiku`.

3. Check delegated work before reporting it done: read the diff or run the tests. Do not paste the
   subagent's full output into the reply.

4. You may override the route when you know better (for example the user named a model). Say so in one line.

## Other commands

- `node scripts/route.js --stats`: routing counts for the last 30 days and current settings.
- `--off` / `--on`: turn routing off or on.
- `--llm off` / `--llm on`: stop or allow sending unclear task summaries to the free classifier.
- `--fable on` / `--fable off`: allow routing to Fable. Off by default because Fable uses extra usage credits.
