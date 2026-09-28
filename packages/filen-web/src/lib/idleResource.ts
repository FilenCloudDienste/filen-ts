// A lazily created resource (a worker, typically) that is disposed once nothing has used it for
// `idleMs`, so a one-off burst of work does not keep its memory for the rest of the tab session. A
// later use simply creates a fresh one. Disposal only ever happens with no use in flight: tearing a
// worker down under a pending call would leave that call's promise unsettled forever.
export interface IdleResource<T> {
	use<R>(run: (resource: T) => Promise<R>): Promise<R>
	// Disposes now when idle; a resource still in use is disposed by its own idle timer instead.
	disposeIfIdle(): void
}

export function idleResource<T>(create: () => T, dispose: (resource: T) => void, idleMs: number): IdleResource<T> {
	let held: { value: T } | null = null
	let users = 0
	let timer: ReturnType<typeof setTimeout> | undefined

	function disposeIfIdle(): void {
		clearTimeout(timer)
		timer = undefined

		if (users > 0 || held === null) {
			return
		}

		const { value } = held

		held = null
		dispose(value)
	}

	async function use<R>(run: (resource: T) => Promise<R>): Promise<R> {
		clearTimeout(timer)
		timer = undefined
		// A throwing create() caches nothing, so the next use tries again.
		held ??= { value: create() }
		users++

		try {
			return await run(held.value)
		} finally {
			users--

			if (users === 0) {
				timer = setTimeout(disposeIfIdle, idleMs)
			}
		}
	}

	return { use, disposeIfIdle }
}
