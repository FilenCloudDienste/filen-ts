import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Logger, UpdateCheckResult } from "electron-updater"
import {
	type NativeUpdaterEvents,
	shouldCheckForUpdate,
	stallWatch,
	startUpdater,
	TEST_UPDATE_CHECK_INTERVAL_MS,
	testUpdateFeed,
	UPDATE_CHECK_INTERVAL_MS,
	UPDATE_FIRST_CHECK_DELAY_MS,
	UPDATE_STALL_MS,
	updateCheckInterval,
	type UpdaterDeps,
	type UpdaterEngine
} from "../main/updater.ts"

describe("shouldCheckForUpdate", () => {
	it("checks when idle with nothing downloaded", () => {
		expect(shouldCheckForUpdate({ checking: false, ready: null })).toBe(true)
	})

	it("never overlaps a running check or download", () => {
		expect(shouldCheckForUpdate({ checking: true, ready: null })).toBe(false)
	})

	it("stops once an update waits for a restart", () => {
		expect(shouldCheckForUpdate({ checking: false, ready: "4.0.1" })).toBe(false)
	})
})

describe("schedule", () => {
	it("checks soon after start, then hourly", () => {
		expect(UPDATE_FIRST_CHECK_DELAY_MS).toBeLessThan(60 * 1000)
		expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000)
		expect(updateCheckInterval(null)).toBe(UPDATE_CHECK_INTERVAL_MS)
	})

	it("retries within a test under the test feed", () => {
		expect(updateCheckInterval("http://127.0.0.1:43210/")).toBe(TEST_UPDATE_CHECK_INTERVAL_MS)
		expect(TEST_UPDATE_CHECK_INTERVAL_MS).toBeLessThan(UPDATE_STALL_MS)
	})
})

describe("testUpdateFeed", () => {
	it("takes an explicit-port http feed on 127.0.0.1 and normalises the trailing slash", () => {
		expect(testUpdateFeed("http://127.0.0.1:43210")).toBe("http://127.0.0.1:43210/")
		expect(testUpdateFeed("http://127.0.0.1:43210/feed/")).toBe("http://127.0.0.1:43210/feed/")
	})

	it.each([
		undefined,
		"",
		"not a url",
		"https://127.0.0.1:43210/",
		"http://localhost:43210/",
		"http://127.0.0.2:43210/",
		"http://0.0.0.0:43210/",
		"http://127.0.0.1/",
		"http://user:pass@127.0.0.1:43210/",
		"http://127.0.0.1:43210/?x=1",
		"http://127.0.0.1:43210/#x",
		"http://cdn.filen.io:80/"
	])("refuses %s", value => {
		expect(testUpdateFeed(value)).toBeNull()
	})
})

describe("stallWatch", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("fires once nothing moved for the whole span", () => {
		const onStall = vi.fn()
		const watch = stallWatch(1000, onStall)

		watch.arm()
		vi.advanceTimersByTime(999)
		expect(onStall).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(onStall).toHaveBeenCalledOnce()
	})

	it("is pushed back by progress and silenced by disarm", () => {
		const onStall = vi.fn()
		const watch = stallWatch(1000, onStall)

		watch.arm()
		vi.advanceTimersByTime(800)
		watch.progress()
		vi.advanceTimersByTime(800)
		expect(onStall).not.toHaveBeenCalled()
		watch.disarm()
		vi.advanceTimersByTime(5000)
		expect(onStall).not.toHaveBeenCalled()
	})

	it("ignores progress while disarmed", () => {
		const onStall = vi.fn()
		const watch = stallWatch(1000, onStall)

		watch.progress()
		vi.advanceTimersByTime(5000)
		expect(onStall).not.toHaveBeenCalled()
	})
})

type CheckResult = Pick<UpdateCheckResult, "downloadPromise"> | null

class FakeEngine extends EventEmitter implements UpdaterEngine {
	logger: Logger | null = null
	autoDownload = false
	autoInstallOnAppQuit = false
	feed: string | null = null
	checks = 0
	installs = 0
	// What the next check resolves with; a check without one never settles (a stalled request).
	nextCheck: (() => Promise<CheckResult>) | null = null
	// What quitAndInstall does besides counting: throw, or emit an error as electron-updater does.
	onInstall: (() => void) | null = null

	setFeedURL(options: { provider: "generic"; url: string }): void {
		this.feed = options.url
	}

	checkForUpdates(): Promise<CheckResult> {
		this.checks += 1

		const next = this.nextCheck

		this.nextCheck = null

		return next === null ? new Promise<CheckResult>(() => undefined) : next()
	}

	quitAndInstall(): void {
		this.installs += 1
		this.onInstall?.()
	}

