import { describe, it, expect, vi, beforeEach } from "vitest"

const loggerMock = vi.hoisted(() => ({
	flushNow: vi.fn(),
	listLogFiles: vi.fn()
}))

const shareMock = vi.hoisted(() => ({
	shareTmpFile: vi.fn().mockResolvedValue({ success: true, data: undefined, error: null })
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

vi.mock("@/lib/logger", () => ({ default: loggerMock }))
vi.mock("@/lib/share", () => shareMock)
vi.mock("@/lib/tmp", () => tmpMock)
vi.mock("@/lib/i18n", () => ({ default: { language: "en" } }))
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "9.9.9" }, nativeBuildVersion: "42" } }))
vi.mock("expo-file-system", () => ({ Paths: { availableDiskSpace: 100, totalDiskSpace: 200 } }))

import diagnostics from "@/features/settings/diagnostics"

describe("diagnostics.exportLogs", () => {
	beforeEach(() => {
		loggerMock.flushNow.mockClear()
		loggerMock.listLogFiles.mockReset()
		shareMock.shareTmpFile.mockClear()
		tmpMock.newTmpFile.mockClear()
		tmpFile.write.mockClear()
		tmpFile.delete.mockClear()
		tmpFile.exists = false
	})

	it("flushes and returns 'no-logs' (no share) when there are no log files", async () => {
		loggerMock.listLogFiles.mockReturnValue([])

		const result = await diagnostics.exportLogs()

		expect(result).toBe("no-logs")
		expect(loggerMock.flushNow).toHaveBeenCalled()
		expect(shareMock.shareTmpFile).not.toHaveBeenCalled()
	})

	it("bundles logs + a device-info header into a zip and shares it", async () => {
		loggerMock.listLogFiles.mockReturnValue([
			{ name: "current.ndjson", bytesSync: () => new TextEncoder().encode('{"l":"error","msg":"boom"}\n') }
		])

		const result = await diagnostics.exportLogs()

		expect(result).toBe("shared")
		expect(tmpFile.write).toHaveBeenCalledTimes(1)

		const written = tmpFile.write.mock.calls[0]![0] as Uint8Array

		expect(written).toBeInstanceOf(Uint8Array)
		expect(written.length).toBeGreaterThan(0)

		expect(shareMock.shareTmpFile).toHaveBeenCalledWith(
			expect.objectContaining({
				uri: tmpFile.uri,
				name: tmpFile.name,
				mimeType: "application/zip"
			})
		)
	})

	it("skips a log file that fails to read but still exports the rest", async () => {
		loggerMock.listLogFiles.mockReturnValue([
			{
				name: "bad.ndjson",
				bytesSync: () => {
					throw new Error("gone")
				}
			},
			{ name: "current.ndjson", bytesSync: () => new TextEncoder().encode("ok\n") }
		])

		const result = await diagnostics.exportLogs()

		expect(result).toBe("shared")
		expect(shareMock.shareTmpFile).toHaveBeenCalled()
	})
})
