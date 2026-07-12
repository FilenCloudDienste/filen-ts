// Per-sender name coloring for group-chat message headers (the Discord signal that distinguishes who
// said what at a glance). A curated, fixed palette of hex colors — NOT the chart tokens — each verified
// to clear a WCAG bold-text contrast ratio (>= 3:1) against BOTH the light (#ffffff) and dark
// (oklch(0.24 0 0) ≈ #1f1f1f) --background values, so a colored name stays legible in either theme.
// 16 entries so a group chat of 10+ distinct senders still mostly lands on different colors.
export const NAME_COLOR_PALETTE: readonly string[] = [
	"#c0392b", // red
	"#d35400", // orange
	"#b9770e", // gold
	"#8a6d3b", // brown
	"#7f8c00", // olive
	"#5a7d2a", // moss
	"#4d7c0f", // lime
	"#15803d", // forest
	"#0f9d78", // teal-green
	"#0e8a8a", // teal
	"#0e7490", // cyan
	"#1f7fbf", // blue
	"#2f6fd8", // indigo
	"#7d5fff", // violet
	"#9333ea", // purple
	"#c0396b" // pink
]

// Deterministic FNV-1a string hash → a palette bucket. Same seed always maps to the same color, across
// reloads and sessions (the seed is the stable numeric senderId, not a mutable nickname). Kept unsigned
// via `>>> 0` so the modulo is always a non-negative index.
function hashSeed(seed: string): number {
	let hash = 0x811c9dc5

	for (let i = 0; i < seed.length; i++) {
		hash ^= seed.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}

	return hash >>> 0
}

// Resolve a sender's name color. Returns undefined in a 1:1 chat — coloring only carries meaning when
// there are 3+ possible authors, so a direct conversation keeps the single default foreground color
// (the caller applies no inline color when this is undefined).
export function senderNameColor(seed: string, oneToOne: boolean): string | undefined {
	if (oneToOne) {
		return undefined
	}

	return NAME_COLOR_PALETTE[hashSeed(seed) % NAME_COLOR_PALETTE.length]
}
