import { describe, expect, it, vi } from "vitest"
import type { File as SdkFile } from "@filen/sdk-rs"
import { savePortReader, savePortWriter, SavePortAbortedError } from "@filen/shared/savePort"
import type { QuotaVerdict } from "@filen/shared"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	exportProgressOf,
	isVideoExportRunning,
	startVideoSave,
	subscribeVideoExports,
	type VideoSaveDeps
} from "@/features/preview/videoEdit/save"
import type { Exporter } from "@/features/preview/videoEdit/exportClient"
import type { ExportWorkerProgress, ExportWorkerResult, StartExportArgs } from "@/features/preview/videoEdit/worker/exportApi"
import type { TimeRange, VideoEditRecipe, VideoSourceInfo } from "@/features/preview/videoEdit/types"
import { ALL_ENCODERS, NO_WEBCODECS, recipeFor, sourceInfo } from "@/tests/support/videoEditRecipe"
import { testUuid } from "@/tests/support/uuid"

const ROOT = testUuid("root")
const PARENT = testUuid("parent")
const ORIGINAL = testUuid("original")
const STABLE = testUuid("stable")
const SAVED = testUuid("saved")

function sdkFile(overrides: Partial<SdkFile> = {}, name = "clip.mp4"): SdkFile {
	return {
		uuid: ORIGINAL,
		stableUUID: STABLE,
		parent: PARENT,
		size: 60_000_000n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 60n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: {
				name,
				mime: "video/mp4",
				modified: 1_700_000_000_000n,
				created: 1_600_000_000_000n,
				size: 60_000_000n,
				key: "key",
				version: 2
			}
		},
		...overrides
	}
}

function item(name = "clip.mp4"): DriveItem {
	return narrowItem(sdkFile({}, name))
}

interface Upload {
	parent: string | null
	name: string
	mime: string
	options: Record<string, unknown>
	bytes: number
	file: SdkFile | null
	error: unknown
}

// An export worker stand-in: writes `chunks` MiB into the save port (progress after each), then commits; a cancel
// aborts the channel as the real worker does.
function fakeExporter(
	options: {
		chunks?: number
		fail?: string
		failCause?: "upload" | "workerLost"
		silent?: boolean
		hang?: boolean
		// What the worker reports once the upload answered, in place of "done" (a worker that died meanwhile).
		after?: ExportWorkerResult
		// The ranges the worker reports writing (default: the recipe's).
		bounds?: TimeRange[]
	} = {}
): Exporter & {
	runs: StartExportArgs[]
	cancels: number
	progress: ((progress: ExportWorkerProgress) => unknown) | null
} {
	const runs: StartExportArgs[] = []
	const self = {
		runs,
		cancels: 0,
		progress: null as ((progress: ExportWorkerProgress) => unknown) | null,
		run(args: StartExportArgs, onProgress: (progress: ExportWorkerProgress) => unknown) {
			runs.push(args)
			self.progress = onProgress

			const writer = savePortWriter(args.output)
			const cancelled = Promise.withResolvers<undefined>()
			let stopped = false
			// Read through a call: the cancel sets it while the loop awaits.
			const isStopped = (): boolean => stopped
			const result = (async (): Promise<ExportWorkerResult> => {
				writer.announce()

				if (options.hang === true) {
					await cancelled.promise
				}

				try {
					for (let chunk = 0; chunk < (options.chunks ?? 3); chunk++) {
						await Promise.race([new Promise(resolve => setTimeout(resolve, 1)), cancelled.promise])

						if (isStopped()) {
							writer.abort("cancelled")

							return { status: "cancelled" }
						}

						await writer.write(new Uint8Array(1024 * 1024).fill(chunk))

						if (options.silent !== true) {
							onProgress({
								outputSeconds: chunk + 1,
								outputDuration: options.chunks ?? 3,
								bytesWritten: writer.sent,
								phase: "exporting"
							})
						}
					}

					if (options.fail !== undefined) {
						writer.abort("failed")

						return {
							status: "error",
							message: options.fail,
							refusal: null,
							...(options.failCause === undefined ? {} : { cause: options.failCause })
						}
					}

					await writer.close()
					writer.commit()

					if (options.silent !== true) {
						onProgress({
							outputSeconds: options.chunks ?? 3,
							outputDuration: options.chunks ?? 3,
							bytesWritten: writer.sent,
							phase: "committed"
						})
					}

					const bounds = options.bounds ?? [...args.recipe.keep]
					const made = await writer.uploaded

					if (options.after !== undefined) {
						return options.after
					}

					return made
						? {
								status: "done",
								bytes: writer.sent,
								outputDuration: bounds.reduce((total, range) => total + range.end - range.start, 0) / args.recipe.speed,
								bounds
							}
						: { status: "error", message: "not uploaded", refusal: null, cause: "upload" }
				} catch {
					writer.abort("cancelled")

					return { status: "cancelled" }
				}
			})()

			return {
				result,
				cancel: () => {
					self.cancels++
					stopped = true
					cancelled.resolve(undefined)
				}
			}
		}
	}

	return self
}

