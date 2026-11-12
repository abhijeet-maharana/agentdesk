# Contributing

agentdesk started as the support chat and WhatsApp agent of a small online shop and runs there in production. Issues and pull requests are welcome. Support is best-effort, with no promises on response times.

## Setup

```sh
npm ci
npm run typecheck && npm run lint && npm test
```

Node ≥ 22.13. The tests need no API keys: the model is scripted (`MockLanguageModelV4` from `ai/test`, see `test/helpers.ts`) and the MCP server is a stand-in. Set `TEST_DATABASE_URL` to any throwaway Postgres to also run the Postgres store tests.

To try a change by hand, run the demo shop and agentdesk side by side (README, "Quick start"). That needs an Anthropic key; `npm run screenshots` runs the same demo with a scripted model and no key.

## Where things live

| Folder | What |
|---|---|
| `src/web/` | The website channel: chat, voice calls, rate limits |
| `src/whatsapp/` | The WhatsApp channel: Meta webhook and sender, voice notes |
| `src/agent/` | The agent loop, MCP client, tools, prompt |
| `src/store/` | Chat storage (memory, and one Postgres table: `chat-table.ts`, [docs/storage.md](docs/storage.md)) |
| `src/voice/` | Gemini Live tokens |
| `widget/` | The browser widget, and the team inbox in `widget/src/inbox/` (Preact, drawn in shadow roots) |
| `examples/demo-tools/` | A pretend shop with an MCP server |

## Guidelines

- **No business-specific code.** agentdesk is used by more than one site. What one business needs belongs in its config, its MCP tools, or the claims of its identity token. If that's not enough, propose a general option.
- **One instance.** Running replies, voice calls and rate limits live in memory. A change that needs shared state should say so up front.
- **Secrets only from the environment**, everything else in `agentdesk.config.yaml`. A new option gets a commented line in `agentdesk.config.example.yaml`.
- **Keep the widget small.** It loads on every page of the sites that use it (about 50 KB now). New widget dependencies need a good reason.
- **Tests for behaviour changes.** Use the scripted model, never a real API call.
- **Docs in the same PR.** README or `docs/` when behaviour, config or the API changes. Run `npm run screenshots` when the widget looks different.
- **Style:** Biome formats and lints (`npm run format`). Comments explain why, not what.

## Security

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (Security tab), not in a public issue.
