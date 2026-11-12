import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { formatText } from '../format';
import { CloseIcon, SendIcon } from '../icons';
import type { InboxApi, InboxConfig, InboxConversation, InboxMessage, ListQuery } from './api';
import {
  AppIcon,
  BackIcon,
  ChatsIcon,
  DownIcon,
  FileIcon,
  GlobeIcon,
  MoreIcon,
  PauseIcon,
  PersonIcon,
  PlayIcon,
  SearchIcon,
  SparkIcon,
  StarIcon,
  ToolIcon,
  WaGlyph,
} from './icons';

const LIST_EVERY_MS = 10_000;
const THREAD_EVERY_MS = 5_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const PAGE_SIZE = 40;
/** Pause lengths offered in the "Pause AI" menu, in hours. */
const PAUSE_OPTIONS: Array<{ hours: number; label: string }> = [
  { hours: 1, label: 'For 1 hour' },
  { hours: 12, label: 'For 12 hours' },
  { hours: 24, label: 'For 24 hours' },
  { hours: 24 * 7, label: 'For 7 days' },
];
const TOOLS_PREF = 'agentdesk-inbox-show-tools';

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

type View = 'all' | 'unread' | 'paused';

export function Inbox({ api, onSend, actions = [], onSelect, hasPanel, initialConversation }: InboxProps) {
  const [config, setConfig] = useState<InboxConfig | null>(null);
  const [query, setQuery] = useState<ListQuery>({});
  const [view, setView] = useState<View>('all');
  const [search, setSearch] = useState('');
  const [list, setList] = useState<InboxConversation[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(initialConversation ?? null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [showTools, setShowTools] = useState(() => readPref(TOOLS_PREF) !== 'false');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.config().then(setConfig, (e: Error) => setError(e.message));
  }, [api]);

  // The list refreshes in place; "Load older chats" appends pages.
  const refresh = useCallback(async () => {
    try {
      const fresh = await api.list(query, PAGE_SIZE);
      setList((old) => {
        const older = (old ?? []).filter(
          (c) =>
            !fresh.some((f) => f.conversationId === c.conversationId) &&
            c.lastAt < (fresh.at(-1)?.lastAt ?? ''),
        );
        return [...fresh, ...older];
      });
      setHasMore((h) => h || fresh.length === PAGE_SIZE);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, query]);

  useEffect(() => {
    setList(null);
    setHasMore(false);
    void refresh();
    const timer = setInterval(() => void refresh(), LIST_EVERY_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const loadOlder = async () => {
    const before = list?.at(-1)?.lastAt;
    if (!before) return;
    try {
      const page = await api.list({ ...query, before }, PAGE_SIZE);
      setList((old) => [
        ...(old ?? []),
        ...page.filter((p) => !(old ?? []).some((o) => o.conversationId === p.conversationId)),
      ]);
      setHasMore(page.length === PAGE_SIZE);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Search after a short pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => setQuery((q) => ({ ...q, search: search.trim() || undefined })), 350);
    return () => clearTimeout(timer);
  }, [search]);

  const selected = useMemo(
    () =>
      list?.find((c) => c.conversationId === selectedKey) ??
      (selectedKey ? placeholderConversation(selectedKey) : null),
    [list, selectedKey],
  );

  useEffect(() => {
    onSelect?.(selected);
  }, [selected?.conversationId, onSelect]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleTools = () =>
    setShowTools((on) => {
      writePref(TOOLS_PREF, String(!on));
      return !on;
    });

  const shown = (list ?? []).filter((c) =>
    view === 'unread' ? c.unread > 0 : view === 'paused' ? Boolean(c.pausedUntil) : true,
  );
  const unreadChats = (list ?? []).filter((c) => c.unread > 0).length;
  const channels = config?.channels ?? [];

  return (
    <div
      className={[
        'ib',
        selected ? 'ib--open' : '',
        hasPanel ? 'ib--panel' : '',
        hasPanel && panelOpen ? 'ib--panel-open' : '',
      ].join(' ')}
    >
      <aside className="ib-list" aria-label="Chats">
        <div className="ib-list-head">
          <h1 className="ib-title">{config?.title ?? 'Inbox'}</h1>
          <label className="ib-search">
            <SearchIcon />
            <span className="ib-sr">Search chats</span>
            <input
              type="search"
              placeholder="Search name, number or message"
              value={search}
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            />
          </label>
          <fieldset className="ib-filters">
            <legend className="ib-sr">Show</legend>
            <Filter
              active={view === 'all' && !query.starred}
              onClick={() => {
                setView('all');
                setQuery((q) => ({ ...q, starred: undefined }));
              }}
            >
              All
            </Filter>
            <Filter active={view === 'unread'} onClick={() => setView(view === 'unread' ? 'all' : 'unread')}>
              Unread{unreadChats > 0 && <span className="ib-filter-count">{unreadChats}</span>}
            </Filter>
            <Filter active={view === 'paused'} onClick={() => setView(view === 'paused' ? 'all' : 'paused')}>
              AI paused
            </Filter>
            <Filter
              active={Boolean(query.starred)}
              onClick={() => setQuery((q) => ({ ...q, starred: q.starred ? undefined : true }))}
            >
              Starred
            </Filter>
            {channels.length > 1 &&
              channels.map((ch) => (
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
        {error && (
          <p className="ib-alert" role="alert">
            {error}
          </p>
        )}
        <ul className="ib-items">
          {shown.map((c) => (
            <li key={c.conversationId}>
              <ListItem
                conversation={c}
                active={c.conversationId === selectedKey}
                onOpen={() => setSelectedKey(c.conversationId)}
              />
            </li>
          ))}
          {list === null && !error && <li className="ib-empty">Loading chats…</li>}
          {list !== null && shown.length === 0 && (
            <li className="ib-empty">
              {query.search
                ? `No chats match “${query.search}”.`
                : view === 'unread'
                  ? 'No unread chats.'
                  : view === 'paused'
                    ? 'The AI is answering every chat.'
                    : query.starred
                      ? 'No starred chats. Star a chat to keep it here.'
                      : 'No chats yet. They show up here as soon as a customer writes.'}
            </li>
          )}
        </ul>
        {hasMore && shown.length > 0 && (
          <button type="button" className="ib-more" onClick={() => void loadOlder()}>
            Load older chats
          </button>
        )}
      </aside>

      <section className="ib-thread" aria-label="Conversation">
        {selected && config ? (
          <Thread
            key={selected.conversationId}
            api={api}
            config={config}
            conversation={selected}
            actions={actions}
            onSend={onSend}
            hasPanel={Boolean(hasPanel)}
            showTools={showTools}
            onToggleTools={toggleTools}
            onOpenPanel={() => setPanelOpen(true)}
            onBack={() => {
              setPanelOpen(false);
              setSelectedKey(null);
            }}
            onChanged={() => void refresh()}
          />
        ) : (
          <div className="ib-placeholder">
            <ChatsIcon />
            <p>Select a chat to read it and reply.</p>
          </div>
        )}
      </section>

      {hasPanel && (
        <>
          <button
            type="button"
            className="ib-scrim"
            aria-label="Close customer details"
            tabIndex={-1}
            onClick={() => setPanelOpen(false)}
          />
          <Drawer open={panelOpen} onClose={() => setPanelOpen(false)} />
        </>
      )}
    </div>
  );
}

/** Your panel: a column on wide screens, a drawer over the chat on narrow ones. */
function Drawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    close.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <aside className="ib-panel" aria-label="Customer details">
      <div className="ib-panel-head">
        <h2>Customer details</h2>
        <button ref={close} type="button" className="ib-icon-btn" aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="ib-panel-body">
        <slot name="panel" />
      </div>
    </aside>
  );
}

function ListItem({
  conversation: c,
  active,
  onOpen,
}: {
  conversation: InboxConversation;
  active: boolean;
  onOpen: () => void;
}) {
  const { name } = who(c);
  const preview = c.lastMessage.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  return (
    <button
      type="button"
      className={`ib-item${active ? ' ib-item--active' : ''}${c.unread > 0 ? ' ib-item--unread' : ''}`}
      aria-current={active ? 'true' : undefined}
      onClick={onOpen}
    >
      <Avatar conversation={c} />
      <span className="ib-item-body">
        <span className="ib-item-row">
          <span className="ib-item-name">{name}</span>
          <time className="ib-item-time" dateTime={c.lastAt}>
            {listTime(c.lastAt)}
          </time>
        </span>
        <span className="ib-item-row">
          <span className="ib-item-preview">
            {c.lastRole !== 'user' && <span className="ib-item-you">Replied: </span>}
            {preview || 'Photo or file'}
          </span>
          {c.starred && <StarIcon filled className="ib-item-star" label="Starred" />}
          {c.unread > 0 && (
            <span className="ib-badge" title={`${c.unread} unread`}>
              {c.unread}
              <span className="ib-sr"> unread</span>
            </span>
          )}
        </span>
        {c.pausedUntil && (
          <span className="ib-item-paused">
            <PauseIcon />
            AI paused until {untilLabel(c.pausedUntil)}
          </span>
        )}
      </span>
    </button>
  );
}

function Avatar({ conversation: c, large }: { conversation: InboxConversation; large?: boolean }) {
  return (
    <span className={`ib-avatar${large ? ' ib-avatar--large' : ''}`} aria-hidden>
      {initials(c) ?? <PersonIcon />}
      <span className={`ib-avatar-channel ib-avatar-channel--${c.channel}`}>
        {c.channel === 'whatsapp' ? <WaGlyph /> : <GlobeIcon />}
      </span>
    </span>
  );
}

function Thread({
  api,
  config,
  conversation,
  actions,
  onSend,
  hasPanel,
  showTools,
  onToggleTools,
  onOpenPanel,
  onBack,
  onChanged,
}: {
  api: InboxApi;
  config: InboxConfig;
  conversation: InboxConversation;
  actions: InboxAction[];
  onSend?: InboxProps['onSend'];
  hasPanel: boolean;
  showTools: boolean;
  onToggleTools: () => void;
  onOpenPanel: () => void;
  onBack: () => void;
  onChanged: () => void;
}) {
  const key = conversation.conversationId;
  const [messages, setMessages] = useState<InboxMessage[] | null>(null);
  const [pausedUntil, setPausedUntil] = useState<string | null>(conversation.pausedUntil);
  const [starred, setStarred] = useState(conversation.starred);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastCount = useRef(0);

  useEffect(() => setStarred(conversation.starred), [conversation.starred]);

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

  const scrollToEnd = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // New messages: follow them if the reader is at the bottom (or just opened the chat), and mark read.
  useLayoutEffect(() => {
    if (!messages || messages.length === lastCount.current) return;
    const first = lastCount.current === 0;
    lastCount.current = messages.length;
    if (first || atBottom) scrollToEnd();
    if (conversation.unread > 0 || messages.at(-1)?.role === 'user') {
      api.markRead(key).then(onChanged, () => {});
    }
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (input.current) input.current.style.height = '';
      setAtBottom(true);
      requestAnimationFrame(scrollToEnd);
    });

  const pause = (hours: number | null) => run('pause', () => api.pause(key, hours));
  const toggleStar = () =>
    run('star', async () => {
      await api.star(key, !starred);
      setStarred(!starred);
    });

  const lastCustomerAt =
    messages?.findLast((m) => m.role === 'user')?.createdAt ?? conversation.lastCustomerAt;
  const windowMs = lastCustomerAt ? DAY_MS - (Date.now() - new Date(lastCustomerAt).getTime()) : 0;
  const isWhatsApp = conversation.channel === 'whatsapp';
  const { name, detail } = who(conversation);
  const items = useMemo(() => groupMessages(messages ?? []), [messages]);
  const disabled = busy !== null;

  const menuItems: MenuItem[] = [
    {
      label: starred ? 'Unstar chat' : 'Star chat',
      onSelect: () => void toggleStar(),
      disabled,
    },
    ...actions.map((a) => ({
      label: a.label,
      onSelect: () => void run(a.label, async () => a.run(conversation)),
      disabled,
    })),
    { label: 'Show tool calls', checked: showTools, onSelect: onToggleTools },
    ...(hasPanel ? [{ label: 'Customer details', onSelect: onOpenPanel }] : []),
  ];

  return (
    <>
      <header className="ib-head">
        <button type="button" className="ib-icon-btn ib-back" onClick={onBack} aria-label="Back to chats">
          <BackIcon />
        </button>
        <Avatar conversation={conversation} large />
        <div className="ib-head-who">
          <h2 className="ib-head-name">{name}</h2>
          <p className="ib-head-sub">
            <span className={`ib-channel ib-channel--${conversation.channel}`}>
              {channelLabel(conversation.channel)}
            </span>
            {detail && <span className="ib-head-detail">{detail}</span>}
            {isWhatsApp && (
              <span
                className={`ib-window ${windowMs > 0 ? 'ib-window--open' : 'ib-window--closed'}`}
                title="WhatsApp only delivers free-form replies within 24 hours of the customer's last message"
              >
                {windowMs > 0 ? `Reply window: ${durationLeft(windowMs)} left` : 'Reply window closed'}
              </span>
            )}
          </p>
        </div>
        <div className="ib-head-actions">
          <button
            type="button"
            className={`ib-icon-btn${starred ? ' ib-icon-btn--star' : ''}`}
            aria-pressed={starred}
            aria-label={starred ? 'Unstar chat' : 'Star chat'}
            title={starred ? 'Unstar' : 'Star'}
            disabled={disabled}
            onClick={() => void toggleStar()}
          >
            <StarIcon filled={starred} />
          </button>
          <button
            type="button"
            className="ib-icon-btn"
            aria-pressed={showTools}
            aria-label="Show tool calls"
            title={showTools ? 'Hide tool calls' : 'Show tool calls'}
            onClick={onToggleTools}
          >
            <ToolIcon />
          </button>
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className="ib-btn"
              disabled={disabled}
              onClick={() => void run(a.label, async () => a.run(conversation))}
            >
              {busy === a.label ? 'Working…' : a.label}
            </button>
          ))}
          {hasPanel && (
            <button type="button" className="ib-btn ib-details-btn" onClick={onOpenPanel}>
              <PersonIcon />
              Details
            </button>
          )}
        </div>
        <Menu
          className="ib-overflow"
          label="More actions"
          button={<MoreIcon />}
          buttonClass="ib-icon-btn"
          align="end"
          items={menuItems}
        />
      </header>

      <AiStatus pausedUntil={pausedUntil} busy={busy === 'pause'} disabled={disabled} onPause={pause} />

      <div className="ib-scroll">
        <div
          className="ib-messages"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
          }}
        >
          {!messages && <p className="ib-empty">Loading conversation…</p>}
          {messages?.length === 0 && <p className="ib-empty">No messages in this chat yet.</p>}
          {items.map((item, i) => {
            const previous = items[i - 1];
            const day = dayLabel(item.createdAt);
            const newDay = !previous || dayLabel(previous.createdAt) !== day;
            return (
              <div key={item.id} className="ib-row">
                {newDay && (
                  <p className="ib-day">
                    <span>{day}</span>
                  </p>
                )}
                {item.type === 'tools' ? (
                  showTools && <ToolGroup calls={item.calls} />
                ) : (
                  <MessageRow
                    api={api}
                    config={config}
                    message={item.message}
                    continues={!newDay && continues(previous, item)}
                  />
                )}
              </div>
            );
          })}
        </div>
        {!atBottom && (
          <button
            type="button"
            className="ib-jump"
            onClick={() => {
              scrollToEnd();
              setAtBottom(true);
            }}
          >
            <DownIcon />
            Latest
          </button>
        )}
      </div>

      <form
        className="ib-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) void send(draft.trim());
        }}
      >
        {error && (
          <p className="ib-alert" role="alert">
            {error}
            <button
              type="button"
              className="ib-alert-close"
              aria-label="Dismiss"
              onClick={() => setError(null)}
            >
              <CloseIcon />
            </button>
          </p>
        )}
        {isWhatsApp && windowMs <= 0 && (
          <p className="ib-note">
            The 24-hour window is closed, so WhatsApp may not deliver a free-form reply until the customer
            writes again.
          </p>
        )}
        {config.quickReplies.length > 0 && (
          <fieldset className="ib-quick">
            <legend className="ib-sr">Quick replies</legend>
            {config.quickReplies.map((q) => (
              <button
                key={q.label}
                type="button"
                className="ib-chip"
                title={q.text}
                onClick={() => {
                  setDraft(q.text);
                  input.current?.focus();
                }}
              >
                {q.label}
              </button>
            ))}
          </fieldset>
        )}
        <div className="ib-compose-row">
          <textarea
            ref={input}
            className="ib-input"
            rows={1}
            placeholder={`Reply as ${config.teamLabel}`}
            aria-label="Reply"
            value={draft}
            onInput={(e) => {
              const el = e.target as HTMLTextAreaElement;
              setDraft(el.value);
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              // Enter sends on a keyboard; on a phone it starts a new line and the button sends.
              if (e.key === 'Enter' && !e.shiftKey && !isTouch()) {
                e.preventDefault();
                if (draft.trim()) void send(draft.trim());
              }
            }}
          />
          <button type="submit" className="ib-send" disabled={!draft.trim() || disabled}>
            <SendIcon />
            <span>{busy === 'send' ? 'Sending…' : 'Send'}</span>
          </button>
        </div>
      </form>
    </>
  );
}

