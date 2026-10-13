# ALFRED

**A**ltijd **L**uisterend, **F**ikst **R**otzooi, **E**n **D**oet 't.

ALFRED is a free, local-first personal digital assistant for Windows. Its core design
prioritises local processing, explicit permissions, reliable tools, and maintainable
architecture over unrestricted computer control.

## Current status

**Milestone 5.1 — personality-system refinements are implemented.** This repository
provides a strict TypeScript workspace, validated local configuration, shared logging, Ollama
status/model discovery, streamed text conversations, and a minimal Electron + React desktop shell.

ALFRED can now hold a **local, session-only text conversation** through Ollama. Responses stream
into the development window as the model generates them. It cannot execute tools, store persistent
memory, use voice, or control the computer.

## Tool architecture

ALFRED uses an explicit registry, policy, and centralized executor for structured LLM tool calls.
Only registered, enabled, safe-classified tools are advertised to Ollama and may run. Confirm and
restricted tools are denied until a future approval system exists. Inputs are Zod-validated before
handlers receive them; cancellation and a bounded timeout are applied cooperatively.

The current demonstration tools are `get_current_time` and `calculate` (add, subtract, multiply,
divide). They use no external services and do not provide computer control, file access, memory,
voice, web access, shell commands, or autonomous multi-step execution. The registry and policy are
also designed for future deterministic shortcuts and dashboard inspection without exposing handlers
to browser code.

## Basic Windows tools

ALFRED can safely retrieve basic non-personal system information, a memory-usage snapshot, and the
allowlisted supported Windows applications. `get_system_info` reports OS/version, architecture, CPU,
logical CPU count, memory bytes, and uptime. `get_system_usage` reports memory bytes/percentage and
ALFRED-process RSS bytes. `list_supported_applications` lists available Notepad, Calculator, and
File Explorer entries without scanning the registry or filesystem broadly.

`open_application` is registered only as a confirmation-required tool. It is not executable or
advertised until Step 8 provides a confirmation workflow; ALFRED therefore cannot currently launch
an application. Its handler accepts only stable allowlisted identifiers and never model-provided
paths or shell commands.

## Personality

ALFRED's system prompt is built deterministically from identity, personality, communication,
current capabilities, planned capabilities, and behavioral-constraint sections. Its default style
is calm, direct, helpful, technically competent, natural, and slightly witty when appropriate.

Use `ALFRED_PERSONALITY_FILE` in `.env.local` for an optional, Zod-validated JSON file containing
only `name`, `identity`, `traits`, and `communicationStyle` overrides. For example:

```json
{
  "name": "ALFRED",
  "traits": ["Be calm and precise."],
  "communicationStyle": ["Prefer short paragraphs."]
}
```

`ALFRED_RESPONSE_LENGTH` accepts `concise`, `balanced` (the default), or `detailed`.
`ALFRED_EXTRA_INSTRUCTIONS` appends bounded local guidance after the generated core prompt.
Neither setting can change ALFRED's application-owned current capabilities, planned capabilities,
or behavioral constraints. The retired `ALFRED_PERSONALITY_INSTRUCTIONS` and
`ALFRED_SYSTEM_PROMPT` settings are rejected so they cannot silently change behavior.

The planned-capabilities section is explicit: ALFRED currently has no computer control, file
access, persistent memory, voice, web access, external services, or multi-step task execution.

## Technology stack

- TypeScript and Node.js
- Electron + React
- Zod configuration validation
- Pino structured logging
- Ollama local-runtime health checks and model discovery
- Session-only streamed local conversations
- Configurable, structured ALFRED personality and system prompts
- Vitest tests
- ESLint and Prettier

SQLite, Whisper.cpp, and Piper are planned for later milestones and are not configured yet.

## Ollama

Ollama is ALFRED's local AI runtime. Install it separately from [ollama.com](https://ollama.com/),
then start the local service with:

```powershell
ollama serve
```

Check installed models with:

```powershell
ollama list
```

ALFRED's configured preferred model is `qwen3:8b`, with `qwen3:4b` as a fallback preference.
To install the preferred model yourself, run:

```powershell
ollama pull qwen3:8b
```

ALFRED never downloads a model, silently selects a fallback, or prevents the desktop app from
starting when Ollama is unavailable. The local defaults are `http://localhost:11434`, a 5-second
connection timeout for health checks, and a 60-second response-start timeout for generation.
Override either timeout in an ignored `.env.local` file when needed.

## Install dependencies

```powershell
npm install
```

Copy `.env.example` to `.env.local` only when you need local configuration overrides.
Do not commit `.env.local` or place secrets in it.

## Commands

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:ollama
npm run dev
```

`npm run dev` starts the minimal desktop foundation window. It is not an assistant yet.
Enter a message and press Enter or **Send** to test the local conversation pipeline. **Stop** cancels
the current generation. The configured model is selected with `ALFRED_OLLAMA_MODEL` in `.env.local`;
ALFRED does not select or download a fallback model automatically.
`npm run test:ollama` is an optional real-runtime integration test and requires Ollama to be
running; the normal test suite never requires a local model runtime.

## Workspace layout

- `apps/desktop` — Electron main process, preload bridge, and React renderer.
- `packages/core` — shared configuration and logging.
- `packages/providers` — future LLM provider contracts.
- `packages/tools` — future tool contracts.
- `packages/voice` — future voice contracts.
- `tests` — cross-package foundation tests.
- `data` — ignored local runtime data reserved for later use.
