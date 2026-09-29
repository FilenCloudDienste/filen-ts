import { LOOP_MODES, type LoopMode } from "@/features/audio/store/audioQueue"

// The loop-toggle cycle: off → all → one → off (mobile parity).
export function nextLoopMode(mode: LoopMode): LoopMode {
	return LOOP_MODES[(LOOP_MODES.indexOf(mode) + 1) % LOOP_MODES.length] ?? "off"
}
