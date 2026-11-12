// inbox.js: your team's inbox, for agentdesk's own /inbox page or inside your admin:
//   <script src="https://chat.example.com/inbox.js"></script>
//   AgentDeskInbox.mount(document.getElementById('inbox'), { token: () => fetchStaffToken() });
// Draws in a shadow root; your panel (options.panel) renders in your page, styled by your CSS.

import { createRoot } from 'react-dom/client';
import type { InboxConversation } from './api';
import { InboxApi } from './api';
import { Inbox, type InboxAction } from './Inbox';
import css from './inbox.css';

export interface InboxOptions {
  /** The agentdesk server. Defaults to where inbox.js was loaded from. */
  server?: string;
  /** A bearer token for the admin API: a staff token your server signs (see docs/inbox.md). Called before each request. */
  token: () => string | Promise<string>;
  /** Send team replies your own way (e.g. a template outside WhatsApp's 24-hour window). */
  onSend?: (conversation: InboxConversation, text: string) => Promise<void>;
  /** Buttons in the chat header. */
  actions?: InboxAction[];
  /** Your side panel for the open chat: draw into `element`; return a cleanup function if needed. */
  // biome-ignore lint/suspicious/noConfusingVoidType: a host's panel may return nothing or a cleanup function.
  panel?: (conversation: InboxConversation | null, element: HTMLElement) => void | (() => void);
  /** CSS variables without the `--ib-` prefix, e.g. `primary: "#0f172a"`. */
  theme?: Record<string, string>;
  /** Open this chat first, e.g. "whatsapp:919876543210". */
  conversation?: string;
}

const script = document.currentScript as HTMLScriptElement | null;
const defaultServer = script?.src ? new URL(script.src).origin : location.origin;

function mount(element: HTMLElement, options: InboxOptions) {
  const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  const container = document.createElement('div');
  container.style.height = '100%';
  shadow.replaceChildren(style, container);
  for (const [name, value] of Object.entries(options.theme ?? {}))
    element.style.setProperty(`--ib-${name}`, value);

  // Your panel lives in your page (light DOM), shown through the inbox's <slot name="panel">.
  let panelElement: HTMLElement | null = null;
  let cleanup: (() => void) | undefined;
  if (options.panel) {
    panelElement = document.createElement('div');
    panelElement.slot = 'panel';
    element.appendChild(panelElement);
  }
  const onSelect = (conversation: InboxConversation | null) => {
    if (!options.panel || !panelElement) return;
    cleanup?.();
    cleanup = options.panel(conversation, panelElement) || undefined;
  };

  const api = new InboxApi(options.server ?? defaultServer, options.token);
  const root = createRoot(container);
  root.render(
    <Inbox
      api={api}
      onSend={options.onSend}
      actions={options.actions}
      onSelect={onSelect}
      hasPanel={Boolean(options.panel)}
      initialConversation={options.conversation}
    />,
  );
  return {
    unmount() {
      cleanup?.();
      root.unmount();
      panelElement?.remove();
    },
  };
}

declare global {
  interface Window {
    AgentDeskInbox: { mount: typeof mount };
  }
}

window.AgentDeskInbox = { mount };
