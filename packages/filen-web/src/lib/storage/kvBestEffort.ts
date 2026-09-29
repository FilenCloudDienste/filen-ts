import type { Type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { log } from "@/lib/log"

// Best-effort kv for state that is a nicety, never a blocker: a storage failure is logged and swallowed
// so the feature keeps working on its defaults. Kept out of adapter.ts because tests replace that module
// wholesale; living here, these helpers run against whatever kvGetJson/kvSetJson the test supplies.

// A memoized one-shot load: the read fires at most once per returned loader, and `apply` only ever sees
// a stored, schema-valid value.
export function kvLoadOnce<T>(key: string, schema: Type<T>, apply: (value: T) => void, scope: string, what: string): () => Promise<void> {
	let load: Promise<void> | null = null

	return () => {
		load ??= kvGetJson(key, schema)
			.then(value => {
				if (value !== null) {
					apply(value)
				}
			})
			.catch((error: unknown) => {
				log.warn(scope, `failed to load persisted ${what}`, error)
			})

		return load
	}
}

export async function kvSetJsonQuiet(key: string, value: unknown, scope: string, what: string): Promise<void> {
	try {
		await kvSetJson(key, value)
	} catch (error) {
		log.warn(scope, `failed to persist ${what}`, error)
	}
}