interface Harness {
	deps: VideoSaveDeps
	uploads: Upload[]
	store: Record<"add" | "settle" | "remove" | "setItem" | "setSize", ReturnType<typeof vi.fn>>
	rebase: ReturnType<typeof vi.fn>
	checkQuota: ReturnType<typeof vi.fn>
	exporter: ReturnType<typeof fakeExporter>
	clock: { now: number; tick: (() => void) | null }
	awake: { held: number }
}

function harness(
	overrides: Partial<VideoSaveDeps> & {
		exporterOptions?: Parameters<typeof fakeExporter>[0]
		quota?: QuotaVerdict
		// Holds the upload after it read every byte, before it makes the file (a slow uplink finishing).
		uploadGate?: Promise<unknown>
	} = {}
): Harness {
	const uploads: Upload[] = []
	const store = { add: vi.fn(), settle: vi.fn(), remove: vi.fn(), setItem: vi.fn(), setSize: vi.fn() }
	const rebase = vi.fn(() => Promise.resolve())
	const fits: QuotaVerdict = { status: "fits" }
	const checkQuota = vi.fn((_needed: bigint) => Promise.resolve(overrides.quota ?? fits))
	const exporter = fakeExporter(overrides.exporterOptions)
	const clock: Harness["clock"] = { now: 1_000_000, tick: null }
	const awake = { held: 0 }
	const deps: VideoSaveDeps = {
		isOnline: () => true,
		encodeCapabilities: () => Promise.resolve(ALL_ENCODERS),
		versioning: () => true,
		ios: () => false,
		rootUuid: () => ROOT,
		getFileByStableUuid: () => Promise.resolve(sdkFile()),
		takenNames: () => Promise.resolve(new Set(["clip.mp4", "clip (edited).mp4"])),
		openSourcePort: () => Promise.resolve(),
		cancelSourceReads: vi.fn(),
		exporter,
		saveDeps: {
			uploadFileBytes: () => Promise.reject(new Error("unused")),
			uploadFileFromPort: async (parent, port, name, mime, options) => {
				const upload: Upload = { parent, name, mime, options: { ...options }, bytes: 0, file: null, error: null }
				const reader = savePortReader(port)

				uploads.push(upload)

				try {
					for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) {
						upload.bytes += chunk.length
					}
				} catch (error) {
					upload.error = error

					// As the SDK reports an aborted upload.
					throw Object.assign(new Error("Cancelled"), { kind: "Cancelled" })
				}

				try {
					await overrides.uploadGate
				} catch {
					// Cancelled while finishing: no file, as the SDK answers the writer.
					reader.settled(false)

					throw Object.assign(new Error("Cancelled"), { kind: "Cancelled" })
				}

				reader.settled(true)
				upload.file = sdkFile({ uuid: SAVED, size: BigInt(upload.bytes) }, name)

				return upload.file
			},
			patchListing: vi.fn(),
			rootUuid: ROOT
		},
		checkQuota,
		transfers: store,
		isPaused: () => false,
		uploadedBytes: () => uploads.at(-1)?.bytes ?? 0,
		cancelTransfer: vi.fn(),
		rebaseWatchState: rebase,
		keepAwake: () => {
			awake.held++

			return () => {
				awake.held--
			}
		},
		now: () => clock.now,
		setInterval: run => {
			clock.tick = run

			return 1
		},
		clearInterval: () => {
			clock.tick = null
		},
		...overrides
	}

	return { deps, uploads, store, rebase, checkQuota, exporter, clock, awake }
}

const INFO: VideoSourceInfo = sourceInfo()

function save(
	h: Harness,
	recipe: VideoEditRecipe = recipeFor(60, { keep: [{ start: 10, end: 40 }] }),
	target: "inPlace" | "copy" = "inPlace",
	file = item()
) {
	return startVideoSave(h.deps, { item: file, recipe, info: INFO, target, copySuffix: n => (n === 1 ? "edited" : `edited ${String(n)}`) })
}

