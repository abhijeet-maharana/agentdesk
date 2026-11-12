# Inbox

Your team's view of every chat, website and WhatsApp: read them with each tool call, reply, pause the agent while you talk to the customer, star, search. One script, `inbox.js`, draws it, both on agentdesk's own page and inside your admin.

![The inbox: chats on the left, a conversation with tool calls and the agent's replies on the right](media/inbox.png)

## agentdesk's own page

Open `https://<your agentdesk>/inbox` and paste your `ADMIN_TOKEN`. It stays in that browser tab only.

## Inside your own admin

```html
<div id="inbox" style="height: 80vh"></div>
<script src="https://chat.example.com/inbox.js"></script>
<script>
  AgentDeskInbox.mount(document.getElementById('inbox'), {
    token: () => fetch('/api/agentdesk-staff-token').then((r) => r.json()).then((d) => d.token),
  });
</script>
```

Add your admin's origin to the config, so the browser may call agentdesk:

```yaml
inbox:
  allowedOrigins: ["https://admin.example.com"]
  quickReplies:
    - { label: "Ask for a review", text: "Glad we could help! Would you leave us a review? https://…" }
```

### The staff token

`ADMIN_TOKEN` must never reach a browser. Your server signs a short-lived token for whoever is logged in to your admin, with the same `IDENTITY_SECRET` as visitor identity tokens and the audience `agentdesk-inbox`:

```js
import { SignJWT } from 'jose';
const token = await new SignJWT({ name: user.name, role: 'agent' }) // or 'viewer': read only
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(user.id)
  .setAudience('agentdesk-inbox')
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(process.env.IDENTITY_SECRET));
```

A visitor's identity token is never accepted as a staff token, nor the other way round.

### Your own parts

| Option | What it does |
|---|---|
| `onSend(conversation, text)` | Sends team replies your way (e.g. a template when WhatsApp's 24-hour window is closed). Default: agentdesk sends it |
| `actions: [{ label, run(conversation) }]` | Buttons in the chat header, e.g. "Send catalog" |
| `panel(conversation, element)` | Your side panel for the open chat (customer details, tickets). Draw into `element` with anything you like; it lives in your page, so your CSS applies. Return a cleanup function if you need one |
| `theme: { bg, surface, border, text, muted, accent, link, radius, … }` | Colours and corners (`--ib-*` in [inbox.css](../widget/src/inbox/inbox.css)), e.g. to match a dark admin. `link` defaults to `accent`; set it lighter when `accent` is dark |
| `conversation: "whatsapp:9198…"` | Open this chat first |

## What the inbox shows

- **List:** newest first, unread count (the customer's messages since your team last opened the chat), star, and an "AI paused until …" tag. Search covers the number or id and every message. Filters: unread, AI paused, starred, channel.
- **Chat:** customer messages, the agent's replies (with cards), team replies, messages your app sent (`context`), photos and voice notes (through `/v1/admin/media/:id`), and how long WhatsApp's 24-hour window has left. Each run of tool calls is one line that opens to every input and raw result; hide them all with the tool button (remembered per browser).
- **AI status:** a bar under the chat header says whether the agent answers this chat. Only your team changes it: **Pause AI** (1 hour, 12 hours, 24 hours or 7 days) and **Resume AI**. Opening a chat never pauses it.
- **Actions:** reply, quick replies, star, your `actions`. Opening a chat marks it read.
- **Phones:** below 760 px wide (the inbox's own width) it shows the list or one chat, header actions move into a ⋮ menu, and your panel opens as a full-screen sheet from **Customer details**. Between 760 and 1100 px the panel is a drawer over the chat.

Polls every 10 s (list) and 5 s (open chat).
