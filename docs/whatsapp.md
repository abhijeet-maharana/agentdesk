# WhatsApp

The same agent, prompt and tools as the website chat, on your WhatsApp Business number through Meta's Cloud API.

## What it does

- Answers every customer message: text, photos (the agent sees the newest ones), voice notes (transcribed), button and list replies, locations, contacts and catalog orders.
- Shows "typing…" and marks the message read while it works. A newer message cancels the running reply; the newer run answers both.
- Splits a reply into separate messages on `---` lines.
- Sends tool cards as a catalog message (`whatsapp.catalog`), or as photos with a caption and link.
- Replies with a voice note to a voice note (or when asked), when `whatsapp.audio.speechModel` is set.
- Your team reads the chats and replies through the admin API, as for the website, and can pause the agent in one chat while they talk to the customer (`POST /v1/admin/conversations/:key/pause`).

## Set up

1. In Meta's App Dashboard, add the WhatsApp product, note the phone number id, and create a permanent (system user) token.
2. Config: a `whatsapp:` section with at least `phoneNumberId` (every option is in `agentdesk.config.example.yaml`).
3. Secrets: `WHATSAPP_TOKEN`, plus for Meta's webhook `WHATSAPP_APP_SECRET` (App settings → Basic) and `WHATSAPP_VERIFY_TOKEN` (any string). Without `WHATSAPP_TOKEN` the channel stays off (an error in the log) and the website chat runs as usual.
4. In WhatsApp → Configuration, set the callback URL to `https://<your agentdesk>/v1/whatsapp/webhook` with the same verify token, and subscribe to `messages`.

agentdesk checks Meta's `X-Hub-Signature-256` on every webhook and skips a message Meta sends twice.

### Keeping your own webhook

If your app already receives the number's webhooks (other features read them), keep it. Check Meta's signature there, then pass on the body, or only the messages agentdesk should answer:

```
POST /v1/admin/whatsapp/webhook
Authorization: Bearer $ADMIN_TOKEN
<the webhook JSON>
```

This is also how you roll out to a few test numbers first.

## Who the customer is

On WhatsApp the number is the login. Set `whatsapp.identityUrl` and agentdesk asks your app about each number:

```
POST <identityUrl>
Authorization: Bearer $ADMIN_TOKEN
{ "phone": "919876543210" }
→ { "token": "<identity token>" }
```

The token is the same HS256 identity token as for logged-in website visitors (signed with `IDENTITY_SECRET`); its `toolArgs` reach your tools as hidden arguments. Cached for 10 minutes per number. Without `identityUrl`, tools still get the built-in hidden argument `phone` (digits only), plus `channel` = `whatsapp`.

## Messages your app sends

Notifications, login codes and other messages your app sends the customer itself are worth telling the agent about, so it can answer "what was that message?". Post each one:

```
POST /v1/admin/conversations/whatsapp:<digits>/context
Authorization: Bearer $ADMIN_TOKEN
{ "text": "Your order ORD-1 has shipped.", "ref": "<your id, optional>" }
```

Nothing is sent; the agent reads it as a message from the business.

## Moving an existing number

When agentdesk takes over a number your app answered before, copy the conversation in first, so the agent knows it:

```
POST /v1/admin/conversations/whatsapp:<digits>/import
{ "messages": [{ "role": "user", "text": "hi", "createdAt": "2026-11-10T10:00:00Z" }, …] }
```

Oldest first, `user` or `assistant`, up to 200. It only goes into an empty conversation (409 otherwise), so calling it on every first contact is safe.

## Writing first

To have the agent message a customer without a new message from them (a follow-up after a purchase, say):

```
POST /v1/admin/conversations/whatsapp:<digits>/nudge
{ "note": "30 minutes have passed since they activated their sticker" }
```

The note tells the agent why; it is neither sent nor stored. The call returns at once (202) and the agent replies in the background. Meta only allows it within 24 hours of the customer's last message.

## Voice notes

`whatsapp.audio` takes any OpenAI-compatible API:

| Option | Meaning |
|---|---|
| `transcriptionApi: transcriptions` | `POST /audio/transcriptions` (OpenAI, Groq, …) |
| `transcriptionApi: chat` | The audio goes to a chat model that takes audio input (e.g. Gemini through a gateway) |
| `speechModel`, `speechVoice`, `speechFormat` | Voice replies. Converted to OGG Opus with ffmpeg (in the Docker image) unless the API returns `opus` |
| `voiceRequestPattern`, `textRequestPattern` | Regexes for "reply by voice" / "don't" in the customer's words |

Only the first message of a reply is spoken; it is also sent as text when it contains a link (`alsoAsTextPattern`).

## Limits and gotchas

- `limits.repliesPerWhatsAppNumber`: messages over it are stored but not answered.
- Meta only allows free-form messages within 24 hours of the customer's last message. The agent only answers customers, so it is always inside; a team reply to an old chat fails with Meta's error.
- Like the rest of agentdesk, run one instance: running replies and the duplicate check live in memory.
