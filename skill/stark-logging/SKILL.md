---
name: stark-logging
description: >-
  Use when adding, changing, or reviewing application logging — instrumenting a
  service/CLI/connector, choosing log levels (DEBUG→FATAL), writing structured
  logs, or judging whether log lines in a diff are actually useful. Symptoms:
  fmt.Sprintf/printf into a message, everything at INFO, log-and-return, no
  correlation id, secrets in logs, per-item spam in loops, logs nobody can grep.
argument-hint: "[file-or-package to instrument or review]"
disable-model-invocation: truemodel: opus[1m]
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-logging — writing logs a reviewer calls good

## Overview

Most logs are `print` statements that survived to production. They interpolate
data into prose, fire at whatever level felt right, get emitted three times on
the way up the stack, and leak a token now and then. They are unreadable by a
human and unqueryable by a machine.

**Core principle: a log line is a structured *event*, not a sentence.** It is
data — a stable message plus typed fields — emitted **once**, at the level its
**audience and required action** dictate, at the **boundary where the outcome is
known**, with **no secrets**.

**Violating the letter of these rules is violating the spirit of logging:** a
log that reads fine to you but can't be grepped, aggregated, correlated, or
trusted is a failure even if it "has logs."

## The one test that catches most bad logs

Read a log line and ask: **can a machine group 10,000 of these, and can a human
who wasn't here understand what happened?**

- If the message contains a variable (`"synced user 42"`), the machine can't
  group them. → data belongs in a **field**, message stays **constant**.
- If you can't tell *what happened, to what, why, and what it cost* from the
  line alone, the human is lost. → add the missing **fields**, not more prose.

## Levels are about AUDIENCE and ACTION, not severity vibes

The single most common mistake is picking a level by how bad it *feels*. Pick it
by **who needs to read it** and **what they must do**.

| Level | Who reads it | Meaning | Action | Healthy volume |
|-------|--------------|---------|--------|----------------|
| TRACE | you, with a debugger | wire-level detail (payloads, loop iterations) | none; off everywhere but local | any |
| DEBUG | you, diagnosing later | internal steps: cache miss, page N fetched, chosen branch | none in normal ops; on in the local run folder, off on the console | high, fine |
| INFO | the operator | **the story of the run**: lifecycle + notable state changes (started, connected, N processed, done) | none — this is the happy path narrative | **low.** If the INFO stream doesn't read like a story, it's wrong |
| WARN | the operator, eventually | unexpected but **handled**: retried, fell back, degraded, skipped a bad record | glance when convenient; a *pattern* of WARN is the real signal | low |
| ERROR | on-call / triage | an operation or request **failed**, or an invariant broke | investigate the failure | ~zero in a healthy run |
| FATAL | on-call | the process **cannot continue**; log then exit non-zero | the program is down; immediate | at most once, ever |

**Levels label events; they are not your alerting system.** Paging comes from
SLOs and metrics (error *rate*, latency, saturation) — not from "an ERROR was
logged." A single failed request is legitimately ERROR without paging anyone.
Keep the two ideas separate.

Two heuristics that settle most disputes:

1. **ERROR vs WARN — "did the operation fail, or did we handle it?"** A retried
   timeout that then succeeded, a skipped malformed row, a `context.Canceled` on
   shutdown, an expected 404 the contract allows — all **handled** → WARN or
   INFO. ERROR is for a failure the code could not paper over.
2. **INFO bar — "can a new operator read only the INFO lines and know what the
   run did?"** No → INFO is too sparse (add lifecycle events) or too noisy
   (demote per-item chatter to DEBUG).

## The rules

1. **Constant message, data in fields.**
   `log.Error("connector sync failed", "connector", name, "error", err)` —
   never `log.Error(fmt.Sprintf("sync %s failed: %v", name, err))`.
   Constant messages aggregate and alert; interpolated ones are unique strings.

2. **Log a failure once — don't duplicate the same error chain.**
   Deep in the stack, **wrap and return** (`fmt.Errorf("fetch groups: %w", err)`);
   log the failure at the boundary that handles or swallows it. Logging *and*
   returning the same error prints it N times at N stack depths. (This forbids
   *duplicating one failure* — a retry, a fallback, or a swallowed-but-notable
   error each still deserve their own event, usually WARN or DEBUG.)

