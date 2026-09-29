import { type Type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"

export interface KvPreference<T> {
	get: () => Promise<T>
	set: (next: T) => Promise<void>
}

// A single kv-backed preference. kvGetJson collapses "absent" and "schema-invalid" to null, so the
// fallback is the self-heal for both. `normalize` (e.g. a clamp) runs on every stored read and every
// write, so a value persisted before its bounds changed is corrected on the way out too.
export function kvPreference<T>({
	key,
	schema,
	fallback,
	normalize
}: {
	key: string
	schema: Type<T>
	fallback: T
	normalize?: (value: T) => T
}): KvPreference<T> {
	return {
		get: async () => {
			const stored = await kvGetJson(key, schema)

			if (stored === null) {
				return fallback
			}

			return normalize ? normalize(stored) : stored
		},
		set: async next => {
			await kvSetJson(key, normalize ? normalize(next) : next)
		}
	}
}
