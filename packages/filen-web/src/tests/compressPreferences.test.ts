import { beforeEach, describe, expect, it, vi } from "vitest"
import { type } from "arktype"
import type { FormatOptions } from "@/features/drive/lib/archiveFormats"
import type { CompressPreferences } from "@/features/drive/lib/compressPreferences"

const KEY = "drive.compressPreferences.v1"

const { kvStore, kvGetJson, kvSetJson } = vi.hoisted(() => {
	const store = new Map<string, unknown>()

	return {
		kvStore: store,
		kvGetJson: vi.fn<(key: string, schema: (value: unknown) => unknown) => Promise<unknown>>(),
		kvSetJson: vi.fn((key: string, value: unknown) => {
			store.set(key, value)

			return Promise.resolve()
		})
	}
})

vi.mock("@/lib/storage/adapter", () => ({ kvGetJson, kvSetJson }))

type PreferencesModule = typeof import("@/features/drive/lib/compressPreferences")

// The read is memoised per page, so each test gets a fresh module.
async function load(): Promise<PreferencesModule> {
	vi.resetModules()

	return await import("@/features/drive/lib/compressPreferences")
}

const OPTIONS: FormatOptions = {
	level: 7,
	zipMethod: "bzip2",
	sevenZMethod: "ppmd",
	solid: false,
	aes: "aes128",
	encryptNames: false
}

beforeEach(() => {
	kvStore.clear()
	// Like the real adapter: absent and schema-invalid both read as null.
	kvGetJson.mockImplementation((key, schema) => {
		const parsed = kvStore.has(key) ? schema(kvStore.get(key)) : null

		return Promise.resolve(parsed instanceof type.errors ? null : parsed)
	})
})

describe("compress preferences", () => {
	it("falls back to the defaults when nothing or something invalid is stored", async () => {
		const { loadCompressPreferences, DEFAULT_COMPRESS_PREFERENCES } = await load()

		await expect(loadCompressPreferences()).resolves.toEqual(DEFAULT_COMPRESS_PREFERENCES)

		kvStore.set(KEY, { format: "rar", zip: {}, sevenZ: {}, levels: {} })

		await expect((await load()).loadCompressPreferences()).resolves.toEqual(DEFAULT_COMPRESS_PREFERENCES)
	})

	it("opens on ZIP with 7-Zip's names encrypted and the SDK's levels", async () => {
		const { DEFAULT_COMPRESS_PREFERENCES } = await load()

		expect(DEFAULT_COMPRESS_PREFERENCES).toEqual({
			format: "zip",
			zip: { method: "deflate", level: null, aes: "aes256" },
			sevenZ: { method: "lzma2", level: null, solid: true, encryptNames: true },
			levels: {}
		})
	})

	it("drops level entries that are not a codec format, and unknown fields", async () => {
		const { loadCompressPreferences, DEFAULT_COMPRESS_PREFERENCES } = await load()

		kvStore.set(KEY, {
			...DEFAULT_COMPRESS_PREFERENCES,
			password: "secret",
			levels: { "tar.gz": 9, tar: 3, zip: 4, rar: 1, zst: 19 }
		})

		const prefs = await loadCompressPreferences()

		expect(prefs.levels).toEqual({ "tar.gz": 9, zst: 19 })
		expect(Object.keys(prefs).sort()).toEqual(["format", "levels", "sevenZ", "zip"])
	})

	it("reads storage once a page, and a write replaces what it holds", async () => {
		const { loadCompressPreferences, setCompressPreferences, DEFAULT_COMPRESS_PREFERENCES } = await load()

		await loadCompressPreferences()
		await loadCompressPreferences()

		expect(kvGetJson).toHaveBeenCalledTimes(1)

		await setCompressPreferences({ ...DEFAULT_COMPRESS_PREFERENCES, format: "7z" })

		await expect(loadCompressPreferences()).resolves.toMatchObject({ format: "7z" })
		expect(kvGetJson).toHaveBeenCalledTimes(1)
	})

	it("reads again after a failed read", async () => {
		const { loadCompressPreferences } = await load()

		kvGetJson.mockRejectedValueOnce(new Error("idb closed"))

		await expect(loadCompressPreferences()).rejects.toThrow("idb closed")
		await expect(loadCompressPreferences()).resolves.toMatchObject({ format: "zip" })
	})

	it("never stores a password, what happens to the originals or a destination", async () => {
		const { nextCompressPreferences, setCompressPreferences, DEFAULT_COMPRESS_PREFERENCES } = await load()
		// What a dialog holds besides the options, passed along by mistake.
		const used = {
			choice: "7z" as const,
			options: { ...OPTIONS, password: "hunter2", dispose: "deletePermanently", destination: { uuid: null, name: "My Drive" } }
		}
		const next = nextCompressPreferences(DEFAULT_COMPRESS_PREFERENCES, used)

		await setCompressPreferences({ ...next, password: "hunter2" } as CompressPreferences)

		const persisted = JSON.stringify(kvStore.get(KEY))

		expect(persisted).not.toContain("hunter2")
		expect(persisted).not.toContain("password")
		expect(persisted).not.toContain("dispose")
		expect(persisted).not.toContain("deletePermanently")
		expect(persisted).not.toContain("destination")
	})
})

