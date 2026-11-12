import { type ReactNode, useEffect } from 'react';
import { AgentChat, type AgentChatProps } from './AgentChat';
import { ChatIcon, CloseIcon } from './icons';

export interface AgentChatLauncherProps extends Omit<AgentChatProps, 'onClose' | 'active' | 'variant'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Text next to the round button (hidden on small screens). */
  launcherLabel?: string;
  launcherIcon?: ReactNode;
}

/** A round chat button fixed to the bottom right that opens the chat as a popup (full screen on phones). */
export function AgentChatLauncher({
  open,
  onOpenChange,
  launcherLabel,
  launcherIcon,
  onEvent,
  ...chat
}: AgentChatLauncherProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onOpenChange(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  return (
    <div className="ac-launcher">
      {open && (
        <div className="ac-popup">
          <AgentChat
            {...chat}
            onEvent={onEvent}
            active={open}
            variant="popup"
            onClose={() => onOpenChange(false)}
          />
        </div>
      )}
      <button
        type="button"
        className={`ac-fab ${open ? 'ac-fab--open' : ''}`}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-label={open ? 'Close chat' : (launcherLabel ?? 'Open chat')}
      >
        {open ? <CloseIcon /> : (launcherIcon ?? <ChatIcon />)}
        {!open && launcherLabel && <span className="ac-fab-label">{launcherLabel}</span>}
      </button>
    </div>
  );
}
