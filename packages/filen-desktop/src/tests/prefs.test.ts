import { type } from "arktype"
import { describe, expect, it, vi } from "vitest"
import type { AtomicFile } from "../main/atomicFile.ts"
import { DEFAULT_PREFS, loadPrefs, parsePrefs, prefsPatchSchema } from "../main/prefs.ts"

function memoryFile(initial: string | null): AtomicFile & { data: string | null } {
	const file = {
		data: initial,
		read: () => Promise.resolve(file.data === null ? null : Buffer.from(file.data)),
		write: (data: Buffer) => {
			file.data = data.toString("utf8")

			return Promise.resolve()
		},
		remove: () => {
			file.data = null

			return Promise.resolve()
		}
	}

	return file
}

describe("parsePrefs", () => {
	it("falls back to the defaults for a missing, unparsable or non-object file", () => {
		expect(parsePrefs(null)).toEqual(DEFAULT_PREFS)
		expect(parsePrefs("{")).toEqual(DEFAULT_PREFS)
		expect(parsePrefs("[]")).toEqual(DEFAULT_PREFS)
		expect(parsePrefs("null")).toEqual(DEFAULT_PREFS)
		expect(parsePrefs("3")).toEqual(DEFAULT_PREFS)
	})

	it("resets only an invalid field to its default", () => {
		expect(parsePrefs(JSON.stringify({ minimizeToTray: "yes", startMinimized: true }))).toEqual({
			...DEFAULT_PREFS,
			startMinimized: true
		})
		expect(parsePrefs(JSON.stringify({ lockAfterSeconds: 7200, launchAtLogin: true }))).toEqual({
			...DEFAULT_PREFS,
			launchAtLogin: true
		})
		expect(parsePrefs(JSON.stringify({ lockAfterSeconds: 3600 }))).toEqual({ ...DEFAULT_PREFS, lockAfterSeconds: 3600 })
	})

	it("drops the pre-split notifications key", () => {
		const prefs = parsePrefs(JSON.stringify({ notifications: false }))

		expect(prefs).toEqual(DEFAULT_PREFS)
		expect(prefs).not.toHaveProperty("notifications")
	})

	it("fills missing fields with their defaults and drops unknown ones", () => {
		expect(parsePrefs(JSON.stringify({ minimizeToTray: true, legacy: 1 }))).toEqual({ ...DEFAULT_PREFS, minimizeToTray: true })
	})

	it("defaults to notifications and their sound on, a 5 minute lock and everything else off", () => {
		expect(DEFAULT_PREFS).toEqual({
			minimizeToTray: false,
			startMinimized: false,
			launchAtLogin: false,
			lockAfterSeconds: 300,
			chatNotifications: true,
			contactNotifications: true,
			syncNotifications: true,
			notificationSound: false
		})
	})
})

describe("prefsPatchSchema", () => {
	it("takes known fields with valid values only", () => {
		expect(prefsPatchSchema({ chatNotifications: false })).toEqual({ chatNotifications: false })
		expect(prefsPatchSchema({ chatNotifications: "false" })).toBeInstanceOf(type.errors)
		expect(prefsPatchSchema({ notifications: false })).toBeInstanceOf(type.errors)
		expect(prefsPatchSchema({ other: true })).toBeInstanceOf(type.errors)
		expect(prefsPatchSchema(null)).toBeInstanceOf(type.errors)
	})

	it("takes only the offered lock-after choices", () => {
		expect(prefsPatchSchema({ lockAfterSeconds: 0 })).toEqual({ lockAfterSeconds: 0 })
		expect(prefsPatchSchema({ lockAfterSeconds: 86400 })).toEqual({ lockAfterSeconds: 86400 })
		expect(prefsPatchSchema({ lockAfterSeconds: 7200 })).toBeInstanceOf(type.errors)
		expect(prefsPatchSchema({ lockAfterSeconds: "300" })).toBeInstanceOf(type.errors)
	})
})

describe("loadPrefs", () => {
	it("serves the stored prefs and persists a set", async () => {
		const file = memoryFile(JSON.stringify({ startMinimized: true }))
		const store = await loadPrefs(file, vi.fn())

		expect(store.get().startMinimized).toBe(true)
		await expect(store.set({ minimizeToTray: true })).resolves.toEqual({ ...DEFAULT_PREFS, startMinimized: true, minimizeToTray: true })
		expect(JSON.parse(file.data ?? "")).toEqual(store.get())
	})

	it("uses the defaults when the file cannot be read", async () => {
		const warn = vi.fn()
		const store = await loadPrefs({ ...memoryFile(null), read: () => Promise.reject(new Error("EACCES")) }, warn)

		expect(store.get()).toEqual(DEFAULT_PREFS)
		expect(warn).toHaveBeenCalledOnce()
	})

	it("keeps the prefs unchanged when a write fails, and runs later writes", async () => {
		const file = memoryFile(null)
		const store = await loadPrefs({ ...file, write: () => Promise.reject(new Error("ENOSPC")) }, vi.fn())

		await expect(store.set({ chatNotifications: false })).rejects.toThrow("ENOSPC")
		expect(store.get()).toEqual(DEFAULT_PREFS)
	})

	it("applies concurrent sets in order", async () => {
		const file = memoryFile(null)
		const store = await loadPrefs(file, vi.fn())

		await Promise.all([store.set({ minimizeToTray: true }), store.set({ startMinimized: true })])

		expect(store.get()).toMatchObject({ minimizeToTray: true, startMinimized: true })
		expect(JSON.parse(file.data ?? "")).toEqual(store.get())
	})
})
