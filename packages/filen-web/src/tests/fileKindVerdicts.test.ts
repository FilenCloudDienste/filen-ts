import { afterEach, describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import type { VideoProbe } from "@filen/shared/videos"

// Content verdicts: kept per uuid in kv under a versioned prefix, the newest few thousand, read
// synchronously, filled from kv once attached, forgotten at logout; and what a probe says about a file's
// kind, kept only where it changes it.

const kv = vi.hoisted(() => ({
	rows: new Map<string, unknown>(),
	kvEntriesJson: vi.fn(),
	kvSetJson: vi.fn(),
	kvDelete: vi.fn()
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvEntriesJson: kv.kvEntriesJson,
	kvSetJson: kv.kvSetJson,
	kvDelete: kv.kvDelete
}))

const { VERDICT_KV_PREFIX } = await import("@filen/shared")
const { probeVerdict } = await import("@/features/drive/lib/fileKindVerdicts.logic")
const { fileKindVerdict, recordFileKindVerdict, resetFileKindVerdicts, subscribeFileKindVerdicts } =
	await import("@/features/drive/lib/fileKindVerdicts")
const { adoptProbeRecords, recordContentVerdict, recordProbeVerdict } = await import("@/features/drive/lib/contentVerdicts")
const { connectFileKindVerdictStorage } = await import("@/features/drive/lib/fileKindVerdictStorage")

const MIB = 1024 * 1024
const { fileIconKey } = await import("@/features/drive/lib/icon.logic")

function probe(partial: Partial<VideoProbe>): VideoProbe {
	return {
		v: 1,
		container: "mp4",
		durationSec: 1,
		index: null,
		video: null,
		audio: [],
		subs: [],
		chapters: [],
		cover: null,
		coverLand: null,
		partial: false,
		...partial
	}
}

const PICTURE = { codec: "h264", fourcc: "avc1", codecString: null, w: 1, h: 1, par: 1, rotation: 0, bitDepth: 8, transfer: "sdr" } as const
const SOUND = {
	id: 1,
	codec: "opus",
	codecString: "opus",
	ch: 2,
	rate: 48_000,
	lang: null,
	name: null,
	def: true,
	forced: false,
	commentary: false
} as const

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve()
		await new Promise(resolve => setTimeout(resolve, 0))
	}
}

afterEach(() => {
	resetFileKindVerdicts()
	vi.clearAllMocks()
})

describe("probeVerdict", () => {
	it("settles a .ts name by the container alone", () => {
		expect(probeVerdict(probe({ container: "ts" }), true)).toBe("transportStream")
		expect(probeVerdict(null, true)).toBe("notTransportStream")
		expect(probeVerdict(probe({ container: "mp4" }), true)).toBe("notTransportStream")
	})

	it("calls a file video by its picture, audio only after a complete walk found none", () => {
		expect(probeVerdict(probe({ video: PICTURE }), false)).toBe("video")
		expect(probeVerdict(probe({ audio: [SOUND] }), false)).toBe("audio")
		expect(probeVerdict(probe({ audio: [SOUND], partial: true }), false)).toBeNull()
		expect(probeVerdict(null, false)).toBeNull()
	})
})

describe("file-kind verdict cache", () => {
	it("reads kv once when attached, writes each new verdict under the versioned prefix, and forgets at logout", async () => {
		recordFileKindVerdict("early", "audio")
		kv.kvEntriesJson.mockResolvedValue([[`${VERDICT_KV_PREFIX}old`, { v: "transportStream", at: 1 }]])
		kv.kvSetJson.mockResolvedValue(undefined)

		expect(fileKindVerdict("old")).toBeUndefined()
		connectFileKindVerdictStorage()
		connectFileKindVerdictStorage()
		await settle()
		expect(fileKindVerdict("old")).toBe("transportStream")
		// Written before kv was attached: kept, merged with what kv held.
		expect(fileKindVerdict("early")).toBe("audio")

		recordFileKindVerdict("new", "audio")
		recordFileKindVerdict("new", "audio")
		await settle()

		expect(kv.kvEntriesJson).toHaveBeenCalledOnce()
		expect(kv.kvSetJson).toHaveBeenCalledOnce()
		expect(kv.kvSetJson.mock.calls[0]?.[0]).toBe(`${VERDICT_KV_PREFIX}new`)

		const heard: (readonly string[] | null)[] = []
		const stop = subscribeFileKindVerdicts(uuids => heard.push(uuids))

		recordFileKindVerdict("named", "audio")
		resetFileKindVerdicts()
		stop()

		expect(fileKindVerdict("new")).toBeUndefined()
		// A change names its file; a reset concerns every file.
		expect(heard).toEqual([["named"], null])
	})

	it("keeps a memory-only verdict out of kv until a persistent record of it", async () => {
		kv.kvEntriesJson.mockResolvedValue([])
		kv.kvSetJson.mockResolvedValue(undefined)
		connectFileKindVerdictStorage()
		await settle()

		recordFileKindVerdict("visited", "audio", { memoryOnly: true })
		recordFileKindVerdict("visited", "audio", { memoryOnly: true })
		await settle()

		expect(fileKindVerdict("visited")).toBe("audio")
		expect(kv.kvSetJson).not.toHaveBeenCalled()

		recordFileKindVerdict("visited", "audio")
		recordFileKindVerdict("visited", "audio")
		await settle()

		expect(kv.kvSetJson).toHaveBeenCalledOnce()
		expect(kv.kvSetJson.mock.calls[0]?.[0]).toBe(`${VERDICT_KV_PREFIX}visited`)
	})

	it.each(["wordBinary", "notWordBinary", "presentationBinary", "notPresentationBinary"] as const)(
		"holds the document verdict %s in memory only",
		async verdict => {
			kv.kvEntriesJson.mockResolvedValue([])
			kv.kvSetJson.mockResolvedValue(undefined)
			connectFileKindVerdictStorage()
			await settle()

			recordFileKindVerdict(`read-${verdict}`, verdict)
			await settle()

			expect(fileKindVerdict(`read-${verdict}`)).toBe(verdict)
			expect(kv.kvSetJson).not.toHaveBeenCalled()
		}
	)

	it("gives a .ts the video glyph only once a probe read it as a transport stream", async () => {
		kv.kvEntriesJson.mockResolvedValue([])
		kv.kvSetJson.mockResolvedValue(undefined)

		expect(fileIconKey("clip.ts", "video/mp2t", "u1")).not.toBe("video")

		recordProbeVerdict({ uuid: "u1", name: "clip.ts", mime: "video/mp2t", size: 40 * MIB }, probe({ container: "ts", video: PICTURE }))
		await settle()

		expect(fileIconKey("clip.ts", "video/mp2t", "u1")).toBe("video")
		expect(fileIconKey("clip.ts", "video/mp2t", "u2")).not.toBe("video")
	})
})