describe("startVideoSave refusals", () => {
	it("refuses offline before anything starts", async () => {
		const h = harness({ isOnline: () => false })

		expect(await save(h).done).toEqual({ status: "refused", reason: "offline" })
		expect(h.store.add).not.toHaveBeenCalled()
		expect(h.exporter.runs).toEqual([])
	})

	it("refuses what the browser cannot do", async () => {
		const h = harness({ encodeCapabilities: () => Promise.resolve(NO_WEBCODECS) })

		expect(await save(h, recipeFor(60, { flipH: true })).done).toMatchObject({ status: "refused", reason: "unavailable" })
		expect(h.exporter.runs).toEqual([])
	})

	it("refuses an in-place save of a container the export does not write", async () => {
		const h = harness()

		expect(await save(h, recipeFor(60), "inPlace", item("clip.mkv")).done).toMatchObject({ status: "refused", reason: "target" })
	})

	it("stops at a file changed elsewhere, before the upload", async () => {
		const changed = harness({ getFileByStableUuid: () => Promise.resolve(sdkFile({ uuid: testUuid("theirs") })) })

		expect(await save(changed).done).toEqual({ status: "remoteChanged", currentUuid: testUuid("theirs") })
		expect(changed.uploads).toEqual([])
		expect(changed.store.add).not.toHaveBeenCalled()

		const deleted = harness({ getFileByStableUuid: () => Promise.resolve(undefined) })

		expect(await save(deleted).done).toEqual({ status: "remoteChanged", currentUuid: null })
	})

	it("refuses an export the account cannot store, from the estimate", async () => {
		const h = harness({ quota: { status: "exceeds", neededBytes: 33_000_000n, freeBytes: 1n } as QuotaVerdict })
		const outcome = await save(h).done

		expect(outcome).toMatchObject({ status: "refused", reason: "quota" })
		expect(h.uploads).toEqual([])
		expect(h.exporter.cancels).toBe(1)
		expect(h.store.remove).toHaveBeenCalled()
		expect(h.awake.held).toBe(0)
	})
})

