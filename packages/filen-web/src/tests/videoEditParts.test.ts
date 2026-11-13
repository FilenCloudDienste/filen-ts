import { describe, expect, it } from "vitest"
import type { File as SdkFile } from "@filen/sdk-rs"
import { withProgress, withSubtitleOffset, type ItemRec } from "@filen/shared/videos"
import { canEditVideo, isEditable, runPreviewSave, type PreviewSaveDeps } from "@/features/drive/lib/previewSave.logic"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { rebasedEditRecord } from "@/features/videos/lib/watchState.logic"
import { editedTags, isLocationTag } from "@/features/preview/videoEdit/worker/metadata"
import { InterleaveGate } from "@/features/preview/videoEdit/worker/gate"
import { testUuid } from "@/tests/support/uuid"

const OLD = testUuid("old")
const NEW = testUuid("new")
const STAMP_1 = { t: 1_000, d: "dev.tab" }
const STAMP_2 = { t: 2_000, d: "dev.tab" }

function videoFile(name: string, overrides: Partial<SdkFile> = {}): DriveItem {
	return narrowItem({
		uuid: OLD,
		stableUUID: testUuid("stable"),
		parent: testUuid("parent"),
		size: 1_000n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: { type: "decoded", data: { name, mime: "video/mp4", modified: 1n, size: 1_000n, key: "key", version: 2 } },
		...overrides
	})
}

describe("rebasedEditRecord", () => {
	const progress = (pos: number, part?: number): ItemRec =>
		withProgress({ rec: undefined, stamp: STAMP_1, pos, dur: 60, lp: 123, uuid: OLD, size: 1_000, part })

	it("moves the resume point through the edit and onto the new version", () => {
		const next = rebasedEditRecord({
			rec: progress(25),
			stamp: STAMP_2,
			previous: { uuid: OLD, size: 1_000 },
			uuid: NEW,
			size: 500,
			duration: 30,
			map: seconds => seconds - 10
		})

		expect(next?.p).toMatchObject({ pos: 15, dur: 30, u: NEW, sz: 500, lp: 123, t: 2_000 })
	})

	it("starts over when the moment was cut", () => {
		const next = rebasedEditRecord({
			rec: progress(5),
			stamp: STAMP_2,
			previous: { uuid: OLD, size: 1_000 },
			uuid: NEW,
			size: 500,
			duration: 30,
			map: () => null
		})

		expect(next?.p?.pos).toBe(0)
	})

	it("clears a subtitle offset timed against the old cut", () => {
		const rec = withSubtitleOffset({ rec: progress(25), stamp: STAMP_1, subMs: 1_500 })
		const next = rebasedEditRecord({
			rec,
			stamp: STAMP_2,
			previous: { uuid: OLD, size: 1_000 },
			uuid: NEW,
			size: 500,
			duration: 30,
			map: seconds => seconds
		})

		expect(next?.o?.subMs).toBe(0)
	})

	it("leaves a record about another version, or another stack part, as it is", () => {
		const other = withProgress({
			rec: undefined,
			stamp: STAMP_1,
			pos: 25,
			dur: 60,
			lp: 1,
			uuid: testUuid("other"),
			size: 9,
			part: undefined
		})
		const base = { stamp: STAMP_2, previous: { uuid: OLD, size: 1_000 }, uuid: NEW, size: 500, duration: 30, map: (s: number) => s }

		expect(rebasedEditRecord({ ...base, rec: other })).toBeNull()
		expect(rebasedEditRecord({ ...base, rec: progress(25, 2) })).toBeNull()
		expect(rebasedEditRecord({ ...base, rec: undefined })).toBeNull()
	})
})

describe("canEditVideo and the in-place video gate", () => {
	it("edits a video in the user's own drive in a container the export reads", () => {
		for (const name of ["a.mp4", "a.m4v", "a.mov", "a.mkv", "a.webm", "a.m2ts"]) {
			expect(canEditVideo(videoFile(name), "drive")).toBe(true)
		}
	})

	it("never edits outside the drive, an undecryptable file, or a container nothing reads", () => {
		expect(canEditVideo(videoFile("a.mp4"), "sharedIn")).toBe(false)
		expect(canEditVideo(videoFile("a.mp4"), "trash")).toBe(false)
		expect(canEditVideo(videoFile("a.mp4"), "recents")).toBe(false)
		expect(canEditVideo(videoFile("a.mp4", { meta: { type: "encrypted", data: "x" } }), "drive")).toBe(false)
		expect(canEditVideo(videoFile("a.avi"), "drive")).toBe(false)
	})

	it("saves in place only as MP4 or QuickTime", () => {
		expect(isEditable(videoFile("a.mp4"), "drive")).toBe(true)
		expect(isEditable(videoFile("a.mov"), "drive")).toBe(true)
		expect(isEditable(videoFile("a.mkv"), "drive")).toBe(false)
		expect(isEditable(videoFile("a.mp4"), "sharedIn")).toBe(false)
	})
})

