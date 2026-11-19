// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, renderHook } from "@testing-library/react"

const { pickNativeUpload } = vi.hoisted(() => ({
	pickNativeUpload: vi.fn((_kind: string, _parentUuid: string | null) => Promise.resolve(undefined))
}))

vi.mock("@/features/transfers/lib/nativeHost", () => ({ nativeTransfersAvailable: () => true }))
vi.mock("@/features/transfers/lib/nativeTransfers", () => ({ pickNativeUpload, startNativeUploads: vi.fn() }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/features/drive/lib/upload", () => ({ startUploads: vi.fn() }))
vi.mock("@/features/drive/lib/uploadDirectory", () => ({ startDirectoryUpload: vi.fn() }))
vi.mock("@/features/drive/components/newDirectory", () => ({ NewDirectoryDialog: () => null }))
vi.mock("@/features/drive/queries/drive", () => ({
	driveListingQueryUpdate: vi.fn(),
	heicUploadConvertPreferenceCached: () => false
}))

import "@/lib/i18n"
import { useDirectoryDestination } from "@/features/drive/hooks/useDirectoryDestination"

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	cleanup()
})

describe("useDirectoryDestination on desktop with HEIC conversion off", () => {
	it("opens the native dialog for the directory the action was taken on, not the previous target", () => {
		const { result } = renderHook(() =>
			useDirectoryDestination({ disabled: false, openPreview: vi.fn(), hiddenNotice: false, testIdPrefix: "test" })
		)

		act(() => {
			result.current.actionsFor("dir-a").pickFiles()
		})

		expect(pickNativeUpload).toHaveBeenLastCalledWith("file", "dir-a")

		act(() => {
			result.current.actionsFor("dir-b").pickDirectory()
		})

		expect(pickNativeUpload).toHaveBeenLastCalledWith("directory", "dir-b")
		expect(pickNativeUpload).toHaveBeenCalledTimes(2)
	})
})
