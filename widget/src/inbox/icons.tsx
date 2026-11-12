// Inline icons for the inbox, so it has no icon-library dependency.
const svg = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const SearchIcon = () => (
  <svg {...svg}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);
export const BackIcon = () => (
  <svg {...svg}>
    <path d="M15 18 9 12l6-6" />
  </svg>
);
export const MoreIcon = () => (
  <svg {...svg}>
    <circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);
export const PauseIcon = () => (
  <svg {...svg}>
    <path d="M9 5v14M15 5v14" />
  </svg>
);
export const PlayIcon = () => (
  <svg {...svg}>
    <path d="M7 5v14l11-7Z" fill="currentColor" />
  </svg>
);
export const ToolIcon = () => (
  <svg {...svg}>
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8V20h3.2l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.3-.7-.7-2.3Z" />
  </svg>
);
export const PersonIcon = () => (
  <svg {...svg}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </svg>
);
export const AppIcon = () => (
  <svg {...svg}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18" />
  </svg>
);
export const SparkIcon = () => (
  <svg {...svg}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
  </svg>
);
export const DownIcon = () => (
  <svg {...svg}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </svg>
);
export const FileIcon = () => (
  <svg {...svg}>
    <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z" />
    <path d="M14 3v5h5" />
  </svg>
);
export const GlobeIcon = () => (
  <svg {...svg} width={10} height={10} strokeWidth={2.6}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </svg>
);
export const WaGlyph = () => (
  <svg {...svg} width={10} height={10} strokeWidth={2.6}>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
  </svg>
);
export const ChatsIcon = () => (
  <svg {...svg} width={40} height={40} strokeWidth={1.5}>
    <path d="M21 11.5a7.5 7.5 0 0 1-10.9 6.7L5 19.5l1.2-4.3A7.5 7.5 0 1 1 21 11.5Z" />
  </svg>
);

export function StarIcon({
  filled,
  className,
  label,
}: {
  filled?: boolean;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      {...svg}
      className={className}
      fill={filled ? 'currentColor' : 'none'}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z" />
    </svg>
  );
}