	downloaded(version: string): void {
		this.emit("update-downloaded", { version, downloadedFile: "/tmp/update", files: [], path: "", sha512: "", releaseDate: "" })
	}
}

interface Harness {
	engine: FakeEngine
	deps: UpdaterDeps
	native: NativeUpdaterEvents | null
	warnings: string[]
	onReady: ReturnType<typeof vi.fn<(version: string) => void>>
	onInstallFailed: ReturnType<typeof vi.fn<() => void>>
	closeConnections: ReturnType<typeof vi.fn<() => Promise<void>>>
}

function harness(options: { mac?: boolean; testFeed?: string | null } = {}): Harness {
	const engine = new FakeEngine()
	const warnings: string[] = []
	const onReady = vi.fn<(version: string) => void>()
	const onInstallFailed = vi.fn<() => void>()
	const closeConnections = vi.fn<() => Promise<void>>(() => Promise.resolve())
	const result: Harness = {
		engine,
		native: null,
		warnings,
		onReady,
		onInstallFailed,
		closeConnections,
		deps: {
			log: {
				info: () => undefined,
				warn: message => {
					warnings.push(message)
				}
			},
			testFeed: options.testFeed ?? null,
			load: () => Promise.resolve(engine),
			closeConnections,
			native:
				options.mac === true
					? events => {
							result.native = events
						}
					: null,
			onReady,
			onInstallFailed
		}
	}

	return result
}

// A check that finds an update and downloads it once `finish` is called.
function downloadingCheck(engine: FakeEngine, version: string): { finish(): void } {
	const { promise, resolve } = Promise.withResolvers<string[]>()

	engine.nextCheck = () => Promise.resolve({ downloadPromise: promise })

	return {
		finish: () => {
			engine.downloaded(version)
			resolve([])
		}
	}
}

