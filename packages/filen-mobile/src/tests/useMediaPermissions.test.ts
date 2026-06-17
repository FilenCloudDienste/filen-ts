// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

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

vi.mock("expo-media-library/legacy", () => ({
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

import { renderHook, act } from "@testing-library/react"
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
		// Both permissions fail the initial check
		mockMediaLibraryPermissions.granted = false
		mockMediaLibraryPermissions.canAskAgain = true
		mockCameraPermissions.granted = false
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

	// #20 — cameraRequest.granted=true but expires!='never' is the untested OR-branch
	it("returns false when shouldRequest=true, mediaLibrary request succeeds, camera granted=true but expires!='never'", async () => {
		// Both permissions fail the initial check
		mockMediaLibraryPermissions.granted = false
		mockMediaLibraryPermissions.canAskAgain = true
		mockCameraPermissions.granted = false
		mockCameraPermissions.expires = "2099-12-31"
		mockCameraPermissions.canAskAgain = true
		// mediaLibrary request succeeds fully
		mockMediaLibraryRequest.granted = true
		mockMediaLibraryRequest.accessPrivileges = "all"
		mockMediaLibraryRequest.expires = "never"
		// camera request: granted=true but temporary (non-'never') expiry
		mockCameraRequest.granted = true
		mockCameraRequest.expires = "2099-12-31"

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

// ─── hasAllNeededMediaPermissions — scope parameterization ───────────────────

describe("hasAllNeededMediaPermissions — library scope", () => {
	it('library="all" returns false when accessPrivileges is "limited"', async () => {
		mockMediaLibraryPermissions.accessPrivileges = "limited"

		const result = await hasAllNeededMediaPermissions({ library: "all", needCamera: false })

		expect(result).toBe(false)
	})

	it('library="any" returns true when accessPrivileges is "limited" (granted=true)', async () => {
		mockMediaLibraryPermissions.accessPrivileges = "limited"

		const result = await hasAllNeededMediaPermissions({ library: "any", needCamera: false })

		expect(result).toBe(true)
	})

	it('library="any" returns true when accessPrivileges is "all" (granted=true)', async () => {
		// all is a superset of any
		const result = await hasAllNeededMediaPermissions({ library: "any", needCamera: false })

		expect(result).toBe(true)
	})

	it('library="any" returns false when mediaLibrary.granted=false', async () => {
		mockMediaLibraryPermissions.granted = false

		const result = await hasAllNeededMediaPermissions({ library: "any", needCamera: false })

		expect(result).toBe(false)
	})

	it('library="none" returns true regardless of mediaLibrary state (no camera needed)', async () => {
		mockMediaLibraryPermissions.granted = false
		mockMediaLibraryPermissions.accessPrivileges = "none"

		const result = await hasAllNeededMediaPermissions({ library: "none", needCamera: false })

		expect(result).toBe(true)
	})

	it('library="none" does not request media-library permission even with shouldRequest=true', async () => {
		mockMediaLibraryPermissions.granted = false
		mockMediaLibraryPermissions.canAskAgain = true

		// If media-library were checked, limited access would make this return false
		const result = await hasAllNeededMediaPermissions({ shouldRequest: true, library: "none", needCamera: false })

		expect(result).toBe(true)
	})
})

describe("hasAllNeededMediaPermissions — needCamera scope", () => {
	it("needCamera=false returns true even when camera is denied", async () => {
		mockCameraPermissions.granted = false

		const result = await hasAllNeededMediaPermissions({ library: "all", needCamera: false })

		expect(result).toBe(true)
	})

	it("needCamera=false does not request camera even with shouldRequest=true", async () => {
		// Camera denied but shouldn't block the result
		mockCameraPermissions.granted = false
		mockCameraPermissions.canAskAgain = true

		const result = await hasAllNeededMediaPermissions({ shouldRequest: true, library: "all", needCamera: false })

		expect(result).toBe(true)
	})

	it("needCamera=true (default) returns false when camera is denied", async () => {
		mockCameraPermissions.granted = false

		const result = await hasAllNeededMediaPermissions({ library: "none", needCamera: true })

		expect(result).toBe(false)
	})

	it("needCamera=true requests camera when denied and canAskAgain=true", async () => {
		mockCameraPermissions.granted = false
		mockCameraPermissions.canAskAgain = true
		mockCameraRequest.granted = true
		mockCameraRequest.expires = "never"

		const result = await hasAllNeededMediaPermissions({ shouldRequest: true, library: "none", needCamera: true })

		expect(result).toBe(true)
	})

	it("needCamera=true returns false when camera canAskAgain=false and shouldRequest=true", async () => {
		mockCameraPermissions.granted = false
		mockCameraPermissions.canAskAgain = false

		const result = await hasAllNeededMediaPermissions({ shouldRequest: true, library: "none", needCamera: true })

		expect(result).toBe(false)
	})
})

describe("hasAllNeededMediaPermissions — useMediaPermissions hook granted derivation with scope", () => {
	it('hook with library="all" reports granted=false when accessPrivileges="limited"', () => {
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

		const { result } = renderHook(() => useMediaPermissions({ library: "all" }))

		expect(result.current.granted).toBe(false)
	})

	it('hook with library="any" reports granted=true when accessPrivileges="limited"', () => {
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

		const { result } = renderHook(() => useMediaPermissions({ library: "any", needCamera: false }))

		expect(result.current.granted).toBe(true)
	})

	it('hook with library="none" reports granted=true even when mediaLibrary.granted=false', () => {
		mockQueryData.data = {
			mediaLibrary: {
				status: "denied",
				granted: false,
				canAskAgain: false,
				expires: "never",
				accessPrivileges: "none"
			},
			camera: {
				status: "granted",
				granted: true,
				canAskAgain: true,
				expires: "never"
			}
		}

		const { result } = renderHook(() => useMediaPermissions({ library: "none", needCamera: false }))

		expect(result.current.granted).toBe(true)
	})

	it("hook with needCamera=false reports granted=true when camera is denied", () => {
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

		const { result } = renderHook(() => useMediaPermissions({ library: "all", needCamera: false }))

		expect(result.current.granted).toBe(true)
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

	// #221 — actually invoke the hook's requestPermissions wrapper instead of just checking typeof
	it("requestPermissions returns true when permissions are fully granted and triggers refetch via defer", async () => {
		// All permissions already granted — hasAllNeededMediaPermissions({shouldRequest:true}) returns true
		setAllGranted()

		const { result } = renderHook(() => useMediaPermissions())

		const successResult = result.current as { requestPermissions: () => Promise<boolean> }
		let returnValue: boolean | undefined

		await act(async () => {
			returnValue = await successResult.requestPermissions()
		})

		expect(returnValue).toBe(true)
		// defer() registered in run() calls refetch after the async fn completes
		expect(mockQueryData.refetch).toHaveBeenCalledTimes(1)
	})

	it("requestPermissions returns false when camera request returns granted=true but expires!='never'", async () => {
		// Both permissions fail the initial check
		mockMediaLibraryPermissions.granted = false
		mockMediaLibraryPermissions.canAskAgain = true
		mockCameraPermissions.granted = false
		mockCameraPermissions.expires = "2099-12-31"
		mockCameraPermissions.canAskAgain = true
		mockMediaLibraryRequest.granted = true
		mockMediaLibraryRequest.accessPrivileges = "all"
		mockMediaLibraryRequest.expires = "never"
		mockCameraRequest.granted = true
		mockCameraRequest.expires = "2099-12-31"

		const { result } = renderHook(() => useMediaPermissions())

		const successResult = result.current as { requestPermissions: () => Promise<boolean> }
		let returnValue: boolean | undefined

		await act(async () => {
			returnValue = await successResult.requestPermissions()
		})

		expect(returnValue).toBe(false)
		// refetch is still triggered via defer even when the result is false
		expect(mockQueryData.refetch).toHaveBeenCalledTimes(1)
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
