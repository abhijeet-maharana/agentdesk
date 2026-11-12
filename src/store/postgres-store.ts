import postgres from 'postgres';
import { type ChatRow, channelOf, conversationIdOf, fromRow, rowKey, toColumns } from './chat-table.js';
import {
  type ConversationQuery,
  type ConversationSummary,
  DuplicateMessageError,
  type NewMessage,
  type Store,
  type StoredMessage,
} from './store.js';

/**
 * Chats in one Postgres table (`storage.table`, default `agentdesk_chats`), one row per message
 * (columns in chat-table.ts). If the table doesn't exist it is created; an existing one, e.g. your
 * app's own WhatsApp log with the same columns, is used as it is and never altered.
 */
export class PostgresStore implements Store {
  private readonly sql: postgres.Sql;
  private readonly table: string;

  constructor(url: string, table = 'agentdesk_chats') {
    this.sql = postgres(url, { max: 5, onnotice: () => {} });
    this.table = table;
  }

  async init(): Promise<void> {
    const [schema, name] = this.table.includes('.') ? this.table.split('.') : ['public', this.table];
    const [found] = await this.sql`select to_regclass(${`${schema}.${name}`}) as oid`;
    if (found?.oid) return;
    const t = this.sql(this.table);
    await this.sql`
      create table ${t} (
        id uuid primary key default gen_random_uuid(),
        created_at timestamptz not null default now(),
        phone_number text not null,
        message text not null default '',
        role text not null,
        metadata jsonb,
        is_read boolean,
        is_starred boolean
      )`;
    await this.sql`create index on ${t} (phone_number, created_at desc)`;
    await this.sql`create index on ${t} (created_at)`;
    await this
      .sql`create unique index on ${t} ((metadata->>'whatsapp_message_id')) where metadata->>'whatsapp_message_id' is not null`;
    // Row level security with no policies: only the table's owner (agentdesk) can read it. Harmless on
    // plain Postgres; on Supabase it keeps chats out of the public REST API.
    await this.sql`alter table ${t} enable row level security`;
  }

  async add(message: NewMessage): Promise<StoredMessage> {
    const c = toColumns(message);
    const metadata = c.metadata ? this.sql.json(c.metadata as postgres.JSONValue) : null;
    try {
      const [row] = await this.sql<ChatRow[]>`
        insert into ${this.sql(this.table)} (phone_number, message, role, metadata, created_at)
        values (${c.phone_number}, ${c.message}, ${c.role}, ${metadata},
                -- Ids are random uuids, so time is the only order: always after the chat's newest
                -- message, even when two are written within the clock's resolution.
                coalesce(${message.createdAt ? new Date(message.createdAt) : null}::timestamptz, greatest(
                  clock_timestamp(),
                  (select max(created_at) + interval '1 microsecond' from ${this.sql(this.table)}
                    where phone_number = ${c.phone_number}))))
        returning *`;
      if (!row) throw new Error('Insert returned no row');
      return fromRow(row);
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new DuplicateMessageError('Message already stored');
      throw error;
    }
  }

  async recent(conversationId: string, limit: number, opts: { includeTools?: boolean } = {}) {
    const rows = await this.sql<ChatRow[]>`
      select * from ${this.sql(this.table)}
      where phone_number = ${rowKey(conversationId)}
        ${opts.includeTools ? this.sql`` : this.sql`and role in ('user', 'assistant')`}
        and not (role = 'assistant' and message = '')
      order by created_at desc, id desc
      limit ${limit}`;
    return rows.reverse().map(fromRow);
  }