describe("startUpdater", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("is ready on electron-updater's download outside macOS", async () => {
		const h = harness()
		const updater = startUpdater(h.deps)
		const download = downloadingCheck(h.engine, "4.0.1")

		await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_DELAY_MS)
		expect(h.engine.checks).toBe(1)
		expect(h.engine.autoDownload).toBe(true)
		expect(h.engine.autoInstallOnAppQuit).toBe(true)
		download.finish()
		await vi.advanceTimersByTimeAsync(0)
		expect(updater.ready()).toBe("4.0.1")
		expect(h.onReady).toHaveBeenCalledWith("4.0.1")
	})

	it("uses the test feed and its shorter interval", async () => {
		const h = harness({ testFeed: "http://127.0.0.1:43210/" })

		startUpdater(h.deps)
		h.engine.nextCheck = () => Promise.resolve(null)
		await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_DELAY_MS)
		expect(h.engine.feed).toBe("http://127.0.0.1:43210/")
		expect(h.engine.checks).toBe(1)
		h.engine.nextCheck = () => Promise.resolve(null)
		await vi.advanceTimersByTimeAsync(TEST_UPDATE_CHECK_INTERVAL_MS)
		expect(h.engine.checks).toBe(2)
	})

	describe("watchdog", () => {
		it("closes the connections of a check that moves nothing, and the next check runs", async () => {
			const h = harness()
			const { promise, reject } = Promise.withResolvers<CheckResult>()

			startUpdater(h.deps)
			h.engine.nextCheck = () => promise
			h.closeConnections.mockImplementation(() => {
				reject(new Error("net::ERR_ABORTED"))

				return Promise.resolve()
			})
			await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_DELAY_MS)
			await vi.advanceTimersByTimeAsync(UPDATE_STALL_MS - 1)
			expect(h.closeConnections).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(1)
			expect(h.closeConnections).toHaveBeenCalledOnce()
			expect(h.warnings.some(line => line.includes("check failed: net::ERR_ABORTED"))).toBe(true)

			h.engine.nextCheck = () => Promise.resolve(null)
			await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - UPDATE_STALL_MS)
			expect(h.engine.checks).toBe(2)
		})

		it("lets a download run as long as it reports progress", async () => {
			const h = harness()
			const download = downloadingCheck(h.engine, "4.0.1")

			startUpdater(h.deps)
			await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_DELAY_MS)

			for (let i = 0; i < 10; i++) {
				await vi.advanceTimersByTimeAsync(UPDATE_STALL_MS / 2)
				h.engine.emit("download-progress", {})
			}

			download.finish()
			await vi.advanceTimersByTimeAsync(UPDATE_STALL_MS * 2)
			expect(h.closeConnections).not.toHaveBeenCalled()
		})

		it("stops watching once the download is in", async () => {
			const h = harness({ mac: true })
			const download = downloadingCheck(h.engine, "4.0.1")

			startUpdater(h.deps)
			await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_DELAY_MS)
			download.finish()
			// Squirrel takes its time; no connection of the updater's is involved.
			await vi.advanceTimersByTimeAsync(UPDATE_STALL_MS * 3)
			expect(h.closeConnections).not.toHaveBeenCalled()
		})
	})

	describe("macOS", () => {
		it("is ready only once Squirrel holds the download", async () => {
			const h = harness({ mac: true })
			const updater = startUpdater(h.deps)
			const download = downloadingCheck(h.engine, "4.0.1")

			await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_DELAY_MS)
			download.finish()
			await vi.advanceTimersByTimeAsync(0)
			expect(updater.ready()).toBeNull()
			expect(updater.install()).toBe(false)
			expect(h.onReady).not.toHaveBeenCalled()

			h.native?.downloaded()
			expect(updater.ready()).toBe("4.0.1")
			expect(h.onReady).toHaveBeenCalledWith("4.0.1")
		})

		it("holds later checks until Squirrel answers", async () => {
			const h = harness({ mac: true })

			const download = downloadingCheck(h.engine, "4.0.1")

			startUpdater(h.deps)
			await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_DELAY_MS)
			download.finish()
			await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
			expect(h.engine.checks).toBe(1)

			h.native?.error(new Error("code signature invalid"))
			h.engine.nextCheck = () => Promise.resolve(null)
			await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS)
			expect(h.engine.checks).toBe(2)
		})

		it("a Squirrel error during the install clears ready and reports the failure", async () => {
			const h = harness({ mac: true })
			const updater = startUpdater(h.deps)
			const download = downloadingCheck(h.engine, "4.0.1")

			await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_DELAY_MS)
			download.finish()
			await vi.advanceTimersByTimeAsync(0)
			h.native?.downloaded()
			h.engine.onInstall = () => {
				queueMicrotask(() => {
					const error = new Error("Squirrel could not install")

					// MacUpdater passes Squirrel's error on, after its own listener saw it.
					h.engine.emit("error", error)
					h.native?.error(error)
				})
			}

			expect(updater.install()).toBe(true)
			await vi.advanceTimersByTimeAsync(0)
			expect(h.onInstallFailed).toHaveBeenCalledOnce()
			expect(updater.ready()).toBeNull()
			expect(updater.install()).toBe(false)
		})
	})

	describe("install", () => {
		async function readyUpdater(h: Harness) {
			const updater = startUpdater(h.deps)
			const download = downloadingCheck(h.engine, "4.0.1")

			await vi.advanceTimersByTimeAsync(UPDATE_FIRST_CHECK_DELAY_MS)
			download.finish()
			await vi.advanceTimersByTimeAsync(0)

			return updater
		}

		it("has nothing to install before a download", () => {
			const h = harness()

			expect(startUpdater(h.deps).install()).toBe(false)
			expect(h.engine.installs).toBe(0)
		})

		it("starts the silent installer once, relaunching after", async () => {
			const h = harness()
			const updater = await readyUpdater(h)
			const quitAndInstall = vi.spyOn(h.engine, "quitAndInstall")

			expect(updater.install()).toBe(true)
			expect(quitAndInstall).toHaveBeenCalledWith(true, true)
			expect(updater.install()).toBe(false)
			expect(h.onInstallFailed).not.toHaveBeenCalled()
		})

		it("a declined elevation reported later keeps the update for another try", async () => {
			const h = harness()
			const updater = await readyUpdater(h)
			const elevation = Promise.withResolvers<void>()

			h.engine.onInstall = () => {
				void elevation.promise.then(() => h.engine.emit("error", new Error("elevate.exe exited with code 1223")))
			}

			expect(updater.install()).toBe(true)
			expect(h.onInstallFailed).not.toHaveBeenCalled()
			elevation.resolve()
			await vi.advanceTimersByTimeAsync(0)
			expect(h.onInstallFailed).toHaveBeenCalledOnce()
			expect(updater.ready()).toBe("4.0.1")
			expect(updater.install()).toBe(true)
			expect(h.engine.installs).toBe(2)
		})

		it("an installer failing at once is reported", async () => {
			const h = harness()
			const updater = await readyUpdater(h)

			h.engine.onInstall = () => {
				throw new Error("spawn ENOENT")
			}

			expect(updater.install()).toBe(true)
			expect(h.onInstallFailed).toHaveBeenCalledOnce()
			expect(h.warnings.some(line => line.includes("install failed: spawn ENOENT"))).toBe(true)
		})

		it("an error outside an install is not an install failure", async () => {
			const h = harness()

			await readyUpdater(h)
			h.engine.emit("error", new Error("Cannot check for updates"))
			expect(h.onInstallFailed).not.toHaveBeenCalled()
		})
	})
})