describe("startVideoSave", () => {
	it("saves a new version as a transfer, then moves the watch state onto it", async () => {
		const h = harness()
		const progress = vi.fn()
		const handle = startVideoSave(
			h.deps,
			{
				item: item(),
				recipe: recipeFor(60, { keep: [{ start: 10, end: 40 }] }),
				info: INFO,
				target: "inPlace",
				copySuffix: () => "edited"
			},
			progress
		)
		const outcome = await handle.done

		expect(outcome).toMatchObject({ status: "done", item: { data: { uuid: SAVED } } })
		expect(h.uploads).toHaveLength(1)

		const upload = h.uploads[0]

		expect(upload?.name).toBe("clip.mp4")
		expect(upload?.mime).toBe("video/mp4")
		expect(upload?.bytes).toBe(3 * 1024 * 1024)
		// The estimate sizes the pre-flight only: the upload gets no size.
		expect(upload?.options).toMatchObject({ transferId: handle.id, noExifOverride: true, created: 1_600_000_000_000n })
		expect(upload?.options["size"]).toBeUndefined()

		const [needed] = h.checkQuota.mock.calls[0] as [bigint]
		const estimate = (h.store.add.mock.calls[0] as [{ size: number }])[0].size

		expect(Number(needed)).toBe(Math.ceil(estimate * 1.1))
		expect(h.store.add).toHaveBeenCalledWith(
			expect.objectContaining({ id: handle.id, direction: "upload", status: "uploading", parentUuid: PARENT })
		)
		expect(h.store.settle).toHaveBeenCalledWith(handle.id, "done")
		expect(h.store.setSize).toHaveBeenCalledWith(handle.id, 3 * 1024 * 1024)
		expect(progress).toHaveBeenCalled()
		expect(h.awake.held).toBe(0)
		expect(h.clock.tick).toBeNull()

		// Resume 25 s (15 s into the kept 10–40) → 15 s of the new version; a cut time starts over.
		expect(h.rebase).toHaveBeenCalledTimes(1)

		const [rebase] = h.rebase.mock.calls[0] as [{ map: (seconds: number) => number | null; uuid: string; previous: { uuid: string } }]

		expect(rebase.uuid).toBe(SAVED)
		expect(rebase.previous.uuid).toBe(ORIGINAL)
		expect(rebase.map(25)).toBe(15)
		expect(rebase.map(5)).toBeNull()
	})

	it("saves a copy under a free name, leaving the watch state alone", async () => {
		const h = harness()
		const outcome = await save(h, recipeFor(60, { keep: [{ start: 10, end: 40 }] }), "copy").done

		expect(outcome.status).toBe("done")
		expect(h.uploads[0]?.name).toBe("clip (edited 2).mp4")
		expect(h.rebase).not.toHaveBeenCalled()
	})

	it("names a Matroska copy as MP4", async () => {
		const h = harness({ takenNames: () => Promise.resolve(new Set<string>()) })

		await save(h, recipeFor(60), "copy", item("clip.mkv")).done

		expect(h.uploads[0]?.name).toBe("clip (edited).mp4")
	})

	it("makes no version when cancelled mid-export: the upload is aborted before it finishes", async () => {
		const h = harness({ exporterOptions: { chunks: 50 } })
		const handle = save(h)

		await vi.waitFor(() => {
			expect(h.uploads[0]?.bytes ?? 0).toBeGreaterThan(0)
		})
		handle.cancel()

		expect(await handle.done).toEqual({ status: "cancelled" })
		expect(h.uploads[0]?.file).toBeNull()
		expect(h.uploads[0]?.error).toBeInstanceOf(SavePortAbortedError)
		expect(h.deps.cancelTransfer).toHaveBeenCalledWith(handle.id)
		expect(h.store.remove).toHaveBeenCalledWith(handle.id)
		expect(h.store.setItem).not.toHaveBeenCalled()
		expect(h.rebase).not.toHaveBeenCalled()
	})

	it("makes no version when the export fails, and keeps the row for a retry", async () => {
		const h = harness({ exporterOptions: { fail: "decoder error" } })
		const outcome = await save(h).done

		// The raw cause is logged, never shown.
		expect(outcome).toEqual({ status: "error", code: "unknown" })
		expect(h.uploads[0]?.file).toBeNull()
		expect(h.store.settle).toHaveBeenCalledWith(expect.any(String), "error")
	})

	it("gives up on a worker that stopped answering", async () => {
		const h = harness({ exporterOptions: { hang: true } })
		const handle = save(h)

		await vi.waitFor(() => {
			expect(h.clock.tick).not.toBeNull()
		})
		h.clock.now += 31_000
		h.clock.tick?.()

		expect(await handle.done).toEqual({ status: "error", code: "workerLost" })
		expect(h.uploads[0]?.file ?? null).toBeNull()
	})

	it("calls an export with no output for minutes a stall, unless its row is paused", async () => {
		let paused = true
		const h = harness({ exporterOptions: { hang: true }, isPaused: () => paused })
		const handle = save(h)

		await vi.waitFor(() => {
			expect(h.clock.tick).not.toBeNull()
		})

		// The worker keeps posting (it is alive), but nothing advances: the upload is paused.
		const beat = (): void => {
			h.clock.now += 20_000
			h.exporter.progress?.({ outputSeconds: 1, outputDuration: 3, bytesWritten: 5, phase: "exporting" })
			h.clock.tick?.()
		}

		for (let index = 0; index < 8; index++) beat()

		expect(h.exporter.cancels).toBe(0)

		// Resumed: a full stall window starts then, not from before the pause.
		paused = false

		for (let index = 0; index < 6; index++) beat()

		expect(h.exporter.cancels).toBe(0)

		beat()

		expect(await handle.done).toEqual({ status: "error", code: "stalled" })
		expect(h.exporter.cancels).toBeGreaterThan(0)
	})

	it("keeps a committed export alive while the upload finishes over a slow link, by the upload's progress", async () => {
		const gate = Promise.withResolvers<undefined>()
		let uploaded = 0
		const h = harness({ uploadGate: gate.promise, uploadedBytes: () => uploaded })
		const handle = save(h)

		await vi.waitFor(() => {
			expect(h.uploads[0]?.bytes).toBe(3 * 1024 * 1024)
		})

		// The worker beats on (committed), the export writes nothing more; the upload creeps forward.
		for (let index = 0; index < 20; index++) {
			h.clock.now += 20_000
			uploaded += 100_000
			h.exporter.progress?.({ outputSeconds: 3, outputDuration: 3, bytesWritten: 3 * 1024 * 1024, phase: "committed" })
			h.clock.tick?.()
		}

		expect(h.exporter.cancels).toBe(0)

		gate.resolve(undefined)

		expect(await handle.done).toMatchObject({ status: "done" })
	})

	it("calls a committed upload that stopped moving a stall", async () => {
		const gate = Promise.withResolvers<undefined>()
		const h = harness({
			uploadGate: gate.promise,
			uploadedBytes: () => 1000,
			// As the row's cancel ends the SDK upload.
			cancelTransfer: () => {
				gate.reject(new Error("cancelled"))
			}
		})
		const handle = save(h)

		await vi.waitFor(() => {
			expect(h.uploads[0]?.bytes).toBe(3 * 1024 * 1024)
		})

		for (let index = 0; index < 8; index++) {
			h.clock.now += 20_000
			h.exporter.progress?.({ outputSeconds: 3, outputDuration: 3, bytesWritten: 3 * 1024 * 1024, phase: "committed" })
			h.clock.tick?.()
		}

		expect(await handle.done).toEqual({ status: "error", code: "stalled" })
	})

	it("reports a made file as saved even when the worker did not report done", async () => {
		const h = harness({
			exporterOptions: { after: { status: "error", message: "the export worker stopped", refusal: null, cause: "workerLost" } }
		})
		const outcome = await save(h).done

		expect(outcome).toMatchObject({ status: "done", item: { data: { uuid: SAVED } } })
		expect(h.store.settle).toHaveBeenCalledWith(expect.any(String), "done")
		expect(h.rebase).toHaveBeenCalledTimes(1)
	})

	it("moves the watch state by the ranges the worker wrote, not the plan's", async () => {
		const h = harness({ exporterOptions: { bounds: [{ start: 10.04, end: 39.96 }] } })

		await save(h).done

		const [rebase] = h.rebase.mock.calls[0] as [{ map: (seconds: number) => number | null; duration: number }]

		expect(rebase.duration).toBeCloseTo(29.92)
		expect(rebase.map(10.04)).toBeCloseTo(0)
		expect(rebase.map(10)).toBeNull()
	})

	it("words a lost worker and a failed upload as codes", async () => {
		const lost = harness({ exporterOptions: { fail: "the export worker stopped", failCause: "workerLost" } })

		expect(await save(lost).done).toEqual({ status: "error", code: "workerLost" })

		const failing = harness({
			saveDeps: {
				uploadFileBytes: () => Promise.reject(new Error("unused")),
				uploadFileFromPort: () => Promise.reject(Object.assign(new Error("network gone"), { kind: "Network" })),
				patchListing: vi.fn(),
				rootUuid: ROOT
			}
		})

		expect(await save(failing).done).toEqual({ status: "error", code: "uploadFailed" })
	})
})