  async conversations(query: ConversationQuery): Promise<ConversationSummary[]> {
    const { sql } = this;
    const t = sql(this.table);
    const search = query.search ? `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const rows = await sql<
      {
        phone_number: string;
        role: string;
        message: string;
        created_at: Date;
        messages: string;
        unread: string;
        starred: boolean;
        last_customer_at: Date | null;
        name: string | null;
        paused_until: string | null;
      }[]
    >`
      with stats as (
        select phone_number,
               count(*) filter (where role in ('user', 'assistant') and message <> '') as messages,
               count(*) filter (where role = 'user' and coalesce(is_read, false) = false) as unread,
               coalesce(bool_or(is_starred), false) as starred,
               max(created_at) filter (where role = 'user') as last_customer_at
        from ${t}
        group by phone_number
      ),
      latest as (
        select distinct on (phone_number) phone_number, role, message, created_at
        from ${t}
        where role in ('user', 'assistant') and message <> ''
        order by phone_number, created_at desc, id desc
      )
      select l.phone_number, l.role, l.message, l.created_at, s.messages, s.unread, s.starred, s.last_customer_at,
             (select metadata->>'profile_name' from ${t} n
               where n.phone_number = l.phone_number and n.metadata ? 'profile_name'
               order by n.created_at desc limit 1) as name,
             (select metadata->>'paused_until' from ${t} p
               where p.phone_number = l.phone_number and p.role = 'system' and p.metadata ? 'paused_until'
               order by p.created_at desc limit 1) as paused_until
      from latest l
      join stats s on s.phone_number = l.phone_number
      where true
        ${query.before ? sql`and l.created_at < ${new Date(query.before)}` : sql``}
        ${query.channel === 'web' ? sql`and l.phone_number like 'web:%'` : sql``}
        ${query.channel === 'whatsapp' ? sql`and l.phone_number not like '%:%'` : sql``}
        ${query.starredOnly ? sql`and s.starred` : sql``}
        ${
          search
            ? sql`and (l.phone_number ilike ${search} or exists (
                select 1 from ${t} x where x.phone_number = l.phone_number and x.message ilike ${search}))`
            : sql``
        }
      order by l.created_at desc
      limit ${query.limit}`;
    return rows.map((r) => ({
      conversationId: conversationIdOf(r.phone_number),
      channel: channelOf(r.phone_number),
      lastMessage: r.message,
      lastRole: r.role === 'user' ? 'user' : 'assistant',
      lastAt: r.created_at.toISOString(),
      messages: Number(r.messages),
      unread: Number(r.unread),
      starred: r.starred,
      pausedUntil: r.paused_until && new Date(r.paused_until) > new Date() ? r.paused_until : null,
      name: r.name,
      lastCustomerAt: r.last_customer_at?.toISOString() ?? null,
    }));
  }

  async markRead(conversationId: string): Promise<void> {
    await this.sql`
      update ${this.sql(this.table)} set is_read = true
      where phone_number = ${rowKey(conversationId)} and role = 'user' and coalesce(is_read, false) = false`;
  }

  /** Starring a chat stars its latest message; unstarring clears every star in it. */
  async setStarred(conversationId: string, starred: boolean): Promise<void> {
    const t = this.sql(this.table);
    const key = rowKey(conversationId);
    if (!starred) {
      await this.sql`update ${t} set is_starred = false where phone_number = ${key} and is_starred`;
      return;
    }
    await this.sql`
      update ${t} set is_starred = true
      where id = (select id from ${t} where phone_number = ${key} and role in ('user', 'assistant')
                  order by created_at desc, id desc limit 1)`;
  }

  async pausedUntil(conversationId: string): Promise<Date | null> {
    const [row] = await this.sql<{ paused_until: string | null }[]>`
      select metadata->>'paused_until' as paused_until from ${this.sql(this.table)}
      where phone_number = ${rowKey(conversationId)} and role = 'system' and metadata ? 'paused_until'
      order by created_at desc limit 1`;
    const until = row?.paused_until ? new Date(row.paused_until) : null;
    return until && until > new Date() ? until : null;
  }

  /** Recorded as a `system` row, so the chat shows when the team paused and resumed the agent. */
  async setPausedUntil(conversationId: string, until: Date | null): Promise<void> {
    await this.add({
      conversationId,
      channel: channelOf(rowKey(conversationId)),
      role: 'system',
      text: until ? `AI paused until ${until.toISOString()}` : 'AI resumed',
      data: { pausedUntil: until?.toISOString() ?? null },
    });
  }

  async deleteBefore(cutoff: Date): Promise<number> {
    const result = await this.sql`delete from ${this.sql(this.table)} where created_at < ${cutoff}`;
    return result.count;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