3. **Thread context; never retype it.**
   At the start of a unit of work, bind it once:
   `op := log.With("run_id", id, "connector", name, "operation", "sync")`.
   Every child line carries it automatically. Hand-copying `connector=` onto
   each call is how keys drift and lines go inconsistent.

4. **One name per concept.**
   `connector`, `resource_id`, `duration_ms`, `error`, `attempt`, `count`,
   `status` — pick each key **once** and reuse it everywhere. `userId` in one
   file and `user_id` in the next means you can't correlate across the codebase.
   Keep the key list in the repo's logging doc.

5. **Emit a canonical completion event; don't scatter breadcrumbs.**
   End each unit of work with **a single wide line** carrying the outcome and
   metrics — `log.Info("sync complete", "written", 98, "skipped", 2, "duration_ms", 8123, "status", "ok")` —
   instead of twenty thin INFO breadcrumbs (those are DEBUG). A long-running job
   may also emit a **start**, a **state-transition**, and periodic **progress/
   heartbeat** events — keep them few, wide, and sampled, never per-item.

6. **Level = audience + action** (the table above). Never ERROR an expected,
   handled condition; never bury a real failure at INFO.

7. **Never log secrets or PII — and don't trust redaction to save you.**
   The rule is upstream: never pass a token, credential, auth header, or full
   request/response body to the logger, and log a **stable id** (`user_id`), not
   an email or name. A handler-level denylist (token, secret, authorization,
   api_key, cookie, …) is a **backstop** — it blanks matching *keys*, but it
   cannot see a secret hidden in a message, an `error` string, a URL/DSN, or an
   opaque struct. Redaction is the last line of defense, not the first.

8. **Bound the volume — summarize and sample.**
   No unbounded per-item INFO in a loop over N records — log the **summary**
   (`"processed", n, "failed", f`); per-item detail is DEBUG. For hot paths pick
   a concrete pattern: **first-N-then-every-Kth**, **keyed sampling** (one line
   per distinct error kind per interval + a suppressed count), or a **per-interval
   rollup**. Never sample audit/security events; never drop the *first*
   occurrence. Guard expensive fields behind a level check
   (`if log.Enabled(ctx, LevelDebug) { … }`) so a disabled log costs nothing.

9. **Correlate.** `With` threads a `run_id` within a process; across services
   propagate a trace/span id and prefer the context-aware calls
   (`log.InfoContext(ctx, …)`) so a handler can pull ids/deadlines from
   `context.Context`. On GCP, emit `logging.googleapis.com/trace` to join logs to traces.

## Before → after

```go
// ❌ Four ways wrong: interpolated message, wrong level, no context,
//    logged here AND returned (so it logs again upstream), leaks the token.
func (c *Conn) Sync(u User) error {
    log.Printf("syncing user %s with token %s", u.Email, u.Token)
    if err := c.write(u); err != nil {
        log.Printf("ERROR: sync failed for %s: %v", u.Email, err)
        return err
    }
    return nil
}

// ✅ Constant messages + fields, context bound once, failure handled once,
//    a stable id (not PII/secret), and the operation ends as one canonical event.
func (c *Conn) Sync(ctx context.Context, u User) error {
    log := c.log.With("operation", "sync_user", "user_id", u.ID) // id, not email; no token
    log.Debug("writing user")                                    // per-user detail → DEBUG
    if err := c.write(ctx, u); err != nil {
        return fmt.Errorf("write user %s: %w", u.ID, err)         // wrap+return; caller logs
    }
    return nil
}
// The boundary logs each failure once (id, not PII) and emits ONE summary:
//   for _, u := range users {
//       if err := conn.Sync(ctx, u); err != nil {
//           log.Error("user sync failed", "user_id", u.ID, "error", err); failed++
//           continue
//       }
//       ok++
//   }
//   log.Info("run complete", "synced", ok, "failed", failed, "duration_ms", ms)
```

## Anti-pattern quick reference

