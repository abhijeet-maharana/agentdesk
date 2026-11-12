import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { formatText, splitBubbles } from './format';
import { CloseIcon, MicIcon, MicOffIcon, PhoneOffIcon, SendIcon } from './icons';
import type { AgentChatChip, AgentChatEvent, AgentChatMessage, AgentChatTransport, Card } from './types';
import { useAgentChat } from './use-agent-chat';
import { useVoiceCall, type VoiceStatus } from './use-voice-call';

export interface AgentChatProps {
  transport: AgentChatTransport;
  title: string;
  subtitle?: string;
  avatar?: ReactNode;
  /** First bubble, shown before the customer writes anything (not stored). */
  greeting: string;
  /** Added to the greeting when voice calls are available. */
  voiceHint?: string;
  /** Quick-start buttons on an empty chat; each sends its `text`. */
  chips?: AgentChatChip[];
  placeholder?: string;
  /** Extra buttons in the header (e.g. "Continue on WhatsApp"). */
  headerActions?: ReactNode;
  /** Shown under a reply that asks the customer to log in; `send` continues the chat afterwards. */
  renderLogin?: (ctx: { send: (text: string) => void }) => ReactNode;
  onClose?: () => void;
  /** Polls only while true (e.g. while the popup is open). */
  active?: boolean;
  variant?: 'popup' | 'page';
  currency?: string;
  /** Note under messages written by a person from your team. */
  teamLabel?: string;
  onEvent?: (event: AgentChatEvent, props?: Record<string, unknown>) => void;
}