/** Whether the AI answers this chat. Only your team changes it: Pause AI / Resume AI. */
function AiStatus({
  pausedUntil,
  busy,
  disabled,
  onPause,
}: {
  pausedUntil: string | null;
  busy: boolean;
  disabled: boolean;
  onPause: (hours: number | null) => void;
}) {
  if (pausedUntil) {
    return (
      <div className="ib-ai ib-ai--paused" role="status">
        <span className="ib-ai-icon">
          <PauseIcon />
        </span>
        <p className="ib-ai-text">
          <strong>AI paused until {untilLabel(pausedUntil)}</strong>
          <span>Customer messages are saved but not answered. You're handling this chat.</span>
        </p>
        <button
          type="button"
          className="ib-btn ib-btn--strong"
          disabled={disabled}
          onClick={() => onPause(null)}
        >
          <PlayIcon />
          {busy ? 'Resuming…' : 'Resume AI'}
        </button>
      </div>
    );
  }
  return (
    <div className="ib-ai ib-ai--on" role="status">
      <span className="ib-ai-dot" aria-hidden />
      <p className="ib-ai-text">
        <strong>AI is answering</strong>
        <span className="ib-ai-hint">Pause it to talk to the customer yourself.</span>
      </p>
      <Menu
        label="Pause AI"
        button={
          <>
            <PauseIcon />
            {busy ? 'Pausing…' : 'Pause AI'}
          </>
        }
        buttonClass="ib-btn"
        disabled={disabled}
        align="end"
        items={PAUSE_OPTIONS.map((o) => ({ label: o.label, onSelect: () => onPause(o.hours) }))}
      />
    </div>
  );
}

