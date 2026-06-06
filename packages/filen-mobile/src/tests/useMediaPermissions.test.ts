// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

type PermissionResponse = {
	status: string
	granted: boolean
	canAskAgain: boolean
	expires: string
	accessPrivileges?: "all" | "limited" | "none"
}

const { mockMediaLibraryPermissions, mockCameraPermissions, mockMediaLibraryRequest, mockCameraRequest } = vi.hoisted(() => {
	const fullMediaLibraryGrant: PermissionResponse = {
		status: "granted",
		granted: true,
		canAskAgain: true,
		expires: "never",
		accessPrivileges: "all"
	}

	const fullCameraGrant: PermissionResponse = {
		status: "granted",
		granted: true,
		canAskAgain: true,
		expires: "never"
	}

	return {
		mockMediaLibraryPermissions: { ...fullMediaLibraryGrant } as PermissionResponse,
		mockCameraPermissions: { ...fullCameraGrant } as PermissionResponse,
		mockMediaLibraryRequest: { ...fullMediaLibraryGrant } as PermissionResponse,
		mockCameraRequest: { ...fullCameraGrant } as PermissionResponse
	}
})

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("react-native", () => ({
	AppState: {
		addEventListener: (_type: string, _handler: (state: string) => void) => ({
			remove: () => {}
		})
	}
}))

vi.mock("expo-media-library", () => ({
	getPermissionsAsync: async () => ({ ...mockMediaLibraryPermissions }),
	requestPermissionsAsync: async () => ({ ...mockMediaLibraryRequest })
}))

vi.mock("expo-image-picker", () => ({
	getCameraPermissionsAsync: async () => ({ ...mockCameraPermissions }),
	requestCameraPermissionsAsync: async () => ({ ...mockCameraRequest })
}))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

// Query mock — useMediaPermissions uses useMediaPermissionsQuery
const mockQueryData = vi.hoisted(() => ({
	status: "success" as "pending" | "error" | "success",
	data: null as { mediaLibrary: PermissionResponse; camera: PermissionResponse } | null,
	error: null as unknown,
	refetch: vi.fn()
}))

vi.mock("@/queries/useMediaPermissions.query", () => ({
	default: () => ({
		status: mockQueryData.status,
		data: mockQueryData.data,
		error: mockQueryData.error,
		refetch: mockQueryData.refetch
	})
}))

// ─── Imports ─────────────────────────────────────────────────────────────────

import { renderHook } from "@testing-library/react"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import useMediaPermissions from "@/hooks/useMediaPermissions"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setAllGranted() {
	mockMediaLibraryPermissions.granted = true
	mockMediaLibraryPermissions.accessPrivileges = "all"
	mockMediaLibraryPermissions.expires = "never"
	mockMediaLibraryPermissions.canAskAgain = true
	mockCameraPermissions.granted = true
	mockCameraPermissions.expires = "never"
	mockCameraPermissions.canAskAgain = true
	mockMediaLibraryRequest.granted = true
	mockMediaLibraryRequest.accessPrivileges = "all"
	mockMediaLibraryRequest.expires = "never"
	mockCameraRequest.granted = true
	mockCameraRequest.expires = "never"
}

beforeEach(() => {
	setAllGranted()
	mockQueryData.status = "success"
	mockQueryData.data = {
		mediaLibrary: {
			status: "granted",
			granted: true,
			canAskAgain: true,
			expires: "never",
			accessPrivileges: "all"
		},
		camera: {
			status: "granted",
			granted: true,
			canAskAgain: true,
			expires: "never"
		}
	}
	mockQueryData.error = null
	mockQueryData.refetch.mockClear()
})

// ─── hasAllNeededMediaPermissions ────────────────────────────────────────────