const STATUS_TEXT: Partial<Record<VoiceStatus, string>> = {
  starting: 'Starting…',
  connecting: 'Connecting…',
  listening: 'Listening',
  speaking: 'Speaking',
  reconnecting: 'Reconnecting…',
  saving: 'Saving the call…',
};

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function AgentChat({
  transport,
  title,
  subtitle,
  avatar,
  greeting,
  voiceHint,
  chips = [],
  placeholder = 'Type your message…',
  headerActions,
  renderLogin,
  onClose,
  active = true,
  variant = 'popup',
  currency = '$',
  teamLabel = 'Support team',
  onEvent,
}: AgentChatProps) {
  const chat = useAgentChat(transport, active);
  const voice = useVoiceCall(transport, { onSaved: () => void chat.refresh(), onEvent });
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const messages = [...chat.messages, ...voice.turns];
  const canVoice = Boolean(transport.voice) && chat.voiceAvailable;
  const voiceBusy = voice.status !== 'idle';
  const lastLoginId = [...messages].reverse().find((m) => m.login)?.id;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, voice.turns.at(-1)?.text, chat.typing]);

  const submit = (text: string) => {
    if (!text.trim() || voiceBusy) return;
    void chat.send(text);
    setDraft('');
    onEvent?.('message_sent');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit(draft);
    }
  };

  const error = voice.error ?? chat.error;

  return (
    <section className={`ac-chat ac-chat--${variant}`} aria-label={title}>
      <header className="ac-header">
        {avatar && <div className="ac-avatar">{avatar}</div>}
        <div className="ac-heading">
          <h2 className="ac-title">{title}</h2>
          {subtitle && <p className="ac-subtitle">{subtitle}</p>}
        </div>
        <div className="ac-header-actions">
          {headerActions}
          {onClose && (
            <button type="button" className="ac-icon-btn" onClick={onClose} aria-label="Close chat">
              <CloseIcon />
            </button>
          )}
        </div>
      </header>

      <div className="ac-list" ref={listRef} role="log" aria-live="polite">
        <Bubble from="assistant" text={canVoice && voiceHint ? `${greeting} ${voiceHint}` : greeting} />
        {chat.loaded && messages.length === 0 && chips.length > 0 && (
          <div className="ac-chips">
            {chips.map((chip) => (
              <button
                key={chip.id}
                type="button"
                className="ac-chip"
                disabled={voiceBusy}
                onClick={() => {
                  onEvent?.('chip_clicked', { chip: chip.id });
                  submit(chip.text);
                }}
              >
                {chip.icon && <span className="ac-chip-icon">{chip.icon}</span>}
                {chip.label}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <Message
            key={m.id}
            message={m}
            currency={currency}
            teamLabel={teamLabel}
            login={m.id === lastLoginId && renderLogin ? renderLogin({ send: submit }) : null}
          />
        ))}
        {chat.typing && (
          <div className="ac-row ac-row--assistant">
            <div className="ac-bubble ac-typing" role="status" aria-label="Typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="ac-error" role="alert">
          {error}
          <button
            type="button"
            onClick={() => (voice.error ? voice.setError(null) : chat.setError(null))}
            aria-label="Dismiss"
          >
            <CloseIcon />
          </button>
        </p>
      )}

      {voiceBusy ? (
        <div className="ac-voicebar">
          <span
            className={`ac-voice-dot ac-voice-dot--${voice.status}`}
            style={{ transform: `scale(${1 + Math.min(voice.level * 6, 0.8)})` }}
          />
          <span className="ac-voice-status">{STATUS_TEXT[voice.status] ?? ''}</span>
          {voice.maxSeconds > 0 && voice.inCall && (
            <span className="ac-voice-time">
              {clock(voice.elapsed)} / {clock(voice.maxSeconds)}
            </span>
          )}
          <button
            type="button"
            className="ac-icon-btn"
            onClick={voice.toggleMute}
            disabled={!voice.inCall}
            aria-label={voice.muted ? 'Unmute' : 'Mute'}
            aria-pressed={voice.muted}
          >
            {voice.muted ? <MicOffIcon /> : <MicIcon />}
          </button>
          <button type="button" className="ac-end-btn" onClick={voice.end} disabled={!voice.inCall}>
            <PhoneOffIcon /> End
          </button>
        </div>
      ) : (
        <form
          className="ac-composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
        >
          <textarea
            className="ac-input"
            rows={1}
            value={draft}
            maxLength={1000}
            placeholder={placeholder}
            aria-label="Message"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {canVoice && (
            <button
              type="button"
              className="ac-icon-btn ac-mic-btn"
              onClick={() => void voice.start()}
              aria-label="Talk to us (voice call)"
              title="Talk (voice call)"
            >
              <MicIcon />
            </button>
          )}
          <button type="submit" className="ac-send-btn" disabled={!draft.trim()} aria-label="Send">
            <SendIcon />
          </button>
        </form>
      )}
    </section>
  );
}

function Bubble({ from, text, note }: { from: 'user' | 'assistant'; text: string; note?: string }) {
  return (
    <>
      {splitBubbles(text).map((part, i) => (
        <div key={i} className={`ac-row ac-row--${from}`}>
          <div className="ac-bubble">{formatText(part)}</div>
        </div>
      ))}
      {note && <div className={`ac-note ac-note--${from}`}>{note}</div>}
    </>
  );
}

function Message({
  message: m,
  currency,
  teamLabel,
  login,
}: {
  message: AgentChatMessage;
  currency: string;
  teamLabel: string;
  login: ReactNode;
}) {
  const note = m.voice ? '🎙 voice' : m.team ? teamLabel : m.pending ? 'Sending…' : undefined;
  return (
    <>
      {m.text && <Bubble from={m.role} text={m.text} note={note} />}
      {m.cards && m.cards.length > 0 && (
        <div className="ac-products">
          {m.cards.map((card) => (
            <CardView key={card.id} card={card} currency={currency} />
          ))}
        </div>
      )}
      {m.links && m.links.length > 0 && (
        <div className="ac-links">
          {m.links.map((url) => (
            <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="ac-link-chip">
              {url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}
            </a>
          ))}
        </div>
      )}
      {login && <div className="ac-login">{login}</div>}
    </>
  );
}

const money = (value: number | string, currency: string) =>
  typeof value === 'number' ? `${currency}${value}` : value;

function CardView({ card: c, currency }: { card: Card; currency: string }) {
  const crossed = c.originalPrice !== undefined && c.originalPrice !== c.price;
  return (
    <a className="ac-product" href={c.url} target="_blank" rel="noopener noreferrer">
      {c.image ? (
        <img src={c.image} alt="" loading="lazy" width={72} height={72} />
      ) : (
        <span className="ac-product-img" />
      )}
      <span className="ac-product-body">
        <span className="ac-product-title">{c.title}</span>
        {c.subtitle && <span className="ac-product-variant">{c.subtitle}</span>}
        {c.price !== undefined && (
          <span className="ac-product-price">
            {money(c.price, currency)}
            {crossed && <s>{money(c.originalPrice as number | string, currency)}</s>}
          </span>
        )}
      </span>
    </a>
  );
}