describe("probe records feed the verdicts", () => {
	it("records what every record of an adopted probe service says, by the file's own name", async () => {
		kv.kvEntriesJson.mockResolvedValue([])
		kv.kvSetJson.mockResolvedValue(undefined)

		const listeners: ((uuid: string, record: { probe: VideoProbe | null }, file: AnyFile) => void)[] = []
		const emit = (uuid: string, record: { probe: VideoProbe | null }, file: AnyFile): void => {
			for (const listener of listeners) {
				listener(uuid, record, file)
			}
		}
		const service = {
			onRecord: (listener: (uuid: string, record: { probe: VideoProbe | null }, file: AnyFile) => void) => {
				listeners.push(listener)

				return () => undefined
			}
		}
		const named = (name: string, size = 40 * MIB): AnyFile =>
			({ meta: { type: "decoded", data: { name, mime: "" } }, size: BigInt(size) }) as unknown as AnyFile

		adoptProbeRecords(service)
		adoptProbeRecords(service)

		expect(listeners).toHaveLength(1)

		emit("ts-yes", { probe: probe({ container: "ts", video: PICTURE }) }, named("clip.ts"))
		emit("ts-no", { probe: null }, named("server.ts"))
		emit("webm", { probe: probe({ container: "webm", audio: [SOUND] }) }, named("talk.webm"))
		emit("encrypted", { probe: probe({ container: "ts", video: PICTURE }) }, {
			meta: { type: "encrypted", data: "" }
		} as unknown as AnyFile)
		await settle()

		expect(fileKindVerdict("ts-yes")).toBe("transportStream")
		expect(fileKindVerdict("ts-no")).toBe("notTransportStream")
		expect(fileKindVerdict("webm")).toBe("audio")
		expect(fileKindVerdict("encrypted")).toBeUndefined()
	})
})

describe("only verdicts that change a file's kind are kept", () => {
	it("drops confirmations of what the name already says", async () => {
		kv.kvEntriesJson.mockResolvedValue([])
		kv.kvSetJson.mockResolvedValue(undefined)

		recordProbeVerdict({ uuid: "mp4", name: "film.mp4", mime: "video/mp4", size: MIB }, probe({ video: PICTURE }))
		recordProbeVerdict({ uuid: "webm", name: "film.webm", mime: "", size: MIB }, probe({ container: "webm", video: PICTURE }))
		recordProbeVerdict({ uuid: "mov", name: "film.mov", mime: "", size: MIB }, probe({ container: "mov", audio: [SOUND] }))
		recordContentVerdict({ uuid: "small", name: "index.ts", mime: "video/mp2t", size: 4_000 }, "notTransportStream")
		recordContentVerdict({ uuid: "decl", name: "lib.d.ts", mime: "video/mp2t", size: 40 * MIB }, "notTransportStream")
		await settle()

		for (const uuid of ["mp4", "webm", "mov", "small", "decl"]) {
			expect(fileKindVerdict(uuid)).toBeUndefined()
		}

		expect(kv.kvSetJson).not.toHaveBeenCalled()
	})

	it("keeps one that moves the file to another kind, or settles a .ts large enough to be a stream", () => {
		kv.kvEntriesJson.mockResolvedValue([])
		kv.kvSetJson.mockResolvedValue(undefined)

		recordProbeVerdict({ uuid: "audio", name: "voice.mp4", mime: "video/mp4", size: MIB }, probe({ audio: [SOUND] }))
		recordContentVerdict({ uuid: "code", name: "server.mts", mime: "", size: 4 * MIB }, "notTransportStream")

		expect(fileKindVerdict("audio")).toBe("audio")
		expect(fileKindVerdict("code")).toBe("notTransportStream")
	})
})