describe("hasAllNeededMediaPermissions", () => {
	it("returns true when all five conditions hold (no request needed)", async () => {
		const result = await hasAllNeededMediaPermissions()

		expect(result).toBe(true)
	})

	it("returns false when mediaLibrary.granted=false (short-circuits without requesting)", async () => {
		mockMediaLibraryPermissions.granted = false

		const result = await hasAllNeededMediaPermissions()

		expect(result).toBe(false)
	})

	it("returns false when accessPrivileges!='all' even if granted=true", async () => {
		mockMediaLibraryPermissions.accessPrivileges = "limited"

		const result = await hasAllNeededMediaPermissions()

		expect(result).toBe(false)
	})

	it("returns false when mediaLibrary.expires!='never'", async () => {
		mockMediaLibraryPermissions.expires = "2030-01-01"

		const result = await hasAllNeededMediaPermissions()

		expect(result).toBe(false)
	})

	it("returns false when camera.granted=false", async () => {
		mockCameraPermissions.granted = false

		const result = await hasAllNeededMediaPermissions()

		expect(result).toBe(false)
	})

	it("returns false when camera.expires!='never' with all other conditions passing", async () => {
		// All four other conditions hold; only the 5th (cameraPermissions.expires==='never') fails
		mockCameraPermissions.expires = "2030-01-01"

		const result = await hasAllNeededMediaPermissions()

		expect(result).toBe(false)
	})

	it("returns false when shouldRequest=false and permissions not already fully granted", async () => {
		mockMediaLibraryPermissions.granted = false

		const result = await hasAllNeededMediaPermissions({ shouldRequest: false })

		expect(result).toBe(false)
	})

	it("returns false when shouldRequest=true but canAskAgain=false on mediaLibrary", async () => {
		// Initial check fails
		mockMediaLibraryPermissions.granted = false
		mockMediaLibraryPermissions.canAskAgain = false

		const result = await hasAllNeededMediaPermissions({ shouldRequest: true })

		expect(result).toBe(false)
	})

	it("returns false when shouldRequest=true but canAskAgain=false on camera", async () => {
		// Initial check fails
		mockCameraPermissions.granted = false
		mockCameraPermissions.canAskAgain = false

		const result = await hasAllNeededMediaPermissions({ shouldRequest: true })

		expect(result).toBe(false)
	})

	it("returns false when shouldRequest=true, canAskAgain=true, but mediaLibrary request returns accessPrivileges!='all'", async () => {
		// Initial check fails — need to request
		mockMediaLibraryPermissions.granted = false
		mockMediaLibraryPermissions.canAskAgain = true
		mockCameraPermissions.canAskAgain = true
		// Request result has limited access
		mockMediaLibraryRequest.granted = true
		mockMediaLibraryRequest.accessPrivileges = "limited"
		mockMediaLibraryRequest.expires = "never"

		const result = await hasAllNeededMediaPermissions({ shouldRequest: true })

		expect(result).toBe(false)
	})

	it("returns false when shouldRequest=true, mediaLibrary request succeeds, but camera request fails", async () => {
		// Initial check fails
		mockMediaLibraryPermissions.granted = false
		mockMediaLibraryPermissions.canAskAgain = true
		mockCameraPermissions.canAskAgain = true
		// mediaLibrary request succeeds
		mockMediaLibraryRequest.granted = true
		mockMediaLibraryRequest.accessPrivileges = "all"
		mockMediaLibraryRequest.expires = "never"
		// camera request fails
		mockCameraRequest.granted = false

		const result = await hasAllNeededMediaPermissions({ shouldRequest: true })

		expect(result).toBe(false)
	})

	it("returns true when shouldRequest=true and both requests succeed with all conditions met", async () => {
		// Initial check fails — need to request
		mockMediaLibraryPermissions.granted = false
		mockMediaLibraryPermissions.canAskAgain = true
		mockCameraPermissions.granted = false
		mockCameraPermissions.canAskAgain = true
		// Requests both succeed
		mockMediaLibraryRequest.granted = true
		mockMediaLibraryRequest.accessPrivileges = "all"
		mockMediaLibraryRequest.expires = "never"
		mockCameraRequest.granted = true
		mockCameraRequest.expires = "never"

		const result = await hasAllNeededMediaPermissions({ shouldRequest: true })

		expect(result).toBe(true)
	})
})

