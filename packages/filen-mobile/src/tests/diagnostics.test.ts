import { describe, it, expect, vi, beforeEach } from "vitest"

const loggerMock = vi.hoisted(() => ({
	flushNow: vi.fn(),
	listLogFiles: vi.fn(),
	warn: vi.fn()
}))

const tmpFile = vi.hoisted(() => ({
	uri: "file:///cache/filen-tmp/filen-logs.zip",
	name: "filen-logs.zip",
	exists: false,
	write: vi.fn(),
	delete: vi.fn()
}))

const tmpMock = vi.hoisted(() => ({
	newTmpFile: vi.fn(() => tmpFile)
}))

const backgroundRunLogMock = vi.hoisted(() => ({
	list: vi.fn(async () => [] as unknown[])
}))

vi.mock("@/lib/logger", () => ({ default: loggerMock }))
vi.mock("@/lib/tmp", () => tmpMock)
vi.mock("@/lib/i18n", () => ({ default: { language: "en" } }))
// Stubbed rather than pulled in: the real module reaches op-sqlite, which has no node build here.
vi.mock("@/features/cameraUpload/backgroundRunLog", () => ({ default: backgroundRunLogMock }))
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "9.9.9" }, nativeBuildVersion: "42" } }))
vi.mock("expo-file-system", () => ({ Paths: { availableDiskSpace: 100, totalDiskSpace: 200 } }))

import diagnostics from "@/features/settings/diagnostics"

describe("diagnostics.prepareLogsExport", () => {
	beforeEach(() => {
		loggerMock.flushNow.mockClear()
		loggerMock.listLogFiles.mockReset()
		tmpMock.newTmpFile.mockClear()
		tmpFile.write.mockClear()
		tmpFile.delete.mockClear()
		tmpFile.exists = false
		backgroundRunLogMock.list.mockReset()
		backgroundRunLogMock.list.mockResolvedValue([])
	})

	it("flushes and returns 'no-logs' (no tmp file written) when there are no log files", async () => {
		loggerMock.listLogFiles.mockReturnValue([])

		const result = await diagnostics.prepareLogsExport()

		expect(result).toBe("no-logs")
		expect(loggerMock.flushNow).toHaveBeenCalled()
		expect(tmpFile.write).not.toHaveBeenCalled()
	})

	it("bundles logs + a device-info header into a zip and returns the tmp file for the caller to share", async () => {
		loggerMock.listLogFiles.mockReturnValue([
			{ name: "current.ndjson", bytesSync: () => new TextEncoder().encode('{"l":"error","msg":"boom"}\n') }
		])

		const result = await diagnostics.prepareLogsExport()

		// Returns the prepared file (it does NOT share — the caller opens the share sheet OUTSIDE the
		// loading overlay, so the overlay can't cover the native sheet).
		expect(result).toEqual(
			expect.objectContaining({
				uri: tmpFile.uri,
				name: tmpFile.name,
				cleanup: expect.any(Function)
			})
		)
		expect(tmpFile.write).toHaveBeenCalledTimes(1)

		const written = tmpFile.write.mock.calls[0]![0] as Uint8Array

		expect(written).toBeInstanceOf(Uint8Array)
		expect(written.length).toBeGreaterThan(0)

		// Unzip the actual archive and verify it contains BOTH the device-info header and the log
		// file's real bytes — not just "some non-empty buffer".
		const JSZip = (await import("jszip")).default
		const archive = await JSZip.loadAsync(written)

		expect(archive.file("device-info.json")).not.toBeNull()
		expect(archive.file("current.ndjson")).not.toBeNull()

		const logText = await archive.file("current.ndjson")!.async("string")

		expect(logText).toContain("boom")

		const info = JSON.parse(await archive.file("device-info.json")!.async("string")) as Record<string, unknown>

		expect(info["appVersion"]).toBe("9.9.9")
		expect(info["platform"]).toBeDefined()
	})

	it("bundles the background run log, the only record a headless run leaves", async () => {
		loggerMock.listLogFiles.mockReturnValue([
			{ name: "current.ndjson", bytesSync: () => new TextEncoder().encode("ok\n") }
		])
		backgroundRunLogMock.list.mockResolvedValue([
			{ v: 1, startedAt: 1, finishedAt: 2, phase: "done", cancelled: false, result: "success", cameraUploaded: 0, cameraSkipReason: "lowPower" }
		])

		const result = await diagnostics.prepareLogsExport()

		expect(result).not.toBe("no-logs")

		const written = tmpFile.write.mock.calls[0]![0] as Uint8Array
		const JSZip = (await import("jszip")).default
		const archive = await JSZip.loadAsync(written)

		expect(archive.file("background-runs.json")).not.toBeNull()

		const runs = JSON.parse(await archive.file("background-runs.json")!.async("string")) as Record<string, unknown>[]

		// The whole point: a run that uploaded nothing now says WHY, instead of reading as a success
		// indistinguishable from one that had nothing to do.
		expect(runs[0]!["cameraSkipReason"]).toBe("lowPower")
		expect(runs[0]!["cameraUploaded"]).toBe(0)
	})

	it("still exports when only background runs exist and no log file was ever written", async () => {
		loggerMock.listLogFiles.mockReturnValue([])
		backgroundRunLogMock.list.mockResolvedValue([
			{ v: 1, startedAt: 1, finishedAt: 2, phase: "camera", cancelled: false, result: "success" }
		])

		const result = await diagnostics.prepareLogsExport()

		expect(result).not.toBe("no-logs")
		expect(tmpFile.write).toHaveBeenCalled()
	})

	it("still exports when the background run log cannot be read", async () => {
		loggerMock.listLogFiles.mockReturnValue([
			{ name: "current.ndjson", bytesSync: () => new TextEncoder().encode("ok\n") }
		])
		backgroundRunLogMock.list.mockRejectedValue(new Error("kv unavailable"))

		const result = await diagnostics.prepareLogsExport()

		expect(result).toEqual(expect.objectContaining({ uri: tmpFile.uri }))
	})

	it("skips a log file that fails to read but still prepares the rest", async () => {
		loggerMock.listLogFiles.mockReturnValue([
			{
				name: "bad.ndjson",
				bytesSync: () => {
					throw new Error("gone")
				}
			},
			{ name: "current.ndjson", bytesSync: () => new TextEncoder().encode("ok\n") }
		])

		const result = await diagnostics.prepareLogsExport()

		expect(result).toEqual(expect.objectContaining({ uri: tmpFile.uri, name: tmpFile.name }))
		expect(tmpFile.write).toHaveBeenCalled()
	})

	it("the returned cleanup deletes the tmp file when it exists", async () => {
		loggerMock.listLogFiles.mockReturnValue([
			{ name: "current.ndjson", bytesSync: () => new TextEncoder().encode("ok\n") }
		])

		const result = await diagnostics.prepareLogsExport()

		expect(result).not.toBe("no-logs")

		tmpFile.exists = true
		;(result as { cleanup: () => void }).cleanup()

		expect(tmpFile.delete).toHaveBeenCalled()
	})
})
