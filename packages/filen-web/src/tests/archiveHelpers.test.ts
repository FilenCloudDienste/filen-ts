import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CompressFormat } from "@filen/sdk-rs"
import type { ArchiveFormatInfo, ArchiveNameInfo } from "@/workers/sdk.worker"

const { archiveCodecMemBudget, archiveFormatInfo, archiveNameInfo } = vi.hoisted(() => ({
	archiveCodecMemBudget: vi.fn<() => Promise<number>>(),
	archiveFormatInfo: vi.fn<(formats: CompressFormat[]) => Promise<ArchiveFormatInfo[]>>(),
	archiveNameInfo: vi.fn<(names: string[]) => Promise<ArchiveNameInfo[]>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { archiveCodecMemBudget, archiveFormatInfo, archiveNameInfo } }))

function formatInfo(extension: string): ArchiveFormatInfo {
	return { extension, levels: null, maxLevel: null, encoderMemory: null }
}

function answerFormats(): void {
	archiveFormatInfo.mockImplementation(formats => Promise.resolve(formats.map(format => formatInfo(`.${format.type}`))))
}

function answerNames(): void {
	archiveNameInfo.mockImplementation(names => Promise.resolve(names.map(name => ({ format: null, defaultName: name.toUpperCase() }))))
}

// Each test gets fresh module-level caches.
async function helpers() {
	vi.resetModules()

	return import("@/features/drive/lib/archiveHelpers")
}

beforeEach(() => {
	archiveCodecMemBudget.mockReset()
	archiveFormatInfo.mockReset()
	archiveNameInfo.mockReset()
})

describe("archiveHelpers", () => {
	it("reads the codec budget once a page, and again after a failed read", async () => {
		const { archiveCodecMemBudget: budget } = await helpers()

		archiveCodecMemBudget.mockRejectedValueOnce(new Error("not booted")).mockResolvedValue(128)

		await expect(budget()).rejects.toThrow("not booted")
		await expect(budget()).resolves.toBe(128)
		await expect(budget()).resolves.toBe(128)
		expect(archiveCodecMemBudget).toHaveBeenCalledTimes(2)
	})

	it("asks for one tick's formats in one call, and each format once", async () => {
		const { archiveFormatInfo: info, archiveFormatInfos } = await helpers()
		const zip: CompressFormat = { type: "zip", method: { type: "deflate", level: 6 } }
		const tar: CompressFormat = { type: "tar", compression: { codec: "gzip" } }

		answerFormats()

		const [infos, again] = await Promise.all([
			archiveFormatInfos([zip, tar]),
			info({ method: { level: 6, type: "deflate" }, type: "zip" })
		])

		expect(archiveFormatInfo).toHaveBeenCalledTimes(1)
		expect(archiveFormatInfo.mock.calls[0]?.[0]).toEqual([zip, tar])
		expect(infos.map(entry => entry.extension)).toEqual([".zip", ".tar"])
		expect(again.extension).toBe(".zip")

		await info(tar)

		expect(archiveFormatInfo).toHaveBeenCalledTimes(1)
	})

	it("forgets a format whose call failed", async () => {
		const { archiveFormatInfo: info } = await helpers()
		const zip: CompressFormat = { type: "zip", method: { type: "stored" } }

		archiveFormatInfo.mockRejectedValueOnce(new Error("worker gone"))

		await expect(info(zip)).rejects.toThrow("worker gone")

		answerFormats()

		await expect(info(zip)).resolves.toMatchObject({ extension: ".zip" })
		expect(archiveFormatInfo).toHaveBeenCalledTimes(2)
	})

	it("keys formats by every field, whatever their order", async () => {
		const { compressFormatKey } = await helpers()

		expect(compressFormatKey({ type: "sevenZ", method: { type: "lzma2", level: 9 }, solid: true, encryption: "entries" })).toBe(
			compressFormatKey({ encryption: "entries", solid: true, method: { level: 9, type: "lzma2" }, type: "sevenZ" })
		)
		expect(compressFormatKey({ type: "sevenZ", method: { type: "lzma2", level: 9 }, solid: true })).not.toBe(
			compressFormatKey({ type: "sevenZ", method: { type: "lzma2", level: 9 }, solid: false })
		)
		expect(compressFormatKey({ type: "tar" })).not.toBe(compressFormatKey({ type: "tar", compression: { codec: "gzip" } }))
		expect(compressFormatKey({ type: "single", compression: { codec: "zstd", level: 3 } })).toBe("single:zstd:3")
	})

	it("asks for one tick's names in one call, shares a question in flight, and answers a re-opened menu at once", async () => {
		const { archiveNameInfo: info, cachedArchiveNameInfo } = await helpers()

		answerNames()

		expect(cachedArchiveNameInfo("a.zip")).toBeUndefined()

		const [a, b, aAgain] = await Promise.all([info("a.zip"), info("b.tar"), info("a.zip")])

		expect(archiveNameInfo).toHaveBeenCalledTimes(1)
		expect(archiveNameInfo.mock.calls[0]?.[0]).toEqual(["a.zip", "b.tar"])
		expect([a.defaultName, b.defaultName, aAgain.defaultName]).toEqual(["A.ZIP", "B.TAR", "A.ZIP"])
		expect(cachedArchiveNameInfo("b.tar")).toEqual(b)

		await info("a.zip")

		expect(archiveNameInfo).toHaveBeenCalledTimes(1)
	})

	it("keeps only the most recent 512 names", async () => {
		const { archiveNameInfo: info, cachedArchiveNameInfo } = await helpers()

		answerNames()

		await Promise.all(Array.from({ length: 513 }, (_, index) => info(`${String(index)}.zip`)))

		expect(cachedArchiveNameInfo("0.zip")).toBeUndefined()
		expect(cachedArchiveNameInfo("1.zip")).toBeDefined()
		expect(cachedArchiveNameInfo("512.zip")).toBeDefined()
	})
})
