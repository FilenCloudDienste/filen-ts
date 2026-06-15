import { vi, describe, it, expect, beforeEach } from "vitest"

// ------------------------------------------------------------------
// Hoisted mocks (must be defined before any imports)
// ------------------------------------------------------------------

const { mockTransfersUpload, mockAlertsError, mockAlertsNormal, mockGetDocumentAsync } = vi.hoisted(() => ({
	mockTransfersUpload: vi.fn(),
	mockAlertsError: vi.fn(),
	mockAlertsNormal: vi.fn(),
	mockGetDocumentAsync: vi.fn()
}))

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("@/lib/imageConversion", () => ({
	isConvertHeicToJpgEnabled: vi.fn().mockResolvedValue(false),
	convertHeicToJpg: vi.fn(async (file: unknown) => file)
}))

vi.mock("@filen/sdk-rs", () => ({
	AnyNormalDir: class {}
}))

vi.mock("expo-document-picker", () => ({
	getDocumentAsync: mockGetDocumentAsync
}))

vi.mock("expo-image-picker", () => ({
	launchImageLibraryAsync: vi.fn(),
	launchCameraAsync: vi.fn(),
	UIImagePickerPresentationStyle: { PAGE_SHEET: "pageSheet" }
}))

vi.mock("react-native-document-scanner-plugin", () => ({
	default: { scanDocument: vi.fn() },
	ResponseType: { ImageFilePath: "imageFilePath" },
	ScanDocumentResponseStatus: { Success: "success" }
}))

vi.mock("@/lib/paths", () => ({
	normalizeFilePathForExpo: vi.fn((path: string) => path)
}))

vi.mock("@/hooks/useMediaPermissions", () => ({
	hasAllNeededMediaPermissions: vi.fn().mockResolvedValue(true)
}))

vi.mock("@/lib/systemPresentation", () => ({
	withSystemPresentation: vi.fn(async (fn: () => unknown) => await fn())
}))

vi.mock("@/features/transfers/transfers", () => ({
	default: {
		upload: mockTransfersUpload
	}
}))

vi.mock("@/lib/alerts", () => ({
	default: {
		error: mockAlertsError,
		normal: mockAlertsNormal
	}
}))

vi.mock("@/lib/prompts", () => ({
	default: { input: vi.fn(), alert: vi.fn() }
}))

vi.mock("@/components/ui/fullScreenLoadingModal", () => ({
	runWithLoading: vi.fn()
}))

vi.mock("@/lib/tmp", () => ({
	newTmpDir: vi.fn()
}))

vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapFileMeta: vi.fn(),
	unwrappedFileIntoDriveItem: vi.fn()
}))

vi.mock("@/stores/useDrivePreview.store", () => ({
	useDrivePreviewStore: {
		getState: () => ({ open: vi.fn() })
	}
}))

// ------------------------------------------------------------------
// Imports (after all vi.mock calls)
// ------------------------------------------------------------------

import { type TFunction } from "i18next"
import { type Result } from "@filen/utils"
import { fs } from "@/tests/mocks/expoFileSystem"
import { summarizeTransferResults, useDriveUpload } from "@/features/drive/hooks/useDriveUpload"
import type { DrivePath } from "@/hooks/useDrivePath"

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function fulfilled<T>(data: T): PromiseSettledResult<Result<T>> {
	return {
		status: "fulfilled",
		value: {
			success: true,
			data,
			error: null
		}
	}
}

function failed(error: unknown): PromiseSettledResult<Result<unknown>> {
	return {
		status: "fulfilled",
		value: {
			success: false,
			data: null,
			error
		}
	}
}

function rejected(reason: unknown): PromiseSettledResult<Result<unknown>> {
	return {
		status: "rejected",
		reason
	}
}

const uploadOk = { files: [], directories: [] }

// ------------------------------------------------------------------
// 1. C2 — summarizeTransferResults: aborts are neither successes nor failures
// ------------------------------------------------------------------

