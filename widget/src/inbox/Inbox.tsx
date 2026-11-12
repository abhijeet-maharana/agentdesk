import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatText } from '../format';
import type { InboxApi, InboxConfig, InboxConversation, InboxMessage, ListQuery } from './api';

const LIST_EVERY_MS = 10_000;
const THREAD_EVERY_MS = 5_000;
const DAY_MS = 24 * 60 * 60_000;
const PAUSE_HOURS = 12;

/** A button your app adds to the chat header, e.g. "Send catalog". */
export interface InboxAction {
  label: string;
  run: (conversation: InboxConversation) => void | Promise<void>;
}

export interface InboxProps {
  api: InboxApi;
  /** Sends a team reply. Defaults to agentdesk's own (POST …/messages). */
  onSend?: (conversation: InboxConversation, text: string) => Promise<void>;
  actions?: InboxAction[];
  /** Your app's side panel for the open chat; drawn by your page into the `panel` slot. */
  onSelect?: (conversation: InboxConversation | null) => void;
  hasPanel?: boolean;
  initialConversation?: string;
}

export function Inbox({ api, onSend, actions = [], onSelect, hasPanel, initialConversation }: InboxProps) {
  const [config, setConfig] = useState<InboxConfig | null>(null);
  const [query, setQuery] = useState<ListQuery>({});
  const [search, setSearch] = useState('');
  const [list, setList] = useState<InboxConversation[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(initialConversation ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.config().then(setConfig, (e: Error) => setError(e.message));
  }, [api]);

  // The list refreshes in place; "Load older" appends pages.
  const refresh = useCallback(async () => {
    try {
      const fresh = await api.list(query);
      setList((old) => {
        const older = old.filter(
          (c) =>
            !fresh.some((f) => f.conversationId === c.conversationId) &&
            c.lastAt < (fresh.at(-1)?.lastAt ?? ''),
        );
        return [...fresh, ...older];
      });
      setHasMore((h) => h || fresh.length === 40);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, query]);

  useEffect(() => {
    setList([]);
    setHasMore(false);
    void refresh();
    const timer = setInterval(() => void refresh(), LIST_EVERY_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const loadOlder = async () => {
    const before = list.at(-1)?.lastAt;
    if (!before) return;
    const page = await api.list({ ...query, before });
    setList((old) => [
      ...old,
      ...page.filter((p) => !old.some((o) => o.conversationId === p.conversationId)),
    ]);
    setHasMore(page.length === 40);
  };

  // Search after a short pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => setQuery((q) => ({ ...q, search: search.trim() || undefined })), 350);
    return () => clearTimeout(timer);
  }, [search]);

  const selected = useMemo(
    () =>
      list.find((c) => c.conversationId === selectedKey) ??
      (selectedKey ? placeholderConversation(selectedKey) : null),
    [list, selectedKey],
  );

  useEffect(() => {
    onSelect?.(selected);
  }, [selected?.conversationId, onSelect]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`ib ${selected ? 'ib--open' : ''} ${hasPanel ? 'ib--panel' : ''}`}>
      <aside className="ib-list">
        <div className="ib-list-head">
          <p className="ib-title">{config?.title ?? 'Inbox'}</p>
          <input
            className="ib-search"
            type="search"
            placeholder="Search number, id or text"
            aria-label="Search chats"
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          />
          <fieldset className="ib-filters">
            <legend className="ib-sr">Filter chats</legend>
            <Filter
              active={!query.starred && !query.channel}
              onClick={() => setQuery((q) => ({ search: q.search }))}
            >
              All
            </Filter>
            <Filter
              active={Boolean(query.starred)}
              onClick={() => setQuery((q) => ({ ...q, starred: !q.starred }))}
            >
              ★ Starred
            </Filter>
            {(config?.channels.length ?? 0) > 1 &&
              config?.channels.map((ch) => (
                <Filter
                  key={ch}
                  active={query.channel === ch}
                  onClick={() => setQuery((q) => ({ ...q, channel: q.channel === ch ? undefined : ch }))}
                >
                  {channelLabel(ch)}
                </Filter>
              ))}
          </fieldset>
        </div>
        {error && <p className="ib-error">{error}</p>}
        <ul className="ib-items">
          {list.map((c) => (
            <li key={c.conversationId}>
              <button
                type="button"
                className={`ib-item ${c.conversationId === selectedKey ? 'ib-item--active' : ''}`}
                onClick={() => setSelectedKey(c.conversationId)}
              >
                <span className={`ib-avatar ib-avatar--${c.channel}`} aria-hidden>
                  {initials(c)}
                </span>
                <span className="ib-item-body">
                  <span className="ib-item-top">
                    <span className="ib-item-name">{displayName(c)}</span>
                    <span className="ib-item-time">{shortTime(c.lastAt)}</span>
                  </span>
                  <span className="ib-item-bottom">
                    <span className="ib-item-preview">
                      {c.lastRole === 'assistant' ? '↩ ' : ''}
                      {c.lastMessage.replace(/\*/g, '') || '…'}
                    </span>
                    {c.starred && (
                      <span className="ib-star" title="Starred">
                        ★
                      </span>
                    )}
                    {c.pausedUntil && (
                      <span className="ib-paused" title="AI paused">
                        ⏸
                      </span>
                    )}
                    {c.unread > 0 && <span className="ib-badge">{c.unread}</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {hasMore && list.length > 0 && (
          <button type="button" className="ib-more" onClick={() => void loadOlder()}>
            Load older chats
          </button>
        )}
        {!error && list.length === 0 && (
          <p className="ib-empty">No chats{query.search ? ' match' : ' yet'}.</p>
        )}
      </aside>

      <section className="ib-thread">
        {selected && config ? (
          <Thread
            key={selected.conversationId}
            api={api}
            config={config}
            conversation={selected}
            actions={actions}
            onSend={onSend}
            onBack={() => setSelectedKey(null)}
            onChanged={() => void refresh()}
          />
        ) : (
          <p className="ib-empty ib-empty--thread">Pick a chat.</p>
        )}
      </section>

      {hasPanel && (
        <aside className="ib-panel">
          <slot name="panel" />
        </aside>
      )}
    </div>
  );
}

function Thread({
  api,
  config,
  conversation,
  actions,
  onSend,
  onBack,
  onChanged,
}: {
  api: InboxApi;
  config: InboxConfig;
  conversation: InboxConversation;
  actions: InboxAction[];
  onSend?: InboxProps['onSend'];
  onBack: () => void;
  onChanged: () => void;
}) {
  const key = conversation.conversationId;
  const [messages, setMessages] = useState<InboxMessage[] | null>(null);
  const [pausedUntil, setPausedUntil] = useState<string | null>(conversation.pausedUntil);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const load = useCallback(async () => {
    try {
      const chat = await api.conversation(key);
      setMessages(chat.messages);
      setPausedUntil(chat.pausedUntil);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, key]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), THREAD_EVERY_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Opening a chat, or new messages arriving while it is open, marks it read.
  useEffect(() => {
    if (!messages) return;
    if (messages.length !== lastCount.current) {
      lastCount.current = messages.length;
      bottom.current?.scrollIntoView({ block: 'end' });
      if (conversation.unread > 0 || messages.at(-1)?.role === 'user') {
        api.markRead(key).then(onChanged, () => {});
      }
    }
  }, [messages, api, key, conversation.unread, onChanged]);

  const run = async (label: string, task: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await task();
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const send = (text: string) =>
    run('send', async () => {
      if (onSend) await onSend(conversation, text);
      else await api.send(key, text);
      setDraft('');
    });

  const lastCustomerAt =
    messages?.findLast((m) => m.role === 'user')?.createdAt ?? conversation.lastCustomerAt;
  const windowOpen = Boolean(lastCustomerAt && Date.now() - new Date(lastCustomerAt).getTime() < DAY_MS);

  return (
    <>
      <header className="ib-head">
        <button type="button" className="ib-back" onClick={onBack} aria-label="Back to chats">
          ←
        </button>
        <div className="ib-head-who">
          <p className="ib-head-name">{displayName(conversation)}</p>
          <p className="ib-head-sub">
            {channelLabel(conversation.channel)}
            {conversation.channel === 'whatsapp' && (
              <span className={`ib-pill ${windowOpen ? 'ib-pill--ok' : 'ib-pill--off'}`}>
                {windowOpen ? '24h window open' : 'Window closed'}
              </span>
            )}
          </p>
        </div>
        <div className="ib-head-actions">
          <button
            type="button"
            className={`ib-btn ${pausedUntil ? 'ib-btn--warn' : ''}`}
            disabled={busy !== null}
            title={
              pausedUntil
                ? 'Let the AI answer this chat again'
                : 'Stop the AI answering while your team talks'
            }
            onClick={() => void run('pause', () => api.pause(key, pausedUntil ? null : PAUSE_HOURS))}
          >
            {pausedUntil ? `AI paused until ${shortTime(pausedUntil)} · Resume` : 'AI on · Pause'}
          </button>
          <button
            type="button"
            className="ib-btn ib-btn--icon"
            aria-pressed={conversation.starred}
            title={conversation.starred ? 'Unstar' : 'Star'}
            disabled={busy !== null}
            onClick={() => void run('star', () => api.star(key, !conversation.starred))}
          >
            {conversation.starred ? '★' : '☆'}
          </button>
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className="ib-btn"
              disabled={busy !== null}
              onClick={() => void run(a.label, async () => a.run(conversation))}
            >
              {busy === a.label ? '…' : a.label}
            </button>
          ))}
        </div>
      </header>

      <div className="ib-messages">
        {!messages && <p className="ib-empty">Loading…</p>}
        {messages?.map((m, i) => (
          <MessageRow key={m.id} api={api} config={config} message={m} previous={messages[i - 1]} />
        ))}
        <div ref={bottom} />
      </div>

      {error && <p className="ib-error">{error}</p>}
      <form
        className="ib-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) void send(draft.trim());
        }}
      >
        {config.quickReplies.length > 0 && (
          <div className="ib-quick">
            {config.quickReplies.map((q) => (
              <button key={q.label} type="button" className="ib-chip" onClick={() => setDraft(q.text)}>
                {q.label}
              </button>
            ))}
          </div>
        )}
        <div className="ib-compose-row">
          <textarea
            className="ib-input"
            rows={2}
            placeholder={`Reply as ${config.teamLabel}…`}
            aria-label="Reply"
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (draft.trim()) void send(draft.trim());
              }
            }}
          />
          <button type="submit" className="ib-send" disabled={!draft.trim() || busy !== null}>
            {busy === 'send' ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </>
  );
}

