// The script your site loads: <script src="https://chat.example.com/widget.js" async></script>.
// Draws the chat inside a shadow root, so your page's CSS and the widget's never mix.

import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AgentChat, type AgentChatProps } from './AgentChat';
import { AgentChatLauncher } from './AgentChatLauncher';
import css from './agent-chat.css';
import { LinkIcon, MailIcon, PhoneIcon, WhatsAppIcon } from './icons';
import {
  conversationId,
  createTransport,
  fetchWidgetConfig,
  type IdentityProvider,
  type ServerWidgetConfig,
} from './transport';
import type { AgentChatEvent, AgentChatTransport } from './types';

export interface AgentDeskOptions {
  /** The agentdesk server. Defaults to where widget.js was loaded from. */
  server?: string;
  /** Your visitor's identity token (a JWT your server signs), or null for a guest. Called before each request. */
  identity?: IdentityProvider;
  /** Show your own login when the agent asks for it. Resolve true once the visitor is logged in. */
  onLogin?: () => boolean | undefined | Promise<boolean | undefined>;
  /** For your analytics: open, close, message_sent, chip_clicked, login_clicked, voice_*. */
  onEvent?: (event: AgentChatEvent, props?: Record<string, unknown>) => void;
  /** Replace the server's quick-start chips on this page. */
  chips?: Array<{ id: string; label: string; text: string }>;
  greeting?: string;
  /** CSS variables without the `--ac-` prefix, on top of the server's theme. */
  theme?: Record<string, string>;
  /** Draw the chat as a full page inside this element instead of the floating button. */
  container?: HTMLElement | string;
  /** Hide the floating button (e.g. on pages that show the chat in `container`). */
  hideLauncher?: boolean;
}

interface Mount {
  host: HTMLElement;
  root: Root;
}

const script = document.currentScript as HTMLScriptElement | null;
const defaultServer = script?.src ? new URL(script.src).origin : location.origin;

let options: AgentDeskOptions = {};
let server = defaultServer;
let serverConfig: ServerWidgetConfig | null = null;
let transport: AgentChatTransport | null = null;
let isOpen = false;
let launcher: Mount | null = null;
let page: Mount | null = null;

const HEADER_ICONS = { whatsapp: WhatsAppIcon, phone: PhoneIcon, mail: MailIcon, link: LinkIcon };

function createMount(parent: HTMLElement, fixed: boolean): Mount {
  const host = document.createElement('div');
  host.setAttribute('data-agentdesk', fixed ? 'launcher' : 'page');
  if (fixed) host.style.setProperty('--ac-z', '2147483000');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  const mountPoint = document.createElement('div');
  shadow.append(style, mountPoint);
  parent.appendChild(host);
  return { host, root: createRoot(mountPoint) };
}

function applyTheme(host: HTMLElement): void {
  for (const [name, value] of Object.entries({ ...serverConfig?.theme, ...options.theme })) {
    host.style.setProperty(`--ac-${name}`, value);
  }
}

function LoginButton({ send }: { send: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="ac-login-btn"
      disabled={busy}
      onClick={async () => {
        options.onEvent?.('login_clicked');
        setBusy(true);
        try {
          if (await options.onLogin?.()) send('I have logged in.');
        } finally {
          setBusy(false);
        }
      }}
    >
      Log in
    </button>
  );
}

function chatProps(cfg: ServerWidgetConfig, chatTransport: AgentChatTransport): AgentChatProps {
  return {
    transport: chatTransport,
    title: cfg.title,
    subtitle: cfg.subtitle,
    avatar: cfg.avatarUrl ? <img src={cfg.avatarUrl} alt="" width={38} height={38} /> : undefined,
    greeting: options.greeting ?? cfg.greeting,
    voiceHint: cfg.voiceHint,
    chips: options.chips ?? cfg.chips,
    placeholder: cfg.placeholder,
    currency: cfg.currency,
    teamLabel: cfg.teamLabel,
    headerActions: cfg.headerLinks.map((link) => {
      const Icon = HEADER_ICONS[link.icon];
      return (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="ac-icon-btn"
          aria-label={link.label}
          title={link.label}
        >
          <Icon />
        </a>
      );
    }),
    renderLogin: cfg.login && options.onLogin ? ({ send }) => <LoginButton send={send} /> : undefined,
    onEvent: options.onEvent,
  };
}

function setOpen(open: boolean): void {
  if (open === isOpen) return;
  isOpen = open;
  options.onEvent?.(open ? 'open' : 'close');
  render();
}

function render(): void {
  if (!serverConfig || !transport) return;
  const props = chatProps(serverConfig, transport);

  const container =
    typeof options.container === 'string'
      ? document.querySelector<HTMLElement>(options.container)
      : options.container;
  if (page && (!container || !container.contains(page.host))) {
    page.root.unmount();
    page.host.remove();
    page = null;
  }
  if (container) {
    page ??= createMount(container, false);
    applyTheme(page.host);
    page.root.render(<AgentChat {...props} variant="page" />);
  }

  if (options.hideLauncher || container) {
    launcher?.root.render(null);
    return;
  }
  launcher ??= createMount(document.body, true);
  applyTheme(launcher.host);
  launcher.root.render(
    <AgentChatLauncher
      {...props}
      open={isOpen}
      onOpenChange={setOpen}
      launcherLabel={serverConfig.launcherLabel}
    />,
  );
}

const api = {
  /** Starts the widget (or changes its options). Called by itself unless the script tag has `data-manual`. */
  async init(next: AgentDeskOptions = {}): Promise<void> {
    options = { ...options, ...next };
    const nextServer = (options.server ?? defaultServer).replace(/\/$/, '');
    if (!serverConfig || nextServer !== server) {
      server = nextServer;
      serverConfig = await fetchWidgetConfig(server);
      transport = null;
    }
    transport ??= createTransport(server, conversationId(server), () => options.identity?.());
    render();
  },
  open: () => setOpen(true),
  close: () => setOpen(false),
  /** Starts a new conversation, e.g. when the visitor signs out, so the next person can't read it. */
  reset(): void {
    transport = createTransport(server, conversationId(server, true), () => options.identity?.());
    render();
  },
};

declare global {
  interface Window {
    AgentDesk: typeof api;
    agentdeskSettings?: AgentDeskOptions;
  }
}

window.AgentDesk = api;
if (!script?.hasAttribute('data-manual')) {
  void api.init(window.agentdeskSettings).catch((error: unknown) => console.error('[agentdesk]', error));
}
