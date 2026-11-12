# Storage

With `DATABASE_URL` set, agentdesk keeps every chat in **one Postgres table**, one row per message. Without it, chats live in memory and are lost on restart.

```yaml
storage:
  table: agentdesk_chats   # the default; any name, optionally schema.table
```

If the table doesn't exist, agentdesk creates it. If it exists, agentdesk uses it as it is and never changes it, so **your app and agentdesk can share one table**: your app keeps writing the messages it sends (notifications, login codes) and agentdesk reads them as part of the conversation.

## Columns

| Column | Type | Holds |
|---|---|---|
| `id` | `uuid` primary key, `default gen_random_uuid()` | |
| `created_at` | `timestamptz not null default now()` | Message order |
| `phone_number` | `text not null` | The chat: a WhatsApp number (digits) or user id, or `web:<id>` for a website chat |
| `message` | `text not null` | The text; for a tool call, its raw result |
| `role` | `text not null` | `user` (the customer), `assistant` (the agent, your team or your app), `function` (a tool call), `system` (the agent paused or resumed) |
| `metadata` | `jsonb` | See below |
| `is_read` | `boolean` | Your team has read this customer message |
| `is_starred` | `boolean` | Starred in the inbox (a chat is starred when any of its messages is) |

Recommended indexes (agentdesk creates them on a new table): `(phone_number, created_at desc)`, `(created_at)`, and a unique one on `(metadata->>'whatsapp_message_id')` where it is not null, which stops Meta's retries from storing a message twice.

## Metadata keys

| Key | On | Meaning |
|---|---|---|
| `whatsapp_message_id` | customer WhatsApp messages | Meta's id (wamid) |
| `type`, `whatsapp_media_id`, `mime_type`, `caption`, `filename` | photos, voice notes, files | The media, downloadable from Meta for about 30 days |
| `profile_name` | customer WhatsApp messages | Their WhatsApp name |
| `name`, `args`, `is_error` | `function` rows | The tool, its input, whether it failed |
| `cards`, `voice`, `login`, `links` | agent replies | What the reply showed |
| `wa_message_ids`, `send_error` | agent and team replies on WhatsApp | What was sent, or why it wasn't |
| `team` | team replies | Written by a person from your team |
| `context`, `template_name` | rows your app wrote | Sent by your app, not the agent (text starting `[Automated System Message` counts too) |
| `paused_until` | `system` rows | The agent stays quiet in this chat until then; `null` = resumed |
| `user_id` | website messages | Who was logged in |

Messages your app sends a customer can go straight into the table with `role: assistant` and `metadata.context: true`, or through `POST /v1/admin/conversations/:key/context` if your app has no database access.

## Retention

`retentionDays: 30` deletes rows older than that once a day. Leave it out if your app already cleans the table.