function MessageRow({
  api,
  config,
  message: m,
  previous,
}: {
  api: InboxApi;
  config: InboxConfig;
  message: InboxMessage;
  previous?: InboxMessage;
}) {
  const day = dayLabel(m.createdAt);
  const separator =
    !previous || dayLabel(previous.createdAt) !== day ? <p className="ib-day">{day}</p> : null;
  const d = m.data;

  if (m.role === 'system') {
    return (
      <>
        {separator}
        <p className="ib-event">
          {d?.pausedUntil ? `AI paused until ${shortTime(d.pausedUntil)}` : m.text || 'AI resumed'} ·{' '}
          {clock(m.createdAt)}
        </p>
      </>
    );
  }

  if (m.role === 'tool' && d?.tool) {
    return (
      <>
        {separator}
        <details className={`ib-tool ${d.tool.isError ? 'ib-tool--error' : ''}`}>
          <summary>
            ⚙ {d.tool.name}
            {d.tool.isError ? ' (failed)' : ''}
          </summary>
          <pre>{JSON.stringify(d.tool.input, null, 2)}</pre>
          <pre>{prettyJson(d.tool.result)}</pre>
        </details>
      </>
    );
  }

  const kind = m.role === 'user' ? 'customer' : d?.team ? 'team' : d?.context ? 'system' : 'ai';
  const label = { customer: '', team: config.teamLabel, system: 'Sent by your app', ai: '🤖 AI' }[kind];
  const media = d?.whatsapp?.media;

  return (
    <>
      {separator}
      <div className={`ib-msg ib-msg--${kind}`}>
        <div className="ib-bubble">
          {label && <p className="ib-msg-label">{label}</p>}
          {media && <Media api={api} media={media} />}
          {m.text && <p className="ib-msg-text">{formatText(m.text)}</p>}
          {d?.cards && (
            <ul className="ib-cards">
              {d.cards.map((c) => (
                <li key={c.id}>
                  <a href={c.url} target="_blank" rel="noopener noreferrer">
                    {c.title}
                    {c.price !== undefined &&
                      ` · ${typeof c.price === 'number' ? `${config.currency}${c.price}` : c.price}`}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {d?.whatsapp?.error && <p className="ib-msg-error">Not delivered: {d.whatsapp.error}</p>}
          <p className="ib-msg-time">{clock(m.createdAt)}</p>
        </div>
      </div>
    </>
  );
}

/** A photo, voice note or file, fetched with the token. */
function Media({
  api,
  media,
}: {
  api: InboxApi;
  media: { id: string; mimeType: string; filename?: string };
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let created: string | null = null;
    api.mediaUrl(media.id).then(
      (u) => {
        created = u;
        setUrl(u);
      },
      () => setFailed(true),
    );
    return () => {
      if (created) URL.revokeObjectURL(created);
    };
  }, [api, media.id]);

  if (failed) return <p className="ib-msg-error">Media no longer available</p>;
  if (!url) return <p className="ib-msg-label">Loading media…</p>;
  if (media.mimeType.startsWith('image/')) return <img className="ib-img" src={url} alt="" />;
  // WhatsApp voice notes and videos come without captions.
  if (media.mimeType.startsWith('audio/'))
    return (
      <audio className="ib-audio" controls src={url}>
        <track kind="captions" />
      </audio>
    );
  if (media.mimeType.startsWith('video/'))
    return (
      <video className="ib-img" controls src={url}>
        <track kind="captions" />
      </video>
    );
  return (
    <a href={url} download={media.filename ?? 'file'}>
      {media.filename ?? 'Download file'}
    </a>
  );
}

function Filter({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`ib-filter ${active ? 'ib-filter--on' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function placeholderConversation(key: string): InboxConversation {
  return {
    conversationId: key,
    channel: key.split(':')[0] ?? '',
    lastMessage: '',
    lastRole: 'user',
    lastAt: '',
    messages: 0,
    unread: 0,
    starred: false,
    pausedUntil: null,
    name: null,
    lastCustomerAt: null,
  };
}

export function displayName(c: Pick<InboxConversation, 'conversationId' | 'channel' | 'name'>): string {
  const id = c.conversationId.slice(c.channel.length + 1);
  if (c.channel === 'whatsapp') {
    const number = /^\d+$/.test(id) ? `+${id}` : 'WhatsApp user';
    return c.name ? `${c.name} · ${number}` : number;
  }
  return c.channel === 'web' ? `Website visitor ${id.slice(0, 6)}` : c.conversationId;
}

function initials(c: InboxConversation): string {
  const words = (c.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length)
    return words
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('');
  return c.channel === 'whatsapp' ? 'WA' : 'W';
}

function channelLabel(channel: string): string {
  return channel === 'whatsapp' ? 'WhatsApp' : channel === 'web' ? 'Website' : channel;
}

function shortTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Tool results are often JSON on one line; indented they can be read. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