| Smell in the diff | Why it's bad | Fix |
|-------------------|--------------|-----|
| `fmt.Sprintf`/`%s`/`+` inside the message | unique strings — can't aggregate/alert | constant message, values as fields |
| everything at `Info` (or all `Error`) | levels carry no signal; can't filter | pick by audience+action table |
| `log.Error(err); return err` | duplicate lines up the stack | wrap+return; log once at boundary |
| `log.Info` inside a big loop | floods the story; hides real events | summarize; per-item → DEBUG |
| `userId` here, `user_id` there | correlation breaks | one key name per concept |
| logging the token / full body / headers / email | secret & PII leak (redaction won't catch it in a string) | don't pass it; log a stable id, not bodies |
| ERROR on expected 404 / canceled ctx | noise on a handled condition | WARN or INFO by action |
| "failed" with no error, id, or count | not actionable | add `error`, subject id, outcome counts |
| bare `log.Error("error")` message | says nothing on its own | describe *what operation* failed |
| newline/user data in the message string | log injection — forges lines | data in fields; sanitize the message |

## Reviewing someone else's logs

When a diff adds or touches logging, apply `references/review-checklist.md`.
The short version — reject the line if **any** is true:

- message contains interpolated data
- level doesn't match audience+action
- the same error is logged here *and* returned
- no correlation id / operation context on an operation's lines
- a failure line lacks the error, the subject id, or the outcome
- a secret/PII value could reach a sink
- it fires per-item in an unbounded loop at INFO+

## Local CLI dual output (the DEBUG→FATAL run folder)

For a CLI that should leave a **local, greppable trail** — human *and* machine
readable — drop in `references/cli_logger.go`. It gives every run:

```
logs/<cmd>/<UTC-ts>-<run_id>/
  run.log     # human: aligned, colorized on a TTY, DEBUG+ (full detail)
  run.jsonl   # machine: one JSON object per line, DEBUG+, GCP severity
logs/<cmd>/latest -> <UTC-ts>-<run_id>   # atomically-updated symlink for `tail -f`
```

Console (stderr) shows INFO+ so the operator sees the story; the files keep
everything down to DEBUG. `run_id` correlates the two (and disambiguates
same-second runs). The console level is a live `*slog.LevelVar` (`Verbose` for
DEBUG; adjustable at runtime). TRACE and FATAL are wired in (slog has neither);
`CLILogger.Fatal()` logs, closes the files, then exits non-zero — call it only
from `main`. Redaction is a **backstop** that blanks denylisted keys (incl.
sensitive group names) and escapes control chars — it is not a guarantee; keep
secrets/PII out of messages, errors, and bodies (rule 7). Note: the run folder
grows unbounded — rotate/prune old runs (`logrotate`, or a cleanup on start).

```go
lg, err := obs.NewCLI("gws-sync", obs.Options{
    Service: "stark-admin", Type: "connector", Verbose: verboseFlag,
})
if err != nil { return err }
defer lg.Close()

lg.Info("run started", "connector", "gws")          // → console + both files
op := lg.With("operation", "sync_groups")           // bind context once
op.Debug("fetched page", "page", 1, "count", 100)    // → files only
op.Error("group write failed", "resource_id", "grp-42", "error", err)
lg.Info("run complete", "written", 98, "skipped", 2, "duration_ms", 8123)
```

It builds on `log/slog` with **zero third-party deps** and matches the GCP
Cloud Logging shape (`{timestamp, severity, message, ...fields}`) the rest of
`obs` already emits, so CLI runs and Cloud Run services parse identically. See
the file header for the drop-in path (`internal/obs/`).

## Language note

The rules are language-agnostic — they hold for `slog`, `zerolog`, `zap`,
`pino`, `structlog`, `tracing`. The reference implementation is Go/`slog`
because that is what this fleet uses (527 call sites in stark-admin). Port the
*shape*, not the syntax: one great example beats five mediocre ports.

## Red flags — stop and fix

- "I'll just Sprintf it into the message, it's readable" → constant message + fields.
- "I'll log it here so I don't forget, and return it too" → log once at the boundary.
- "ERROR feels right for this failed request" → would you want a page? If no, WARN.
- "I'll add the run id to each line by hand" → bind it once with `With`.
- "It's fine, the token only shows in debug" → redact at the handler; no exceptions.
- "One log per item so I can see progress" → summarize; per-item is DEBUG.
