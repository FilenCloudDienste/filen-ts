import { type Type } from "arktype"
import { kvPreference } from "@/lib/storage/preference"
import { log } from "@/lib/log"

export interface PreloadedPreference<T> {
	// The value held now: the stored one once boot read it (preloadDevicePreferences), the fallback before.
	get: () => T
	// For useSyncExternalStore with `get`.
	subscribe: (listener: () => void) => () => void
	// Shown at once; stored in the background (a failed write is logged and the value holds for this session).
	set: (next: T) => void
	// Reads the stored value once; never rejects (an unreadable one leaves the fallback).
	load: () => Promise<void>
}

// A kv-backed preference held in memory, read during boot before anything renders (lib/sdk/boot.ts), so a first
// render reads the user's value synchronously and never a default that a later read replaces.
export function preloadedPreference<T>({
	key,
	schema,
	fallback,
	scope,
	same
}: {
	key: string
	schema: Type<T>
	fallback: T
	scope: string
	same: (a: T, b: T) => boolean
}): PreloadedPreference<T> {
	const preference = kvPreference({ key, schema, fallback })
	const listeners = new Set<() => void>()
	let value = fallback
	let loading: Promise<void> | null = null

	function notify(): void {
		for (const listener of listeners) {
			listener()
		}
	}

	function subscribe(listener: () => void): () => void {
		listeners.add(listener)

		return () => {
			listeners.delete(listener)
		}
	}

	function get(): T {
		return value
	}

	return {
		get,
		subscribe,
		set: next => {
			if (same(next, value)) {
				return
			}

			value = next
			notify()
			preference.set(next).catch((error: unknown) => {
				log.warn(scope, "preference not saved", { key, error })
			})
		},
		load: () => {
			loading ??= preference.get().then(
				stored => {
					if (!same(stored, value)) {
						value = stored
						notify()
					}
				},
				(error: unknown) => {
					log.warn(scope, "preference not read", { key, error })
				}
			)

			return loading
		}
	}
}
