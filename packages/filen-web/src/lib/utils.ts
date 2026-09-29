// A shared, named no-op — TS's fewer-params-is-assignable rule lets this satisfy any `(...) => void`
// callback signature (a required progress/step/dismiss callback a call site genuinely has nothing to
// do with), so callers never need their own throwaway `() => {}` literal (which
// @typescript-eslint/no-empty-function flags; a named declaration with a real comment body does not).
export function noop(): void {
	// Intentionally empty.
}

// `record` minus `key`; the same object when the key is absent, so a store update that removes nothing
// writes nothing new.
export function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
	if (!Object.hasOwn(record, key)) {
		return record
	}

	const next = { ...record }

	Reflect.deleteProperty(next, key)

	return next
}
