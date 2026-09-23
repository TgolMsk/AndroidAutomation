import type { SVGProps } from 'react';

/** Simple 24×24 stroke icons (hand-drawn geometric paths, currentColor). */
const PATHS = {
  plus: 'M12 5v14M5 12h14',
  play: 'M7 4.5v15l12-7.5z',
  stop: 'M6.5 6.5h11v11h-11z',
  restart: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5',
  screen: 'M3 5h18v11H3zM8 20h8M12 16v4',
  cast: 'M4 6h16v12h-5M4 14a4 4 0 0 1 4 4M4 10a8 8 0 0 1 8 8M4 18h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-1.7 1l-.3 2h-4l-.3-2a7 7 0 0 1-1.7-1l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-3L3.2 9.3l2-3.4 1.9.7a7 7 0 0 1 1.7-1l.3-2h4l.3 2a7 7 0 0 1 1.7 1l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 3z',
  script: 'M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14',
  package: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4.5h-4.5',
  back: 'M15 5l-7 7 7 7',
  home: 'M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z',
  recents: 'M6 6h12v12H6z',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  close: 'M6 6l12 12M18 6L6 18',
  folder: 'M3 6h6l2 2h10v11H3z',
  terminal: 'M4 5h16v14H4zM7.5 9.5L10 12l-2.5 2.5M12.5 15H16',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  log: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  rocket: 'M12 15l-3-3c1.5-4.5 5-8 10-8 0 5-3.5 8.5-8 10zM9 12H5l2.5-3.5H11M12 15v4l3.5-2.5V13M6 18c-1 0-2 1-2 2 1 0 2-1 2-2z',
  alert: 'M12 4l9 16H3zM12 10v4.5M12 17.5h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01',
  download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14',
  chip: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  memory: 'M3 8h18v8H3zM7 16v3M11 16v3M15 16v3M7 11h2v2H7zM11 11h2v2h-2zM15 11h2v2h-2z',
  gauge: 'M4 16a8 8 0 1 1 16 0M12 16l4-5',
  layers: 'M12 4l9 5-9 5-9-5zM3 14l9 5 9-5',
  android:
    'M7 10h10v7a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1zM7 9a5 5 0 0 1 10 0zM8.5 4.5l1.3 2M15.5 4.5l-1.3 2M10 7.5h.01M14 7.5h.01M5 11v5M19 11v5M10 18v2.5M14 18v2.5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  power: 'M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  pin: 'M9 3h6M10 3v6l-3.5 4h11L14 9V3M12 13v8',
} as const;

export type IconName = keyof typeof PATHS;

const FILLED: ReadonlySet<IconName> = new Set<IconName>(['play', 'stop']);

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const filled = FILLED.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 1.2 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
