# AI provider configuration

AlgoLocal talks to whichever model provider you configure. Nothing is bundled and nothing is called until you set a key, so the app works offline until you decide otherwise.

Four features use it: hints while you solve a problem, generated solutions with complexity trade-offs, generated problems, and the engineering review and chat in Engineering Practice.

## Where to configure it

In the desktop app, open Settings from the application menu or from the button on the loading screen. In the web version, go to `/settings` (for example http://localhost:3000/settings).

The desktop app writes what you enter to `~/.offline-leet-practice/config.json`. The web version keeps it in the browser's local storage.

## Providers

Each provider needs an API key and optionally a model id. If you leave the model blank, the default in brackets is used. You can type any model id the provider accepts; the dropdown only suggests common ones.

DeepSeek, key from [platform.deepseek.com](https://platform.deepseek.com/), default `deepseek-chat`:

```bash
DEEPSEEK_API_KEY=your_key
DEEPSEEK_MODEL=deepseek-chat     # optional
```

OpenAI, key from [platform.openai.com](https://platform.openai.com/), default `gpt-4.1`:

```bash
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-4.1             # optional
```

Qwen, key from the [DashScope console](https://dashscope.console.aliyun.com/), default `qwen-plus`. Requests go to DashScope's OpenAI-compatible endpoint:

```bash
QWEN_API_KEY=your_key
QWEN_MODEL=qwen-plus             # optional
```

Claude, key from the [Anthropic console](https://console.anthropic.com/), default `claude-sonnet-5`:

```bash
CLAUDE_API_KEY=your_key
CLAUDE_MODEL=claude-sonnet-5     # optional
```

Ollama runs locally and needs no key. Install it from [ollama.com](https://ollama.com/), pull a model with `ollama pull llama3.1`, and point the app at it. Default endpoint `http://localhost:11434`, default model `llama3.1`:

```bash
OLLAMA_ENDPOINT=http://localhost:11434   # optional
OLLAMA_MODEL=llama3.1                    # optional
```

Any OpenAI-compatible server, local or self-hosted. This is the one to pick for **LM Studio**: open its Developer/Server tab, start the server, and paste the address below. The same setting also covers vLLM, LocalAI, llama.cpp's `llama-server`, text-generation-webui and any gateway that speaks the OpenAI API.

```bash
OPENAI_COMPATIBLE_ENDPOINT=http://localhost:1234/v1   # LM Studio's default
OPENAI_COMPATIBLE_MODEL=qwen2.5-coder-7b-instruct     # required, ask the server what it has
OPENAI_COMPATIBLE_API_KEY=                            # optional, local servers rarely check it
```

Two things differ from the other providers:

- **The model id is required.** It is decided by whichever server you run, so there is no sensible default to fall back on. In Settings, fill in the address and press **Fetch models** — the app asks the endpoint's `/models` and fills the dropdown for you.
- **The address is a base URL, not a host.** If you give it just a host and port, `/v1` is appended (`http://localhost:1234` becomes `http://localhost:1234/v1`). If you write any path yourself it is left alone, because not every server mounts its API at `/v1`.

Note that LM Studio and LM Studio Bionic are two different apps. Bionic is an agent app and does not expose a server for other programs to call; it is LM Studio that provides the OpenAI-compatible endpoint above.

Reasoning models are handled for you: when the model id looks like an OpenAI reasoning model (`o1`, `o3`, `gpt-5` and so on), the request uses `max_completion_tokens` and drops the temperature, because those models reject the older parameters.

## Three ways to set it

The Settings page is the easiest and the only one that works in a packaged desktop build.

For local development, put the variables in `.env.local` at the project root. Git ignores that file.

System environment variables work too:

```powershell
# Windows PowerShell
$env:DEEPSEEK_API_KEY="your_key"
```

```cmd
:: Windows Command Prompt
set DEEPSEEK_API_KEY=your_key
```

```bash
# macOS and Linux
export DEEPSEEK_API_KEY="your_key"
```

`start-local.sh` and `start-local.bat` offer to write a `.env` for you on first run if none exists. Pass `--yes`, or set `START_LOCAL_NONINTERACTIVE=1`, to skip the questions in CI.

## Which provider gets used

If you pick a provider in Settings, that is the one the app calls. When its key is missing you get an error naming it, not a silent switch to another vendor: sending your code and prompts to a company you did not choose, billed to a key you thought was unused, is worse than a failed request.

Leave the selection on automatic and the first configured provider in this order is used: DeepSeek, OpenAI, Qwen, Claude, Ollama.

## Generating problems

Open the AI Generator, describe what you want, and the generated problem is added to your library. Requests can be in English or Chinese:

```
Generate a medium difficulty array manipulation problem using two pointers
我想做一道中等难度的动态规划题目，关于最优子结构
创建一个关于字符串处理的题目，使用 sliding window 算法
```

Each generated problem comes with starter templates for JavaScript, TypeScript and Python, a reference solution, and test cases including edge cases. Say what difficulty or algorithm you want and it goes into the prompt.

Engineering projects are generated the same way from `/projects/generator`, with one difference: a generated project is executed before it is accepted. Every stage runs against its own reference solution, the bare skeleton runs too, and anything that fails goes back to the model for one repair round. That execution happens in a Web Worker in your browser, never on the server.

## Keys and where they go

API calls are made from the server route, so keys are not exposed to the page. `.env.local` is in `.gitignore`. The desktop config file lives in your home directory, outside the app bundle, so upgrading the app does not touch it.

## When something breaks

If the app says no provider is configured, check that the variable name matches exactly, restart the dev server (Next reads `.env.local` at startup), and confirm the file is at the project root.

For Ollama, make sure the daemon is up with `ollama serve`, the model is present with `ollama list`, and the endpoint matches. A model you have not pulled yet fails the same way a wrong endpoint does.

If generation fails with a message about invalid JSON, the model returned something that could not be parsed. Rephrasing the request usually fixes it; a more specific request tends to produce a better-formed answer.

Rate limit and quota errors come from the provider, not the app. Check the key is active and the account has credit.

## The endpoint

```
POST /api/generate-problem
{ "request": "your problem description" }
```

The response is the generated problem, or an error message explaining what went wrong.
