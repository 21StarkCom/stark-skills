// Package obs — CLI dual-output logger reference implementation.
//
// This is a COMPLETE, ZERO-DEPENDENCY reference you can drop into a Go
// service's `internal/obs` package. It gives a CLI process:
//
//   - a local run folder:            logs/<cmd>/<UTC-timestamp>/ (+ a `latest` symlink)
//   - a HUMAN-readable sink:         run.log   (aligned, colorized on a TTY)
//   - a MACHINE-readable sink:       run.jsonl (one JSON object per line, GCP-severity)
//   - console output on stderr       (INFO+ by default, DEBUG with -v)
//   - the full level range           TRACE, DEBUG, INFO, WARN, ERROR, FATAL
//   - run correlation                every line carries the same run_id
//   - structural secret redaction    denylisted keys never reach any sink
//
// It builds on log/slog (the standard library) — no third-party logging deps.
// The JSON sink mirrors the GCP Cloud Logging shape used elsewhere in obs
// ({timestamp, severity, message, ...fields}) so CLI runs and Cloud Run
// services parse the same way.
package obs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

// slog's built-ins: Debug=-4, Info=0, Warn=4, Error=8. We add the two ends
// operators actually ask for: TRACE (below DEBUG) and FATAL (above ERROR).
const (
	LevelTrace = slog.Level(-8)
	LevelDebug = slog.LevelDebug
	LevelInfo  = slog.LevelInfo
	LevelWarn  = slog.LevelWarn
	LevelError = slog.LevelError
	LevelFatal = slog.Level(12)
)

// levelString names a level for output. slog prints custom levels as
// "ERROR+4" unless you name them here.
func levelString(l slog.Level) string {
	switch {
	case l <= LevelTrace:
		return "TRACE"
	case l < LevelInfo:
		return "DEBUG"
	case l < LevelWarn:
		return "INFO"
	case l < LevelError:
		return "WARN"
	case l < LevelFatal:
		return "ERROR"
	default:
		return "FATAL"
	}
}

// gcpSeverity maps our levels to the values GCP Cloud Logging reads. `level`
// alone does not populate GCP severity — the top-level `severity` attr does.
func gcpSeverity(l slog.Level) string {
	switch {
	case l <= LevelTrace:
		return "DEBUG"
	case l < LevelInfo:
		return "DEBUG"
	case l < LevelWarn:
		return "INFO"
	case l < LevelError:
		return "WARNING"
	case l < LevelFatal:
		return "ERROR"
	default:
		return "CRITICAL"
	}
}

// ---------------------------------------------------------------------------
// Redaction — structural, not per-call discipline
// ---------------------------------------------------------------------------

// redactKeys are substrings that, if present in a key (case-insensitive),
// blank the value at the HANDLER. Redaction lives here so no caller can forget
// it: it applies to every sink, every call site, forever.
var redactKeys = []string{
	"token", "secret", "password", "passwd", "authorization",
	"api_key", "apikey", "cookie", "credential", "private_key", "access_key",
}

const redacted = "«redacted»"

func redactAttr(_ []string, a slog.Attr) slog.Attr {
	k := strings.ToLower(a.Key)
	for _, deny := range redactKeys {
		if strings.Contains(k, deny) {
			return slog.String(a.Key, redacted)
		}
	}
	return a
}

// ---------------------------------------------------------------------------
// Fanout — one logger, many sinks, each with its own min level
// ---------------------------------------------------------------------------

type fanout struct{ handlers []slog.Handler }

func (f fanout) Enabled(ctx context.Context, l slog.Level) bool {
	for _, h := range f.handlers {
		if h.Enabled(ctx, l) {
			return true
		}
	}
	return false
}