describe("summarizeTransferResults (C2)", () => {
	it("counts a resolved non-null upload as succeeded", () => {
		const summary = summarizeTransferResults([fulfilled(uploadOk)])

		expect(summary).toEqual({
			succeeded: 1,
			failed: 0,
			aborted: 0,
			errors: []
		})
	})

	it("counts a null upload result (abort) as aborted — NOT succeeded, NOT failed", () => {
		const summary = summarizeTransferResults([fulfilled(null)])

		expect(summary.succeeded).toBe(0)
		expect(summary.failed).toBe(0)
		expect(summary.aborted).toBe(1)
		expect(summary.errors).toEqual([])
	})

	it("collects failure errors from both run-Failure results and rejected settlements", () => {
		const runError = new Error("run failed")
		const rejection = new Error("rejected")
		const summary = summarizeTransferResults([failed(runError), rejected(rejection), fulfilled(uploadOk)])

		expect(summary.succeeded).toBe(1)
		expect(summary.failed).toBe(2)
		expect(summary.aborted).toBe(0)
		expect(summary.errors).toEqual([runError, rejection])
	})

	it("mixed batch: aborts inflate neither succeeded nor failed", () => {
		const summary = summarizeTransferResults([fulfilled(uploadOk), fulfilled(null), fulfilled(null), failed(new Error("boom"))])

		expect(summary.succeeded).toBe(1)
		expect(summary.failed).toBe(1)
		expect(summary.aborted).toBe(2)
	})

	it("all-aborted batch yields zero successes and zero failures", () => {
		const summary = summarizeTransferResults([fulfilled(null), fulfilled(null)])

		expect(summary).toEqual({
			succeeded: 0,
			failed: 0,
			aborted: 2,
			errors: []
		})
	})

	it("empty batch yields all zeros", () => {
		expect(summarizeTransferResults([])).toEqual({
			succeeded: 0,
			failed: 0,
			aborted: 0,
			errors: []
		})
	})
})

// ------------------------------------------------------------------
// 2. C2 — toast wiring through the real upload flow (uploadFiles)
// ------------------------------------------------------------------

describe("useDriveUpload reportTransferResults wiring (C2)", () => {
	// Record key + params so plural/count interpolation is assertable.
	const t = ((key: string, params?: Record<string, unknown>) =>
		params ? `${key}:${JSON.stringify(params)}` : key) as unknown as TFunction

	const parent = { tag: "Dir", inner: [{ uuid: "parent-uuid" }] } as never
	const drivePath = { type: "drive", uuid: null } as unknown as DrivePath

	function primePicker(assetUris: string[]): void {
		mockGetDocumentAsync.mockResolvedValue({
			canceled: false,
			assets: assetUris.map(uri => ({
				uri,
				name: uri.split("/").pop() ?? "file",
				lastModified: 1000,
				mimeType: "application/octet-stream"
			}))
		})

		for (const uri of assetUris) {
			fs.set(uri, new Uint8Array([1]))
		}
	}

	beforeEach(() => {
		fs.clear()
		mockTransfersUpload.mockReset()
		mockAlertsError.mockClear()
		mockAlertsNormal.mockClear()
		mockGetDocumentAsync.mockReset()
	})

	it("an all-aborted batch shows NO success toast and NO error banner", async () => {
		primePicker(["file:///document/a.bin", "file:///document/b.bin"])

		// transfers.upload resolves null on abort — the user cancelled, nothing succeeded.
		mockTransfersUpload.mockResolvedValue(null)

		const { uploadFiles } = useDriveUpload({
			parent,
			drivePath,
			t
		})

		await uploadFiles()

		expect(mockTransfersUpload).toHaveBeenCalledTimes(2)
		expect(mockAlertsNormal).not.toHaveBeenCalled()
		expect(mockAlertsError).not.toHaveBeenCalled()
	})

	it("aborted uploads are excluded from the success toast count", async () => {
		primePicker(["file:///document/a.bin", "file:///document/b.bin"])

		mockTransfersUpload.mockResolvedValueOnce(null).mockResolvedValueOnce(uploadOk)

		const { uploadFiles } = useDriveUpload({
			parent,
			drivePath,
			t
		})

		await uploadFiles()

		// One actual success: a clean "Upload complete (1)" toast, no failures suffix —
		// the aborted entry counts as neither success nor failure.
		expect(mockAlertsNormal).toHaveBeenCalledTimes(1)
		expect(mockAlertsNormal).toHaveBeenCalledWith('upload_complete:{"count":1}')
		expect(mockAlertsError).not.toHaveBeenCalled()
	})

	it("aborts do not inflate the failed count in the with-failures toast", async () => {
		primePicker(["file:///document/a.bin", "file:///document/b.bin", "file:///document/c.bin"])

		mockTransfersUpload.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("upload failed")).mockResolvedValueOnce(uploadOk)

		const { uploadFiles } = useDriveUpload({
			parent,
			drivePath,
			t
		})

		await uploadFiles()

		// The genuine failure is alerted...
		expect(mockAlertsError).toHaveBeenCalledTimes(1)

		// ...and the toast reports 1 succeeded / 1 failed — the abort appears in neither.
		expect(mockAlertsNormal).toHaveBeenCalledTimes(1)
		expect(mockAlertsNormal).toHaveBeenCalledWith('upload_complete_with_failures:{"count":1,"failed":1}')
	})
})
