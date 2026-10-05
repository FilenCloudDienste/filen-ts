import { useEffect, useState } from "react"
import { type, type Type } from "arktype"
import { kvPreference, type KvPreference } from "@/lib/storage/preference"
import { log } from "@/lib/log"

// The last item opened per selection-keyed module, so the module's bare index route can reopen it —
// across reloads too. kv is per account and wiped on logout.
export type LastOpenedModule = "chats" | "notes" | "playlists"

const lastOpenedSchema: Type<string | null> = type("string | null")

function lastOpenedPreference(module: LastOpenedModule): KvPreference<string | null> {
	return kvPreference({ key: `shell.lastOpened.${module}.v1`, schema: lastOpenedSchema, fallback: null })
}

const lastOpenedPreferences: Record<LastOpenedModule, KvPreference<string | null>> = {
	chats: lastOpenedPreference("chats"),
	notes: lastOpenedPreference("notes"),
	playlists: lastOpenedPreference("playlists")
}

// Session mirror of the stored values: after the first read (or any write) an index visit decides
// synchronously, and a repeat open costs no kv write. Logout reloads the page, which drops it together
// with the account's kv.
const mirror = new Map<LastOpenedModule, string | null>()
const inflight = new Map<LastOpenedModule, Promise<string | null>>()

// undefined until the first read has resolved in this session.
export function peekLastOpened(module: LastOpenedModule): string | null | undefined {
	return mirror.get(module)
}

export function readLastOpened(module: LastOpenedModule): Promise<string | null> {
	if (mirror.has(module)) {
		return Promise.resolve(mirror.get(module) ?? null)
	}

	const pending = inflight.get(module)

	if (pending !== undefined) {
		return pending
	}

	const read = lastOpenedPreferences[module]
		.get()
		.catch((e: unknown) => {
			log.warn("lastOpened", `read failed for ${module}`, e)

			return null
		})
		.then(stored => {
			inflight.delete(module)

			// A write that landed while the read was in flight is newer than what the read returned.
			if (!mirror.has(module)) {
				mirror.set(module, stored)
			}

			return mirror.get(module) ?? null
		})

	inflight.set(module, read)

	return read
}

export function rememberLastOpened(module: LastOpenedModule, uuid: string): void {
	if (mirror.get(module) === uuid) {
		return
	}

	mirror.set(module, uuid)

	void lastOpenedPreferences[module].set(uuid).catch((e: unknown) => {
		log.warn("lastOpened", `write failed for ${module}`, e)
	})
}

// The stored uuid (null when none), or undefined while the first read of the session is in flight.
export function useLastOpened(module: LastOpenedModule): string | null | undefined {
	const [stored, setStored] = useState(() => peekLastOpened(module))

	useEffect(() => {
		if (stored !== undefined) {
			return
		}

		let cancelled = false

		void readLastOpened(module).then(value => {
			if (!cancelled) {
				setStored(value)
			}
		})

		return () => {
			cancelled = true
		}
	}, [module, stored])

	return stored
}
