/**
 * Mock of the camera-upload store for Vitest: getState() hands out stable spies so tests can assert
 * on what the (headless) sync surfaced.
 *
 * Usage in test files:
 *
 *   vi.mock("@/features/cameraUpload/store/useCameraUpload.store", async () => await import("@/tests/mocks/useCameraUploadStore"))
 *
 *   import { mockSetSyncing, mockAddError } from "@/tests/mocks/useCameraUploadStore"
 */

import { vi } from "vitest"

export const mockSetSyncing = vi.fn()
export const mockAddError = vi.fn()
export const mockAddSkippedAsset = vi.fn()
export const mockRemoveSkippedAsset = vi.fn()
export const mockClearSkippedAssets = vi.fn()

export default {
	getState: () => ({
		setSyncing: mockSetSyncing,
		addError: mockAddError,
		addSkippedAsset: mockAddSkippedAsset,
		removeSkippedAsset: mockRemoveSkippedAsset,
		clearSkippedAssets: mockClearSkippedAssets
	})
}
