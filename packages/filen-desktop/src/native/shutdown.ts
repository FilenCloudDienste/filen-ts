// What a host shutdown closes: the engine (whose close waits for a transfer in flight and releases the account's
// drive-write lock), rclone, and an engine still opening, which is closed once it opened.
interface Closable {
	close(): Promise<void>
}

export interface ShutdownTargets {
	// The engine open in flight, if any: resolves to the engine it opened, or null when it failed.
	opening(): Promise<Closable | null> | null
	engine(): Closable | null
	mounts(): { shutdown(): Promise<void> } | null
}

// Closes everything, waiting at most `timeoutMs` in all; true when everything closed in time. A close that fails is
// logged and counts as closed: the host exits either way.
export async function closeWithin(
	targets: ShutdownTargets,
	timeoutMs: number,
	log: { warn(message: string): void; describe(error: unknown): string }
): Promise<boolean> {
	const closing = (async () => {
		const stopping = targets
			.mounts()
			?.shutdown()
			.catch((error: unknown) => {
				log.warn(`rclone stop failed: ${log.describe(error)}`)
			})

		// An engine that opens while the host shuts down holds the baseline and may already lock: close it too.
		const opened = await targets.opening()
		const engine = opened ?? targets.engine()

		await Promise.all([
			stopping,
			engine?.close().catch((error: unknown) => {
				log.warn(`engine close failed: ${log.describe(error)}`)
			})
		])
	})()
	let timer: NodeJS.Timeout | undefined

	const closed = await Promise.race([
		closing.then(() => true),
		new Promise<false>(resolve => {
			timer = setTimeout(() => {
				resolve(false)
			}, timeoutMs)
		})
	])

	clearTimeout(timer)

	if (!closed) {
		log.warn("engine close or rclone stop timed out")
	}

	return closed
}
