import { describe, expect, it, vi } from "vitest"
import { anyDemand } from "../main/native/supervisor.ts"
import { DEFAULT_MOUNTS, DEFAULT_TUNING, defaultServe, loadMountsStore, parseMountsConfig } from "../main/mounts/store.ts"
import { memoryFile } from "./fileFakes.ts"

describe("parseMountsConfig", () => {
	it("missing, non-JSON or invalid files are the defaults", () => {
		const warn = vi.fn()

		expect(parseMountsConfig(null, warn)).toBe(DEFAULT_MOUNTS)
		expect(parseMountsConfig("{", warn)).toBe(DEFAULT_MOUNTS)
		expect(parseMountsConfig(JSON.stringify({ version: 2 }), warn)).toBe(DEFAULT_MOUNTS)
		expect(warn).toHaveBeenCalledTimes(2)
	})

	it("drops each invalid part alone", () => {
		const config = parseMountsConfig(
			JSON.stringify({
				version: 1,
				drive: { enabled: true, mountPoint: "", driveLetter: null, readOnly: false },
				serves: {
					webdav: { ...defaultServe("webdav"), enabled: true, future: 1 },
					s3: { ...defaultServe("s3"), host: "" },
					dlna: { ...defaultServe("http") }
				},
				tuning: { ...DEFAULT_TUNING, cacheMaxGiB: -1 },
				legacyApplied: true,
				notices: ["lanBindDisabled", "boom", "lanBindDisabled"]
			}),
			vi.fn()
		)

		expect(config).toEqual({
			version: 1,
			drive: DEFAULT_MOUNTS.drive,
			serves: { webdav: { ...defaultServe("webdav"), enabled: true } },
			tuning: DEFAULT_TUNING,
			legacyApplied: true,
			notices: ["lanBindDisabled"]
		})
	})
})

describe("loadMountsStore", () => {
	it("writes changes and serves them from memory", async () => {
		const file = memoryFile()
		const store = await loadMountsStore(file, vi.fn())

		expect(store.anyEnabled()).toBe(false)
		await store.update(config => config)
		expect(file.writes).toBe(0)
		await store.update(config => ({ ...config, serves: { sftp: { ...defaultServe("sftp"), enabled: true } } }))
		expect(file.writes).toBe(1)
		expect(store.anyEnabled()).toBe(true)
		expect(parseMountsConfig(file.data?.toString() ?? null, vi.fn())).toEqual(store.get())
	})

	it("a failed write keeps the config", async () => {
		const file = memoryFile()
		const store = await loadMountsStore({ ...file, write: () => Promise.reject(new Error("EIO")) }, vi.fn())

		await expect(store.update(config => ({ ...config, drive: { ...config.drive, enabled: true } }))).rejects.toThrow("EIO")
		expect(store.get()).toBe(DEFAULT_MOUNTS)
	})

	it("demand includes enabled mounts", async () => {
		const store = await loadMountsStore(memoryFile(), vi.fn())
		const demand = () => anyDemand([() => false, () => Promise.resolve(false), () => store.anyEnabled()])

		expect(await demand()).toBe(false)
		await store.update(config => ({ ...config, drive: { ...config.drive, enabled: true, mountPoint: "/Users/u/Filen" } }))
		expect(await demand()).toBe(true)
	})
})
