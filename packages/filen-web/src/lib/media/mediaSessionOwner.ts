// One page has one Media Session (lock screen, media keys, the OS overlay), and more than one player that
// wants it: the audio engine for the whole session, a video player while it is open. Each player writes
// through its own owner; only the topmost owner's writes reach the session. An owner that takes over
// silences the one below (its `onPreempt`, e.g. pausing the audio engine), and on release the owner below
// gets the session back as it last left it: metadata, playback state, position and action handlers.

export interface MediaSessionActionDetails {
	action: string
	seekTime?: number
	seekOffset?: number
	fastSeek?: boolean
}

export type MediaSessionHandler = ((details: MediaSessionActionDetails) => void) | null

export interface MediaPositionState {
	duration: number
	position: number
	playbackRate: number
}

// The subset of navigator.mediaSession used, structural so tests pass a fake.
export interface MediaSessionLike {
	metadata: unknown
	playbackState: string
	setActionHandler: (action: string, handler: MediaSessionHandler) => void
	setPositionState?: (state?: MediaPositionState) => void
}

export interface MediaSessionOwner extends MediaSessionLike {
	readonly name: string
	// Becomes the topmost owner (again, when it was below another).
	acquire: () => void
	// Leaves the stack; the owner below, if any, gets the session back.
	release: () => void
	readonly active: boolean
	setPositionState: (state?: MediaPositionState) => void
	// Replaces what runs when another owner takes the session over.
	setOnPreempt: (handler: (() => void) | undefined) => void
	// Method forms of the metadata and playbackState setters.
	setMetadata: (metadata: unknown) => void
	setPlaybackState: (state: string) => void
}

interface OwnerState {
	metadata: unknown
	playbackState: string
	handlers: Map<string, MediaSessionHandler>
	// undefined: never set; null: cleared.
	position: MediaPositionState | null | undefined
}

function applyHandler(session: MediaSessionLike, action: string, handler: MediaSessionHandler): void {
	try {
		session.setActionHandler(action, handler)
	} catch {
		// Chrome throws for actions it doesn't implement.
	}
}

function applyPosition(session: MediaSessionLike, position: MediaPositionState | null | undefined): void {
	if (typeof session.setPositionState !== "function") {
		return
	}

	try {
		if (position === null || position === undefined) {
			session.setPositionState()
		} else {
			session.setPositionState(position)
		}
	} catch {
		// Rejected values (a position past the duration) leave the previous state.
	}
}

export class MediaSessionOwners {
	private readonly session: MediaSessionLike | null
	private readonly stack: OwnerHandle[] = []
	// Every action any owner ever set, so a takeover clears the ones the new owner doesn't handle.
	private readonly actions = new Set<string>()

	public constructor(session: MediaSessionLike | null) {
		this.session = session
	}

	public create(name: string, options: { onPreempt?: () => void } = {}): MediaSessionOwner {
		return new OwnerHandle(this, name, options.onPreempt)
	}

	public top(): OwnerHandle | undefined {
		return this.stack.at(-1)
	}

	public isTop(owner: OwnerHandle): boolean {
		return this.top() === owner
	}

	public push(owner: OwnerHandle): void {
		const previous = this.top()

		if (previous === owner) {
			return
		}

		const at = this.stack.indexOf(owner)

		if (at !== -1) {
			this.stack.splice(at, 1)
		}

		this.stack.push(owner)
		this.restore(owner)
		previous?.preempted()
	}

	public remove(owner: OwnerHandle): void {
		const at = this.stack.indexOf(owner)

		if (at === -1) {
			return
		}

		const wasTop = at === this.stack.length - 1

		this.stack.splice(at, 1)

		if (!wasTop) {
			return
		}

		const next = this.top()

		if (next !== undefined) {
			this.restore(next)
		} else if (this.session !== null) {
			this.session.metadata = null
			this.session.playbackState = "none"

			for (const action of this.actions) {
				applyHandler(this.session, action, null)
			}

			applyPosition(this.session, null)
		}
	}

	public noteAction(action: string): void {
		this.actions.add(action)
	}

	public get target(): MediaSessionLike | null {
		return this.session
	}

	// Puts `owner`'s recorded state on the session.
	private restore(owner: OwnerHandle): void {
		const session = this.session

		if (session === null) {
			return
		}

		const state = owner.state

		session.metadata = state.metadata
		session.playbackState = state.playbackState

		for (const action of this.actions) {
			applyHandler(session, action, state.handlers.get(action) ?? null)
		}

		applyPosition(session, state.position)
	}
}

class OwnerHandle implements MediaSessionOwner {
	public readonly name: string
	public readonly state: OwnerState = { metadata: null, playbackState: "none", handlers: new Map(), position: undefined }
	private readonly owners: MediaSessionOwners
	private onPreempt: (() => void) | undefined

	public constructor(owners: MediaSessionOwners, name: string, onPreempt: (() => void) | undefined) {
		this.owners = owners
		this.name = name
		this.onPreempt = onPreempt
	}

	public get active(): boolean {
		return this.owners.isTop(this)
	}

	public acquire(): void {
		this.owners.push(this)
	}

	public release(): void {
		this.owners.remove(this)
	}

	public preempted(): void {
		this.onPreempt?.()
	}

	public setOnPreempt(handler: (() => void) | undefined): void {
		this.onPreempt = handler
	}

	public get metadata(): unknown {
		return this.state.metadata
	}

	public set metadata(value: unknown) {
		this.state.metadata = value

		const session = this.owners.target

		if (session !== null && this.active) {
			session.metadata = value
		}
	}

	public get playbackState(): string {
		return this.state.playbackState
	}

	public set playbackState(value: string) {
		this.state.playbackState = value

		const session = this.owners.target

		if (session !== null && this.active) {
			session.playbackState = value
		}
	}

	public setMetadata(metadata: unknown): void {
		this.metadata = metadata
	}

	public setPlaybackState(state: string): void {
		this.playbackState = state
	}

	public setActionHandler(action: string, handler: MediaSessionHandler): void {
		this.owners.noteAction(action)
		this.state.handlers.set(action, handler)

		const session = this.owners.target

		if (session !== null && this.active) {
			applyHandler(session, action, handler)
		}
	}

	public setPositionState(state?: MediaPositionState): void {
		this.state.position = state ?? null

		const session = this.owners.target

		if (session !== null && this.active) {
			applyPosition(session, this.state.position)
		}
	}
}

function liveSession(): MediaSessionLike | null {
	return typeof navigator !== "undefined" && "mediaSession" in navigator ? (navigator.mediaSession as unknown as MediaSessionLike) : null
}

export const mediaSessionOwners = new MediaSessionOwners(liveSession())