function MessageRow({
  api,
  config,
  message: m,
  continues,
}: {
  api: InboxApi;
  config: InboxConfig;
  message: InboxMessage;
  continues: boolean;
}) {
  const d = m.data;

  if (m.role === 'system') {
    const paused = Boolean(d?.pausedUntil) || (!(d && 'pausedUntil' in d) && /paus/i.test(m.text));
    return (
      <p className={`ib-event ib-event--${paused ? 'paused' : 'resumed'}`}>
        {paused ? <PauseIcon /> : <PlayIcon />}
        <span>
          {d?.pausedUntil ? `AI paused until ${untilLabel(d.pausedUntil)}` : paused ? m.text : 'AI resumed'}
        </span>
        <time dateTime={m.createdAt}>{clock(m.createdAt)}</time>
      </p>
    );
  }

  const kind = kindOf(m);
  const label = {
    customer: null,
    team: { icon: <PersonIcon />, text: config.teamLabel },
    app: { icon: <AppIcon />, text: 'Sent by your app' },
    ai: { icon: <SparkIcon />, text: 'AI' },
  }[kind];
  const media = d?.whatsapp?.media;
  const text = shownText(m.text, Boolean(media));

  return (
    <div className={`ib-msg ib-msg--${kind}${continues ? ' ib-msg--cont' : ''}`}>
      {label && !continues && (
        <p className="ib-msg-label">
          {label.icon}
          {label.text}
        </p>
      )}
      <div className="ib-bubble">
        {media && <Media api={api} media={media} />}
        {text && <p className="ib-msg-text">{formatText(text)}</p>}
        {d?.cards && d.cards.length > 0 && (
          <ul className="ib-cards">
            {d.cards.map((c) => (
              <li key={c.id}>
                <a href={safeUrl(c.url)} target="_blank" rel="noopener noreferrer">
                  {c.image && <img src={safeUrl(c.image)} alt="" loading="lazy" />}
                  <span className="ib-card-title">{c.title}</span>
                  {c.price !== undefined && (
                    <span className="ib-card-price">
                      {typeof c.price === 'number' ? `${config.currency}${c.price}` : c.price}
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        )}
        {d?.login && <p className="ib-msg-meta">Showed the “Log in” button</p>}
        {d?.whatsapp?.error && (
          <p className="ib-msg-error">
            <strong>Not delivered.</strong> {d.whatsapp.error}
          </p>
        )}
        <p className="ib-msg-time">
          {d?.voice && <span className="ib-msg-tag">Voice</span>}
          <time dateTime={m.createdAt}>{clock(m.createdAt)}</time>
        </p>
      </div>
    </div>
  );
}

type ToolCall = {
  id: string;
  createdAt: string;
  tool: NonNullable<NonNullable<InboxMessage['data']>['tool']>;
};

/** A run of tool calls between two messages, folded into one line. */
function ToolGroup({ calls }: { calls: ToolCall[] }) {
  const failed = calls.filter((c) => c.tool.isError).length;
  const names = [...new Set(calls.map((c) => c.tool.name))];
  return (
    <details className={`ib-tools${failed ? ' ib-tools--error' : ''}`}>
      <summary>
        <ToolIcon />
        <span className="ib-tools-summary">
          {calls.length === 1 ? 'Used ' : `Used ${calls.length} tools: `}
          <span className="ib-tools-names">{names.join(', ')}</span>
        </span>
        {failed > 0 && <span className="ib-tools-failed">{failed} failed</span>}
      </summary>
      <ol className="ib-tool-list">
        {calls.map((c) => (
          <li key={c.id} className={c.tool.isError ? 'ib-tool--error' : ''}>
            <p className="ib-tool-name">
              {c.tool.name}
              {c.tool.isError && <span className="ib-tools-failed">failed</span>}
              <time dateTime={c.createdAt}>{clock(c.createdAt)}</time>
            </p>
            <p className="ib-tool-label">Input</p>
            <pre>{JSON.stringify(c.tool.input, null, 2)}</pre>
            <p className="ib-tool-label">Result</p>
            <pre>{prettyJson(c.tool.result)}</pre>
          </li>
        ))}
      </ol>
    </details>
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

  if (failed) return <p className="ib-media-missing">Media no longer available</p>;
  if (!url) return <p className="ib-media-loading">Loading media…</p>;
  if (media.mimeType.startsWith('image/'))
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="ib-img-link">
        <img className="ib-img" src={url} alt="Sent in the chat" />
      </a>
    );
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
    <a className="ib-file" href={url} download={media.filename ?? 'file'}>
      <FileIcon />
      {media.filename ?? 'Download file'}
    </a>
  );
}

interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** A checkbox item (aria-checked). */
  checked?: boolean;
}

/** A button with a small popup menu; closes on Escape, outside clicks and picking an item. */
function Menu({
  label,
  button,
  buttonClass,
  items,
  disabled,
  align = 'start',
  className = '',
}: {
  label: string;
  button: ReactNode;
  buttonClass: string;
  items: MenuItem[];
  disabled?: boolean;
  align?: 'start' | 'end';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (e: Event) => {
      if (wrap.current && !e.composedPath().includes(wrap.current)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const root = list.current?.getRootNode() as Document | ShadowRoot | undefined;
    const at = buttons.indexOf(root?.activeElement as HTMLButtonElement);
    const next = buttons[(at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length];
    next?.focus();
  };

  return (
    <div className={`ib-menu-wrap ${className}`} ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className={buttonClass}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {button}
      </button>
      {open && (
        <div
          ref={list}
          className={`ib-menu ib-menu--${align}`}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
        >
          {items.map((item) =>
            item.checked === undefined ? (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className="ib-menu-item"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitemcheckbox"
                aria-checked={item.checked}
                className="ib-menu-item"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <span className={`ib-check${item.checked ? ' ib-check--on' : ''}`} aria-hidden />
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
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
      className={`ib-filter${active ? ' ib-filter--on' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ── Helpers ────────────────────────────────────────────

type Item =
  | { type: 'message'; id: string; createdAt: string; message: InboxMessage }
  | { type: 'tools'; id: string; createdAt: string; calls: ToolCall[] };

/** Messages in order, with each run of tool calls folded into one item. */
function groupMessages(messages: InboxMessage[]): Item[] {
  const items: Item[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      if (!m.data?.tool) continue;
      const call = { id: m.id, createdAt: m.createdAt, tool: m.data.tool };
      const last = items.at(-1);
      if (last?.type === 'tools') last.calls.push(call);
      else items.push({ type: 'tools', id: m.id, createdAt: m.createdAt, calls: [call] });
      continue;
    }
    items.push({ type: 'message', id: m.id, createdAt: m.createdAt, message: m });
  }
  return items;
}

type Kind = 'customer' | 'ai' | 'team' | 'app';

function kindOf(m: InboxMessage): Kind {
  if (m.role === 'user') return 'customer';
  if (m.data?.team) return 'team';
  if (m.data?.context) return 'app';
  return 'ai';
}

/** Same sender within a few minutes: the label isn't repeated. */
function continues(previous: Item | undefined, item: Item): boolean {
  if (previous?.type !== 'message' || item.type !== 'message') return false;
  if (previous.message.role === 'system' || item.message.role === 'system') return false;
  const gap = new Date(item.createdAt).getTime() - new Date(previous.createdAt).getTime();
  return kindOf(previous.message) === kindOf(item.message) && gap < 5 * 60_000;
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

/** The customer's name, and their number or chat id when there is a name to show first. */
function who(c: Pick<InboxConversation, 'conversationId' | 'channel' | 'name'>): {
  name: string;
  detail: string | null;
} {
  const id = c.conversationId.slice(c.channel.length + 1);
  if (c.channel === 'whatsapp') {
    const number = /^\d+$/.test(id) ? `+${id}` : 'Number not shared';
    return c.name ? { name: c.name, detail: number } : { name: number, detail: null };
  }
  if (c.channel === 'web') return { name: c.name ?? 'Website visitor', detail: `Chat ${id.slice(0, 8)}` };
  return { name: c.name ?? c.conversationId, detail: null };
}

export function displayName(c: Pick<InboxConversation, 'conversationId' | 'channel' | 'name'>): string {
  const { name, detail } = who(c);
  return detail ? `${name} (${detail})` : name;
}

function initials(c: InboxConversation): string | null {
  const words = (c.name ?? '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length)
    return words
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('');
  return null;
}

/**
 * The text as the team reads it: without the "[Image]" / "[Voice note]" label when the media is
 * shown right above, or the "[Automated System Message]" tag when the bubble already says who sent it.
 */
function shownText(text: string, hasMedia: boolean): string {
  let t = text.replace(/^\[Automated System Message\]\s*/i, '');
  if (hasMedia) t = t.replace(/^\[(Image|Voice note|Video|Document|Sticker)\]\s*/, '');
  return t;
}

function channelLabel(channel: string): string {
  return channel === 'whatsapp' ? 'WhatsApp' : channel === 'web' ? 'Website' : channel;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Days from today: 0 today, 1 yesterday, -1 tomorrow. */
function daysAgo(date: Date): number {
  return Math.round((startOfDay(new Date()) - startOfDay(date)) / DAY_MS);
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function listTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  const days = daysAgo(date);
  if (days === 0) return clock(iso);
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const days = daysAgo(date);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** "6:30 pm", "tomorrow 9:00 am" or "14 Nov, 9:00 am". */
function untilLabel(iso: string): string {
  const date = new Date(iso);
  const days = daysAgo(date);
  if (days === 0) return clock(iso);
  if (days === -1) return `tomorrow ${clock(iso)}`;
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${clock(iso)}`;
}

function durationLeft(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/** Tool results are often JSON on one line; indented they can be read. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Only http(s) links; anything else (javascript:, data:) becomes a dead link. */
function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : '#';
}

function isTouch(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the choice lasts until reload.
  }
}