describe("presetOptions", () => {
	it("runs with the options last used for the format, null levels for the SDK's default", async () => {
		const { presetOptions, DEFAULT_COMPRESS_PREFERENCES } = await load()
		const prefs: CompressPreferences = {
			format: "tar.xz",
			zip: { method: "bzip2", level: 3, aes: "aes192" },
			sevenZ: { method: "lzma", level: 8, solid: false, encryptNames: true },
			levels: { "tar.gz": 2 }
		}

		expect(presetOptions(prefs, "zip")).toEqual({
			level: 3,
			zipMethod: "bzip2",
			sevenZMethod: "lzma",
			solid: false,
			aes: "aes192",
			encryptNames: true
		})
		expect(presetOptions(prefs, "7z").level).toBe(8)
		expect(presetOptions(prefs, "tar.gz").level).toBe(2)
		expect(presetOptions(prefs, "tar.xz").level).toBeNull()
		expect(presetOptions(DEFAULT_COMPRESS_PREFERENCES, "zip").level).toBeNull()
	})
})

describe("nextCompressPreferences", () => {
	it("remembers ZIP's method, level and strength", async () => {
		const { nextCompressPreferences, DEFAULT_COMPRESS_PREFERENCES } = await load()
		const next = nextCompressPreferences(DEFAULT_COMPRESS_PREFERENCES, { choice: "zip", options: OPTIONS })

		expect(next).toEqual({ ...DEFAULT_COMPRESS_PREFERENCES, zip: { method: "bzip2", level: 7, aes: "aes128" } })
	})

	it("remembers 7-Zip's method, level, solid and names choice", async () => {
		const { nextCompressPreferences, DEFAULT_COMPRESS_PREFERENCES } = await load()
		const next = nextCompressPreferences(DEFAULT_COMPRESS_PREFERENCES, { choice: "7z", options: OPTIONS })

		expect(next).toEqual({
			...DEFAULT_COMPRESS_PREFERENCES,
			format: "7z",
			sevenZ: { method: "ppmd", level: 7, solid: false, encryptNames: false }
		})
	})

	it("keeps the level last picked when the method had none", async () => {
		const { nextCompressPreferences, DEFAULT_COMPRESS_PREFERENCES } = await load()
		const leveled = nextCompressPreferences(DEFAULT_COMPRESS_PREFERENCES, { choice: "zip", options: OPTIONS })
		const stored = nextCompressPreferences(leveled, { choice: "zip", options: { ...OPTIONS, zipMethod: "stored", level: null } })

		expect(stored.zip).toEqual({ method: "stored", level: 7, aes: "aes128" })
	})

	it("remembers a codec's level by format, and none for plain tar", async () => {
		const { nextCompressPreferences, DEFAULT_COMPRESS_PREFERENCES } = await load()
		const gz = nextCompressPreferences(DEFAULT_COMPRESS_PREFERENCES, { choice: "tar.gz", options: { ...OPTIONS, level: 9 } })
		const zst = nextCompressPreferences(gz, { choice: "zst", options: { ...OPTIONS, level: 19 } })
		const tar = nextCompressPreferences(zst, { choice: "tar", options: { ...OPTIONS, level: null } })

		expect(tar.levels).toEqual({ "tar.gz": 9, zst: 19 })
		expect(tar.format).toBe("tar")
		expect(tar.zip).toBe(DEFAULT_COMPRESS_PREFERENCES.zip)
	})
})
