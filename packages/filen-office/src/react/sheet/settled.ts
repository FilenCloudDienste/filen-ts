// A command whose answer the caller needs nothing from: a refusal reaches onRefusal, a session that closed or died
// its "failed" event; the rejection is not left unhandled.
export function settled(promise: Promise<unknown>): void {
	promise.then(undefined, () => undefined)
}
