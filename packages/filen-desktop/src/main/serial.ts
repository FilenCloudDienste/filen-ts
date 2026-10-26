// Runs operations one at a time, in call order; one that fails never holds back the next.
export function serialQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve()

	return operation => {
		const run = tail.then(operation, operation)

		tail = run.catch(() => undefined)

		return run
	}
}
