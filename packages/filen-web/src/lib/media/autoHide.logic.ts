// When a player's floating controls show. They hide only while playback runs untouched; anything that
// needs them (a pause, the end, a stall, a pointer or keyboard user, an open menu, a drag) brings them back.

export const CONTROLS_IDLE_MS = 2500

export interface ControlsVisibility {
	paused: boolean
	waiting: boolean
	// A pointer moved over the player within CONTROLS_IDLE_MS.
	pointerActive: boolean
	// Keyboard focus is on one of the controls.
	keyboardFocus: boolean
	menuOpen: boolean
	scrubbing: boolean
}

export function controlsVisible(state: ControlsVisibility): boolean {
	return state.paused || state.waiting || state.pointerActive || state.keyboardFocus || state.menuOpen || state.scrubbing
}

// Reports activity, then idleness once CONTROLS_IDLE_MS pass without another poke. Only the edges are
// reported, so a pointer moving continuously costs a timer reset per event and nothing else.
export class IdleTimer {
	private timer: ReturnType<typeof setTimeout> | null = null
	private active = false
	private readonly onChange: (active: boolean) => void
	private readonly delayMs: number

	public constructor(onChange: (active: boolean) => void, delayMs: number) {
		this.onChange = onChange
		this.delayMs = delayMs
	}

	public poke(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer)
		}

		this.timer = setTimeout(() => {
			this.timer = null
			this.set(false)
		}, this.delayMs)

		this.set(true)
	}

	// Idle at once: the pointer left the player.
	public idle(): void {
		this.stop()
		this.set(false)
	}

	public stop(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer)
			this.timer = null
		}
	}

	private set(active: boolean): void {
		if (this.active !== active) {
			this.active = active
			this.onChange(active)
		}
	}
}
