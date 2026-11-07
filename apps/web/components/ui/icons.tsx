import type { ReactNode, SVGProps } from "react";

/**
 * One small outline icon set (24px grid, 1.75 stroke, currentColor). Icons are decorative by default
 * (aria-hidden); pass `label` to expose one to assistive tech.
 */
function make(paths: ReactNode) {
  return function Icon({ size = 16, label, ...props }: SVGProps<SVGSVGElement> & { size?: number; label?: string }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden={label ? undefined : true}
        aria-label={label}
        role={label ? "img" : undefined}
        focusable="false"
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

export const IconPlus = make(<path d="M12 5v14M5 12h14" />);
export const IconCheck = make(<path d="M20 6 9 17l-5-5" />);
export const IconX = make(<path d="M18 6 6 18M6 6l12 12" />);
export const IconChevronDown = make(<path d="m6 9 6 6 6-6" />);
export const IconChevronRight = make(<path d="m9 6 6 6-6 6" />);
export const IconArrowRight = make(<path d="M5 12h14m-6-6 6 6-6 6" />);
export const IconArrowUpRight = make(<path d="M7 17 17 7M8 7h9v9" />);
export const IconDots = make(
  <>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </>,
);
export const IconInfo = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-4M12 8h.01" />
  </>,
);
export const IconHelp = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5M12 17.5h.01" />
  </>,
);
export const IconSliders = make(
  <>
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="17" r="2" />
  </>,
);
export const IconBrain = make(
  <>
    <path d="M12 5a3 3 0 0 0-5.7-1.3A3 3 0 0 0 4 9a3 3 0 0 0 .6 5.4A3.5 3.5 0 0 0 11 18V5Z" />
    <path d="M12 5a3 3 0 0 1 5.7-1.3A3 3 0 0 1 20 9a3 3 0 0 1-.6 5.4A3.5 3.5 0 0 1 13 18V5Z" />
  </>,
);
export const IconShield = make(
  <>
    <path d="M12 3 5 6v5c0 4.5 3 8.2 7 10 4-1.8 7-5.5 7-10V6l-7-3Z" />
    <path d="m9 12 2 2 4-4" />
  </>,
);
export const IconBolt = make(<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />);
export const IconTrophy = make(
  <>
    <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z" />
    <path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3" />
  </>,
);
export const IconChart = make(
  <>
    <path d="M3 3v18h18" />
    <path d="m7 15 4-4 3 3 5-6" />
  </>,
);
export const IconWallet = make(
  <>
    <path d="M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h14a1 1 0 0 1 1 1v3" />
    <path d="M3 6v12a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3" />
    <path d="M20 12h-3a2 2 0 0 0 0 4h3v-4Z" />
  </>,
);
export const IconFork = make(
  <>
    <circle cx="6" cy="5" r="2" />
    <circle cx="18" cy="5" r="2" />
    <circle cx="12" cy="19" r="2" />
    <path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5" />
  </>,
);
export const IconShare = make(
  <>
    <path d="M12 3v12M8 7l4-4 4 4" />
    <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
  </>,
);
export const IconSend = make(<path d="m21 3-9.5 18-2.2-7.8L2 11l19-8ZM9.3 13.2 21 3" />);
export const IconPlay = make(<path d="M7 4.5v15l12-7.5-12-7.5Z" />);
export const IconPause = make(
  <>
    <path d="M8 5v14M16 5v14" />
  </>,
);
export const IconCopy = make(
  <>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </>,
);
export const IconClock = make(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
);
export const IconUsers = make(
  <>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .6 3.3 2.4 3.5 5.2" />
  </>,
);
export const IconBot = make(
  <>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 8V4M9 13v1.5M15 13v1.5M2 14v2M22 14v2" />
  </>,
);
export const IconLock = make(
  <>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </>,
);
export const IconSettings = make(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </>,
);
export const IconBeaker = make(
  <>
    <path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2.2h12.4a1.5 1.5 0 0 0 1.3-2.2L14 9V3" />
    <path d="M7.5 15h9" />
  </>,
);
export const IconLink = make(
  <>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1" />
  </>,
);
export const IconSparkle = make(
  <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" />,
);
export const IconCoins = make(
  <>
    <circle cx="9" cy="9" r="6" />
    <path d="M18.1 10.4A6 6 0 1 1 10.4 18M9 6.5v5M7.5 9h3" />
  </>,
);
export const IconEye = make(
  <>
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);
