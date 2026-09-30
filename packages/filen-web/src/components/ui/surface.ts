// Plain strings rather than @utility classes so tailwind-merge still resolves a caller's ring/rounded
// override against them (SettingsGroup's danger ring relies on it).

export const SURFACE_RING = "ring-1 ring-foreground/5 dark:ring-foreground/10"

// Translucent blurred surface for controls floating over content (chat composer, attach button, floating cards).
export const GLASS_SURFACE_CLASS = `bg-popover/70 shadow-sm ${SURFACE_RING} backdrop-blur-2xl backdrop-saturate-150`

export const SCRIM_CLASS =
	"fixed inset-0 isolate z-50 bg-black/30 duration-100 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"

export const CARD_SURFACE_CLASS = `overflow-hidden rounded-[min(var(--radius-4xl),24px)] bg-card text-sm text-card-foreground shadow-sm ${SURFACE_RING}`

// Shared by Input and SelectTrigger.
export const FIELD_CONTROL_CLASS =
	"rounded-2xl border border-transparent bg-input/50 focus-ring transition-[color,box-shadow] duration-200 outline-none focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"

export const INVALID_RING_CLASS =
	"aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40"