func (f fanout) Handle(ctx context.Context, r slog.Record) error {
	var firstErr error
	for _, h := range f.handlers {
		if !h.Enabled(ctx, r.Level) {
			continue
		}
		if err := h.Handle(ctx, r.Clone()); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (f fanout) WithAttrs(as []slog.Attr) slog.Handler {
	hs := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		hs[i] = h.WithAttrs(as)
	}
	return fanout{hs}
}

func (f fanout) WithGroup(name string) slog.Handler {
	hs := make([]slog.Handler, len(f.handlers))
	for i, h := range f.handlers {
		hs[i] = h.WithGroup(name)
	}
	return fanout{hs}
}

// ---------------------------------------------------------------------------
// Console handler — the human-readable sink
//   15:04:05.000 INFO  message here            key=value key="two words"
// ---------------------------------------------------------------------------

type consoleHandler struct {
	mu    *sync.Mutex
	w     io.Writer
	level slog.Leveler
	color bool
	attrs []slog.Attr // accumulated via WithAttrs
	group string      // dotted prefix from WithGroup
}

func newConsoleHandler(w io.Writer, level slog.Leveler, color bool) *consoleHandler {
	return &consoleHandler{mu: &sync.Mutex{}, w: w, level: level, color: color}
}

var levelColor = map[string]string{
	"TRACE": "\033[90m", "DEBUG": "\033[36m", "INFO": "\033[32m",
	"WARN": "\033[33m", "ERROR": "\033[31m", "FATAL": "\033[1;35m",
}

const colorReset = "\033[0m"

func (h *consoleHandler) Enabled(_ context.Context, l slog.Level) bool {
	return l >= h.level.Level()
}

func (h *consoleHandler) Handle(_ context.Context, r slog.Record) error {
	var b strings.Builder
	b.WriteString(r.Time.Format("15:04:05.000"))
	b.WriteByte(' ')

	lvl := levelString(r.Level)
	if h.color {
		b.WriteString(levelColor[lvl])
	}
	fmt.Fprintf(&b, "%-5s", lvl)
	if h.color {
		b.WriteString(colorReset)
	}
	b.WriteByte(' ')
	b.WriteString(r.Message)

	// Redacted, group-prefixed key=value pairs, sorted for stable diffs.
	kv := map[string]string{}
	for _, a := range h.attrs {
		appendAttr(kv, h.group, a)
	}
	r.Attrs(func(a slog.Attr) bool { appendAttr(kv, h.group, a); return true })
	keys := make([]string, 0, len(kv))
	for k := range kv {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(&b, "  %s=%s", k, kv[k])
	}
	b.WriteByte('\n')

	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := io.WriteString(h.w, b.String())
	return err
}

func appendAttr(dst map[string]string, group string, a slog.Attr) {
	a.Value = a.Value.Resolve()
	a = redactAttr(nil, a)
	if a.Equal(slog.Attr{}) {
		return
	}
	key := a.Key
	if group != "" {
		key = group + "." + key
	}
	if a.Value.Kind() == slog.KindGroup {
		for _, ga := range a.Value.Group() {
			appendAttr(dst, key, ga)
		}
		return
	}
	dst[key] = quoteIfNeeded(a.Value.String())
}

func quoteIfNeeded(s string) string {
	if s == "" || strings.ContainsAny(s, " \t\"") {
		return fmt.Sprintf("%q", s)
	}
	return s
}

func (h *consoleHandler) WithAttrs(as []slog.Attr) slog.Handler {
	nc := *h
	nc.attrs = append(append([]slog.Attr{}, h.attrs...), as...)
	return &nc
}

func (h *consoleHandler) WithGroup(name string) slog.Handler {
	nc := *h
	if h.group != "" {
		nc.group = h.group + "." + name
	} else {
		nc.group = name
	}
	return &nc
}

// ---------------------------------------------------------------------------
// JSON severity wrapper — the machine-readable sink's GCP tag
// ---------------------------------------------------------------------------

type severityHandler struct{ inner slog.Handler }

func (h severityHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return h.inner.Enabled(ctx, l)
}
func (h severityHandler) Handle(ctx context.Context, r slog.Record) error {
	r.AddAttrs(slog.String("severity", gcpSeverity(r.Level)))
	return h.inner.Handle(ctx, r)
}
func (h severityHandler) WithAttrs(as []slog.Attr) slog.Handler {
	return severityHandler{h.inner.WithAttrs(as)}
}
func (h severityHandler) WithGroup(name string) slog.Handler {
	return severityHandler{h.inner.WithGroup(name)}
}

// ---------------------------------------------------------------------------
// Logger — slog wrapper adding Trace + Fatal
// ---------------------------------------------------------------------------

// Logger wraps *slog.Logger. Use the standard Debug/Info/Warn/Error plus the
// two extras below. All take alternating key/value pairs — never fmt.Sprintf
// into the message.
type Logger struct{ *slog.Logger }

func (l *Logger) Trace(msg string, kv ...any) {
	l.Logger.Log(context.Background(), LevelTrace, msg, kv...)
}

// Fatal logs at FATAL then exits non-zero. Sinks write synchronously (no
// buffering), so the record is durable before the process dies.
func (l *Logger) Fatal(msg string, kv ...any) {
	l.Logger.Log(context.Background(), LevelFatal, msg, kv...)
	os.Exit(1)
}

// With returns a child logger carrying kv on every subsequent line. Call it
// once at the start of an operation — do not retype the same context per line.
func (l *Logger) With(kv ...any) *Logger { return &Logger{l.Logger.With(kv...)} }

// ---------------------------------------------------------------------------
// CLI bootstrap
// ---------------------------------------------------------------------------

// CLILogger is a Logger plus the run folder and its open files. Call Close()
// (defer it in main) to flush and release the files.
type CLILogger struct {
	*Logger
	Dir     string
	RunID   string
	closers []io.Closer
}

// Options configure NewCLI.
type Options struct {
	// Root is the base folder for run directories (default "logs").
	Root string
	// Verbose lowers the console (stderr) threshold from INFO to DEBUG.
	Verbose bool
	// Service and Type are baked onto every line (GCP parity).
	Service string
	Type    string
}

// NewCLI creates logs/<cmd>/<UTC-ts>/{run.log,run.jsonl}, wires a fanout over
// three sinks (stderr console, run.log human, run.jsonl machine), and returns
// a Logger whose every line carries a fresh run_id. Defer Close().
//
//	lg, err := obs.NewCLI("gws-sync", obs.Options{Service: "stark-admin", Type: "connector"})
//	if err != nil { panic(err) }
//	defer lg.Close()
//	lg.Info("run started", "connector", "gws")
func NewCLI(cmd string, opt Options) (*CLILogger, error) {
	if opt.Root == "" {
		opt.Root = "logs"
	}
	ts := time.Now().UTC().Format("20060102T150405Z")
	dir := filepath.Join(opt.Root, cmd, ts)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create log dir %s: %w", dir, err)
	}

	humanFile, err := os.Create(filepath.Join(dir, "run.log"))
	if err != nil {
		return nil, fmt.Errorf("create run.log: %w", err)
	}
	jsonFile, err := os.Create(filepath.Join(dir, "run.jsonl"))
	if err != nil {
		humanFile.Close()
		return nil, fmt.Errorf("create run.jsonl: %w", err)
	}

	// Best-effort `latest` symlink for `tail -f logs/<cmd>/latest/run.log`.
	latest := filepath.Join(opt.Root, cmd, "latest")
	_ = os.Remove(latest)
	_ = os.Symlink(ts, latest)

	consoleLevel := slog.Level(LevelInfo)
	if opt.Verbose {
		consoleLevel = LevelDebug
	}

	jsonHandler := severityHandler{slog.NewJSONHandler(jsonFile, &slog.HandlerOptions{
		Level:       LevelTrace, // capture everything to the machine sink
		ReplaceAttr: jsonReplace,
	})}

	h := fanout{handlers: []slog.Handler{
		newConsoleHandler(os.Stderr, consoleLevel, isTTY(os.Stderr)),
		newConsoleHandler(humanFile, LevelTrace, false), // full detail, no color, to file
		jsonHandler,
	}}

	base := slog.New(h)
	if opt.Service != "" {
		base = base.With("service", opt.Service)
	}
	if opt.Type != "" {
		base = base.With("type", opt.Type)
	}
	runID := newRunID()
	base = base.With("run_id", runID, "command", cmd)

	return &CLILogger{
		Logger:  &Logger{base},
		Dir:     dir,
		RunID:   runID,
		closers: []io.Closer{humanFile, jsonFile},
	}, nil
}

// jsonReplace renames slog's defaults to the GCP/obs shape and redacts.
func jsonReplace(groups []string, a slog.Attr) slog.Attr {
	switch a.Key {
	case slog.TimeKey:
		a.Key = "timestamp"
	case slog.MessageKey:
		a.Key = "message"
	case slog.LevelKey:
		a.Value = slog.StringValue(strings.ToLower(levelString(a.Value.Any().(slog.Level))))
	}
	return redactAttr(groups, a)
}

// Close flushes and releases the run files.
func (c *CLILogger) Close() error {
	var firstErr error
	for _, cl := range c.closers {
		if err := cl.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func newRunID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "unknown"
	}
	return hex.EncodeToString(b)
}

func isTTY(f *os.File) bool {
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}