describe("runPreviewSave with a streamed export", () => {
	it("checks the quota on the estimate and hands the upload its transfer, never the estimate as a size", async () => {
		const needed: bigint[] = []
		let options: Record<string, unknown> = {}
		const deps: PreviewSaveDeps = {
			uploadFileBytes: () => Promise.reject(new Error("unused")),
			uploadFileFromPort: (_parent, _port, _name, _mime, given) => {
				options = { ...given }

				return Promise.resolve({
					uuid: NEW,
					parent: testUuid("parent"),
					size: 10n,
					favorited: false,
					region: "de-1",
					bucket: "filen-1",
					timestamp: 1n,
					chunks: 1n,
					canMakeThumbnail: true,
					meta: { type: "decoded", data: { name: "a.mp4", mime: "video/mp4", modified: 1n, size: 10n, key: "key", version: 2 } }
				} as SdkFile)
			},
			patchListing: () => undefined,
			checkQuota: bytes => {
				needed.push(bytes)

				return Promise.resolve({ status: "fits" } as const)
			},
			rootUuid: testUuid("root")
		}
		const { port1, port2 } = new MessageChannel()
		const outcome = await runPreviewSave(deps, {
			item: videoFile("a.mp4"),
			content: { port: port2, quotaBytes: 1234.5, transferId: "t1" }
		})

		port1.close()

		expect(outcome.status).toBe("success")
		expect(needed).toEqual([1235n])
		expect(options["transferId"]).toBe("t1")
		expect(options["size"]).toBeUndefined()
	})
})

describe("edited tags", () => {
	it("keeps text tags and the creation time, drops binary atoms and, on request, location", () => {
		const created = new Date("2020-02-02T00:00:00Z")
		const source = {
			title: "Trip",
			creationTime: created,
			raw: {
				"©xyz": "+1+2/",
				"com.apple.quicktime.location.ISO6709": "+1+2/",
				"com.apple.quicktime.make": "Apple",
				udta: new Uint8Array(4)
			}
		}

		expect(editedTags(source, { removeLocation: false, fallbackCreationTime: null }).raw).toEqual({
			"©xyz": "+1+2/",
			"com.apple.quicktime.location.ISO6709": "+1+2/",
			"com.apple.quicktime.make": "Apple"
		})

		const removed = editedTags(source, { removeLocation: true, fallbackCreationTime: 5 })

		expect(removed.raw).toEqual({ "com.apple.quicktime.make": "Apple" })
		expect(removed.creationTime).toBe(created)
		expect(removed.title).toBe("Trip")
		expect(isLocationTag("com.android.location")).toBe(true)
	})

	it("names the fallback creation time, or none (never now)", () => {
		expect(editedTags({}, { removeLocation: false, fallbackCreationTime: 7 }).creationTime?.getTime()).toBe(7)
		expect(editedTags({}, { removeLocation: false, fallbackCreationTime: null }).creationTime).toBeNull()
	})
})

describe("InterleaveGate", () => {
	it("holds a lane more than the slack ahead of the slowest, and releases it as that one moves or ends", async () => {
		const gate = new InterleaveGate(1)

		gate.addLane("video")
		gate.addLane("audio")

		let passed = false
		const waiting = gate.advance("video", 5).then(() => {
			passed = true
		})

		await Promise.resolve()
		expect(passed).toBe(false)

		await gate.advance("audio", 3.5)
		await Promise.resolve()
		expect(passed).toBe(false)

		await gate.advance("audio", 4)
		await waiting
		expect(passed).toBe(true)
		expect(gate.progress).toBe(4)

		const late = gate.advance("video", 10)

		gate.finish("audio")
		await late
		expect(gate.progress).toBe(10)
	})

	it("releases everyone when stopped", async () => {
		const gate = new InterleaveGate(1)

		gate.addLane("video")
		gate.addLane("audio")

		const waiting = gate.advance("video", 50)

		gate.stop()
		await expect(waiting).resolves.toBeUndefined()
	})
})
