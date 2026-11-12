import postgres from 'postgres';
import type { ConversationSummary, MessageData, NewMessage, Role, Store, StoredMessage } from './store.js';

interface Row {
  id: string;
  conversation_id: string;
  channel: string;
  role: Role;
  text: string;
  data: MessageData | null;
  created_at: Date;
}

const toMessage = (row: Row): StoredMessage => ({
  id: String(row.id),
  conversationId: row.conversation_id,
  channel: row.channel,
  role: row.role,
  text: row.text,
  data: row.data,
  createdAt: row.created_at.toISOString(),
});

/** Chats in one Postgres table, `agentdesk_messages`, created on start. */
export class PostgresStore implements Store {
  private readonly sql: postgres.Sql;

  constructor(url: string) {
    this.sql = postgres(url, { max: 5, onnotice: () => {} });
  }

  async init(): Promise<void> {
    await this.sql`
      create table if not exists agentdesk_messages (
        id bigserial primary key,
        conversation_id text not null,
        channel text not null,
        role text not null check (role in ('user', 'assistant', 'tool')),
        text text not null default '',
        data jsonb,
        created_at timestamptz not null default now()
      )`;
    await this.sql`
      create index if not exists agentdesk_messages_conversation_idx
        on agentdesk_messages (conversation_id, id desc)`;
  }

  async add(message: NewMessage): Promise<StoredMessage> {
    const data = message.data ? this.sql.json(message.data as postgres.JSONValue) : null;
    const [row] = await this.sql<Row[]>`
      insert into agentdesk_messages (conversation_id, channel, role, text, data)
      values (${message.conversationId}, ${message.channel}, ${message.role}, ${message.text}, ${data})
      returning *`;
    if (!row) throw new Error('Insert returned no row');
    return toMessage(row);
  }

  async recent(conversationId: string, limit: number, opts: { includeTools?: boolean } = {}) {
    const rows = await this.sql<Row[]>`
      select * from agentdesk_messages
      where conversation_id = ${conversationId}
        ${opts.includeTools ? this.sql`` : this.sql`and role <> 'tool'`}
      order by id desc
      limit ${limit}`;
    return rows.reverse().map(toMessage);
  }

  async conversations(limit: number): Promise<ConversationSummary[]> {
    const rows = await this.sql<
      { conversation_id: string; channel: string; text: string; created_at: Date; messages: string }[]
    >`
      with latest as (
        select conversation_id, max(id) as id, count(*) as messages
        from agentdesk_messages
        where role <> 'tool'
        group by conversation_id
        order by max(id) desc
        limit ${limit}
      )
      select m.conversation_id, m.channel, m.text, m.created_at, latest.messages
      from latest join agentdesk_messages m on m.id = latest.id
      order by m.id desc`;
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      channel: r.channel,
      lastMessage: r.text,
      lastAt: r.created_at.toISOString(),
      messages: Number(r.messages),
    }));
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
