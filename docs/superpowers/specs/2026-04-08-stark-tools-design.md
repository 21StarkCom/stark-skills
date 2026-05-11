# stark-tools Design Spec

## Overview

A Go CLI with Bubble Tea TUI for multi-provider image generation. Interactive terminal app with provider selection, prompt input, inline image preview, and generation history. Built as a monolith — providers are compiled-in Go packages.

## Decisions

| Decision | Choice |
|----------|--------|
| Language | Go |
| TUI framework | Bubble Tea + Lip Gloss (charmbracelet) |
| Providers | Multi-provider: OpenAI (GPT Image 1.5) + Vertex AI (Imagen 4 Ultra) |
| Scope | Images only at launch (video later) |
| Migration | imagegen skill moves from ~/.codex/skills/imagegen/ to this repo |
| Distribution | Clone + `go build`, Makefile |
| Image preview | Sixel/Kitty protocol for inline terminal rendering |

## Repository Structure

```
~/Code/Playground/stark-tools/
  cmd/stark-tools/
    main.go                 # Entry point, CLI arg parsing
  internal/
    tui/                    # Bubble Tea application
      app.go                # Root model, tab routing
      generate.go           # Generate tab (prompt input, config, submit)
      edit.go               # Edit tab (image input + prompt)
      history.go            # History tab (past generations)
      preview.go            # Inline image preview (sixel/kitty)
      styles.go             # Lip Gloss style definitions
      keys.go               # Key bindings
    provider/
      provider.go           # Provider interface + types
      registry.go           # Provider registry (discover + select)
      openai/
        openai.go           # GPT Image 1.5 implementation
      vertexai/
        vertexai.go         # Imagen 4 Ultra implementation
    prompt/
      augment.go            # Structured prompt augmentation (ported from image_gen.py)
      templates.go          # Use-case taxonomy + templates
    config/
      config.go             # YAML config loader
      defaults.go           # Default values
  config.example.yaml       # Example config
  Makefile
  go.mod / go.sum
  CLAUDE.md
  README.md
```

## Provider Interface

```go
type Model struct {
    ID          string
    Name        string
    Type        string // "image" or "video" (future)
    MaxSize     string
    Qualities   []string
    AspectRatios []string
}

type GenerateRequest struct {
    Model       string
    Prompt      string
    N           int
    Size        string
    Quality     string
    AspectRatio string
    Background  string
    OutputDir   string
    OutputFormat string
}

type GenerateResponse struct {
    Images []GeneratedImage
    Elapsed time.Duration
}

type GeneratedImage struct {
    Data     []byte
    Path     string
    MimeType string
}

type EditRequest struct {
    Model      string
    Prompt     string
    ImagePaths []string
    MaskPath   string
    N          int
    Size       string
    Quality    string
    OutputDir  string
}

type Provider interface {
    Name() string
    Models() []Model
    Generate(ctx context.Context, req GenerateRequest) (*GenerateResponse, error)
    Edit(ctx context.Context, req EditRequest) (*EditResponse, error)
}
```

## TUI Design

Bubble Tea app with tab-based navigation (matching the mockup Option C):

### Tabs
1. **Generate** — main tab
   - Provider pill selector (Imagen 4 Ultra | GPT Image 1.5)
   - Aspect ratio pills (16:9 | 1:1 | 9:16 | 4:3)
   - Quality pills (Low | Med | High | Auto)
   - Multi-line textarea for prompt input
   - Image preview area (sixel/kitty protocol)
   - Status bar (provider, project, region)

2. **Edit** — image editing
   - File picker for input image
   - Same provider/config selectors
   - Prompt for edit instructions
   - Preview of input + output

3. **History** — past generations
   - Table of recent generations (file, size, time, provider)
   - Preview selected entry
   - Re-run with same prompt

### Key Bindings
- `Tab` — next field
- `Shift+Tab` — previous field
- `Enter` — generate (from prompt textarea)
- `Ctrl+P` — cycle provider
- `Ctrl+S` — save prompt to file
- `1/2/3` — switch tabs
- `?` — help overlay
- `q` / `Ctrl+C` — quit

### Styles (Lip Gloss)
- Dark theme, inspired by the mockup: dark background (#0c0c14)
- Accent color per provider: coral/red for UI chrome (#fca5a5)
- Pill selectors with border highlight on active
- Subtle borders, clean typography

## Provider: OpenAI (GPT Image 1.5)

Port from existing `image_gen.py`:
- Uses `POST /v1/images/generations` and `/v1/images/edits`
- API key from config or `OPENAI_API_KEY` env var
- Supports: generate, edit, sizes (1024x1024, 1536x1024, 1024x1536, auto)
- Qualities: low, medium, high, auto
- Background: transparent, opaque, auto
- Response: base64 image data
- Go HTTP client, no SDK dependency

## Provider: Vertex AI (Imagen 4 Ultra)

- Uses Vertex AI REST API: `POST https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:predict`
- Auth: Application Default Credentials (gcloud auth) or service account JSON
- Model: `imagen-4.0-ultra-generate-001`
- Config from YAML: project ID, region, model override
- Supports: aspect ratios (1:1, 16:9, 9:16, 4:3, 3:4), safety filter level
- Response: base64 image data

## Image Preview

Terminal inline image rendering:
1. Detect terminal capabilities (TERM_PROGRAM, sixel query, kitty query)
2. Sixel: convert PNG to sixel escape sequence (use go-sixel or similar)
3. Kitty: use kitty graphics protocol (base64 chunks)
4. Fallback: ASCII art placeholder or just file path

## Prompt Augmentation

Port the structured prompt augmentation from `image_gen.py`:
- Use-case taxonomy (photorealistic-natural, product-mockup, ui-mockup, etc.)
- Template fields: use_case, scene, subject, style, composition, lighting, palette, materials, text, constraints, negative
- Auto-augment by default, `--no-augment` flag to disable
- Same augmentation rules: only make implicit details explicit, don't invent

## Config (YAML)

```yaml
# ~/.config/stark-tools/config.yaml
default_provider: vertexai

providers:
  openai:
    api_key: ${OPENAI_API_KEY}  # env var reference
    default_model: gpt-image-1.5
    default_size: 1024x1024
    default_quality: auto

  vertexai:
    project: infra-ai-platform
    region: us-central1
    default_model: imagen-4.0-ultra-generate-001
    default_aspect_ratio: "16:9"
    safety_filter_level: BLOCK_ONLY_HIGH

output:
  dir: ./output
  format: png
  naming: "{provider}-{timestamp}"

preview:
  enabled: true
  protocol: auto  # auto, sixel, kitty, none
```

## Build

```makefile
BINARY=stark-tools
VERSION=$(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")

build:
	go build -ldflags "-X main.version=$(VERSION)" -o $(BINARY) ./cmd/stark-tools

install: build
	cp $(BINARY) ~/bin/

clean:
	rm -f $(BINARY)
```

## Migration Plan

1. Create `~/Code/Playground/stark-tools` repo
2. Build the Go TUI with both providers
3. Port prompt augmentation logic from `image_gen.py`
4. Port reference docs (prompting.md, sample-prompts.md) as embedded resources or docs/
5. Remove `~/.codex/skills/imagegen/` after stark-tools is working
6. Update stark-skills install.sh if needed

## Non-Goals (for v1)

- Video generation (Veo, Sora) — future
- Batch generation from JSONL — future (TUI is interactive-first)
- Plugin system for providers — not needed with 2 providers
- Homebrew/binary distribution — clone + build is fine
