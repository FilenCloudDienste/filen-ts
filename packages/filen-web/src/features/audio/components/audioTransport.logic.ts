import type { LoopMode } from "@/features/audio/store/audioQueue"

// The loop-toggle cycle the bar + panel share: off → all → one → off (mobile parity). Pure so the
// toggle order is one source of truth across both surfaces.
export function nextLoopMode(mode: LoopMode): LoopMode {
	return mode === "off" ? "all" : mode === "all" ? "one" : "off"
}
