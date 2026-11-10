import type { ActionDef } from "@/lib/keymap/registry"

// The Mounts section's keys (desktop app). Stepping walks the sidebar's pages in order; the switch of the page on
// screen ships unset, as no chord says "turn on".
export const MOUNTS_ACTIONS: readonly ActionDef[] = [
	{ id: "mounts.previousRole", defaultCombo: "alt+arrowup", scope: "mounts", descriptionKey: "mounts:mountsCommandPreviousRole" },
	{ id: "mounts.nextRole", defaultCombo: "alt+arrowdown", scope: "mounts", descriptionKey: "mounts:mountsCommandNextRole" },
	{ id: "mounts.toggleRole", defaultCombo: "", scope: "mounts", descriptionKey: "mounts:mountsCommandToggleRole" }
]