// ─── useMediaPermissions — return shape derivation ───────────────────────────

describe("useMediaPermissions — return shape derivation from query data", () => {
	it("returns { loading:true, error:null, granted:false } when query status is 'pending'", () => {
		mockQueryData.status = "pending"
		mockQueryData.data = null

		const { result } = renderHook(() => useMediaPermissions())

		expect(result.current).toEqual({ loading: true, error: null, granted: false })
	})

	it("returns { loading:false, error:..., granted:false } when query status is 'error'", () => {
		mockQueryData.status = "error"
		mockQueryData.data = null
		mockQueryData.error = new Error("permission fetch failed")

		const { result } = renderHook(() => useMediaPermissions())

		expect(result.current.loading).toBe(false)
		expect(result.current.granted).toBe(false)
		expect((result.current as { error: unknown }).error).toBeInstanceOf(Error)
	})

	it("returns granted=true only when all five conditions hold", () => {
		mockQueryData.data = {
			mediaLibrary: {
				status: "granted",
				granted: true,
				canAskAgain: true,
				expires: "never",
				accessPrivileges: "all"
			},
			camera: {
				status: "granted",
				granted: true,
				canAskAgain: true,
				expires: "never"
			}
		}

		const { result } = renderHook(() => useMediaPermissions())

		expect(result.current.loading).toBe(false)
		expect(result.current.granted).toBe(true)
	})

	it("returns granted=false when camera.granted=false", () => {
		mockQueryData.data = {
			mediaLibrary: {
				status: "granted",
				granted: true,
				canAskAgain: true,
				expires: "never",
				accessPrivileges: "all"
			},
			camera: {
				status: "denied",
				granted: false,
				canAskAgain: true,
				expires: "never"
			}
		}

		const { result } = renderHook(() => useMediaPermissions())

		expect(result.current.granted).toBe(false)
	})

	it("returns granted=false when accessPrivileges!='all'", () => {
		mockQueryData.data = {
			mediaLibrary: {
				status: "granted",
				granted: true,
				canAskAgain: true,
				expires: "never",
				accessPrivileges: "limited"
			},
			camera: {
				status: "granted",
				granted: true,
				canAskAgain: true,
				expires: "never"
			}
		}

		const { result } = renderHook(() => useMediaPermissions())

		expect(result.current.granted).toBe(false)
	})

	it("returns granted=false when mediaLibrary.expires!='never'", () => {
		mockQueryData.data = {
			mediaLibrary: {
				status: "granted",
				granted: true,
				canAskAgain: true,
				expires: "2030-01-01",
				accessPrivileges: "all"
			},
			camera: {
				status: "granted",
				granted: true,
				canAskAgain: true,
				expires: "never"
			}
		}

		const { result } = renderHook(() => useMediaPermissions())

		expect(result.current.granted).toBe(false)
	})

	it("success shape contains requestPermissions function", () => {
		const { result } = renderHook(() => useMediaPermissions())

		expect(result.current.loading).toBe(false)
		// success shape has requestPermissions
		expect(typeof (result.current as { requestPermissions?: unknown }).requestPermissions).toBe("function")
	})

	it("loading shape does not have requestPermissions field", () => {
		mockQueryData.status = "pending"
		mockQueryData.data = null

		const { result } = renderHook(() => useMediaPermissions())

		expect("requestPermissions" in result.current).toBe(false)
	})

	it("error shape does not have requestPermissions field", () => {
		mockQueryData.status = "error"
		mockQueryData.data = null
		mockQueryData.error = new Error("fail")

		const { result } = renderHook(() => useMediaPermissions())

		expect("requestPermissions" in result.current).toBe(false)
	})
})
