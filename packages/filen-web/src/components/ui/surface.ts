// Plain strings rather than @utility classes so tailwind-merge still resolves a caller's ring/rounded
// override against them (SettingsGroup's danger ring relies on it).

export const SURFACE_RING = "ring-1 ring-foreground/5 dark:ring-foreground/10"

export const SCRIM_CLASS =
	"fixed inset-0 isolate z-50 bg-black/30 duration-100 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"

export const CARD_SURFACE_CLASS = `overflow-hidden rounded-[min(var(--radius-4xl),24px)] bg-card text-sm text-card-foreground shadow-sm ${SURFACE_RING}`