describe("running exports", () => {
	it("refuses a second new version of a file while one is saved, and tells who listens", async () => {
		const listener = vi.fn()
		const unsubscribe = subscribeVideoExports(listener)
		const h = harness({ exporterOptions: { chunks: 20 } })
		const first = save(h)

		expect(isVideoExportRunning(STABLE)).toBe(true)
		expect(listener).toHaveBeenCalledTimes(1)
		expect(await save(h).done).toEqual({ status: "refused", reason: "busy" })

		// A copy of the same file is not a version: it may run alongside.
		const copy = save(h, recipeFor(60), "copy")

		expect((await first.done).status).toBe("done")
		expect((await copy.done).status).toBe("done")
		expect(isVideoExportRunning(STABLE)).toBe(false)
		expect(listener).toHaveBeenCalledTimes(4)
		unsubscribe()
	})

	it("never gives two copies running at once the same name", async () => {
		const h = harness({ exporterOptions: { chunks: 10 } })
		const first = save(h, recipeFor(60), "copy")
		const second = save(h, recipeFor(60), "copy")

		await Promise.all([first.done, second.done])

		expect(h.uploads.map(upload => upload.name).sort()).toEqual(["clip (edited 2).mp4", "clip (edited 3).mp4"])
	})
})

describe("exportProgressOf", () => {
	it("reports a fraction and an ETA once enough is done", () => {
		expect(
			exportProgressOf({ outputSeconds: 0.5, outputDuration: 100, bytesWritten: 10, phase: "exporting" }, 1000).etaSeconds
		).toBeNull()
		expect(exportProgressOf({ outputSeconds: 25, outputDuration: 100, bytesWritten: 10, phase: "exporting" }, 10_000)).toEqual({
			fraction: 0.25,
			bytesWritten: 10,
			etaSeconds: 30
		})
		expect(
			exportProgressOf({ outputSeconds: 100, outputDuration: 100, bytesWritten: 10, phase: "exporting" }, 10_000).etaSeconds
		).toBeNull()
	})
})
