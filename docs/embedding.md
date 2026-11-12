# Embedding the widget

## 1. Allow your site

In `agentdesk.config.yaml`:

```yaml
web:
  allowedOrigins: ["https://www.example.com"]
```

The browser calls agentdesk directly, so every origin that shows the chat must be listed.

## 2. Add the script

```html
<script src="https://chat.example.com/widget.js" async></script>
```

The widget reads its look (title, greeting, chips, colours, header links) from the server, so you change those in the config, not in your pages.

Options without code: set `window.agentdeskSettings = { ... }` before the script. With code: add `data-manual` to the tag and call `AgentDesk.init({ ... })` yourself.

## 3. Options

| Option | What it does |
|---|---|
| `identity` | Function returning the visitor's identity token, or `null` for a guest. Called before each request, so return a fresh one. |
| `onLogin` | Shows your login when the agent asks. Resolve `true` once the visitor is logged in; the chat then continues by itself. Without it there's no "Log in" button. |
| `onEvent(event, props)` | For analytics: `open`, `close`, `message_sent`, `chip_clicked` (`{ chip }`), `login_clicked`, `voice_started`, `voice_ended`, `voice_failed`. |
| `chips` | Replace the server's quick-start chips on this page, e.g. to add context: `{ id, label, text }`. |
| `greeting` | Replace the greeting on this page. |
| `theme` | CSS variables without `--ac-`, on top of the server's theme: `primary`, `primary-text`, `accent`, `accent-text`, `bg`, `surface`, `text`, `muted`, `border`, `radius`, `font`, `launcher-bottom` (lift the button above a sticky bar), `z`. |
| `container` | Element (or selector) to draw the chat in as a full page, e.g. on a /support page. The floating button is hidden there. |
| `hideLauncher` | Hide the floating button on this page. |
| `server` | The agentdesk URL, if not where `widget.js` came from. |

Calling `AgentDesk.init()` again changes options (e.g. chips after a route change in a single-page app).

Methods: `AgentDesk.open()`, `AgentDesk.close()`, `AgentDesk.reset()`.

**Call `AgentDesk.reset()` when a visitor signs out.** It starts a new conversation, so the next person on that browser can't read the previous account's chat.

## 4. Logged-in visitors

Your server signs a short-lived JWT with `IDENTITY_SECRET` (HS256). agentdesk verifies it on every request.

| Claim | Required | Used for |
|---|---|---|
| `sub` | yes | Your user id |
| `exp` | yes | Keep it short (minutes to an hour) |
| `name`, `phone`, `email` | no | Told to the agent ("logged in as Asha, phone +91…") |
| `note` | no | One more line for the agent about this visitor |
| `toolArgs` | no | Values for `mcp.hiddenArgs`, e.g. `{ "user_token": "..." }` your tools accept |

Node example (with [jose](https://github.com/panva/jose)):

```ts
import { SignJWT } from 'jose';

app.get('/api/chat-token', requireLogin, async (req, res) => {
  const token = await new SignJWT({
    name: req.user.name,
    phone: req.user.phone,
    toolArgs: { user_token: await mintToolToken(req.user.id) },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(req.user.id)
    .setExpirationTime('30m')
    .sign(new TextEncoder().encode(process.env.IDENTITY_SECRET));
  res.json({ token });
});
```

Any language with a JWT library works the same way.

A guest's hidden arguments are `""`, so tools that need a user must refuse an empty value (the demo's `my_orders` does).

## 5. Voice calls

- Needs `GEMINI_API_KEY` and a `voice:` section. The mic button appears only then.
- The page must be HTTPS (or localhost) for the microphone.
- The widget loads its audio processors from `blob:` URLs and opens a WebSocket to `generativelanguage.googleapis.com`. If your site has a Content Security Policy, allow `worker-src blob:` (or `script-src blob:`) and `connect-src wss://generativelanguage.googleapis.com https://chat.example.com`.
- Each call is capped at `voice.maxMinutes`, and `limits.voiceCallsPerDay` caps all visitors together: that's your voice budget.
- Gemini's tool calls reach agentdesk through the visitor's browser, so a visitor could send any of them with any arguments. Only the call's own tools are accepted; set `voice.tools` to give calls just the tools that are safe for that (hidden arguments are still filled by agentdesk, as in typed chat).
- The transcript is saved once, when the call ends. The agent reads its lines marked `[Voice call]` and is told they come from the browser, so it checks claims in them with its tools.
