import { vi, describe, it, expect, beforeEach } from "vitest"

const { mockHasHardwareAsync, mockIsEnrolledAsync, mockSupportedAuthenticationTypesAsync } = vi.hoisted(() => ({
	mockHasHardwareAsync: vi.fn(),
	mockIsEnrolledAsync: vi.fn(),
	mockSupportedAuthenticationTypesAsync: vi.fn()
}))

vi.mock("expo-local-authentication", () => ({
	hasHardwareAsync: mockHasHardwareAsync,
	isEnrolledAsync: mockIsEnrolledAsync,
	supportedAuthenticationTypesAsync: mockSupportedAuthenticationTypesAsync
}))

vi.mock("@/queries/client", () => ({
	DEFAULT_QUERY_OPTIONS: {},
	queryUpdater: {
		get: vi.fn(),
		set: vi.fn()
	}
}))

import { fetchData } from "@/queries/useLocalAuthentication.query"

describe("fetchData (useLocalAuthentication.query)", () => {
	beforeEach(() => {
		mockHasHardwareAsync.mockReset().mockResolvedValue(true)
		mockIsEnrolledAsync.mockReset().mockResolvedValue(true)
		mockSupportedAuthenticationTypesAsync.mockReset().mockResolvedValue([1, 2])
	})

	it("calls all three expo-local-authentication APIs", async () => {
		await fetchData()

		expect(mockHasHardwareAsync).toHaveBeenCalledOnce()
		expect(mockIsEnrolledAsync).toHaveBeenCalledOnce()
		expect(mockSupportedAuthenticationTypesAsync).toHaveBeenCalledOnce()
	})

	it("returns the correct shape with mocked values", async () => {
		mockHasHardwareAsync.mockResolvedValueOnce(true)
		mockIsEnrolledAsync.mockResolvedValueOnce(true)
		mockSupportedAuthenticationTypesAsync.mockResolvedValueOnce([1, 2])

		const result = await fetchData()

		expect(result).toEqual({
			hasHardware: true,
			isEnrolled: true,
			supportedTypes: [1, 2]
		})
	})

	it("returns hasHardware: false when hasHardwareAsync resolves false", async () => {
		mockHasHardwareAsync.mockResolvedValueOnce(false)
		mockIsEnrolledAsync.mockResolvedValueOnce(false)
		mockSupportedAuthenticationTypesAsync.mockResolvedValueOnce([])

		const result = await fetchData()

		expect(result.hasHardware).toBe(false)
		expect(result.isEnrolled).toBe(false)
		expect(result.supportedTypes).toEqual([])
	})

	it("returns an empty supportedTypes array when no authentication types are supported", async () => {
		mockHasHardwareAsync.mockResolvedValueOnce(false)
		mockIsEnrolledAsync.mockResolvedValueOnce(false)
		mockSupportedAuthenticationTypesAsync.mockResolvedValueOnce([])

		const result = await fetchData()

		expect(result.supportedTypes).toEqual([])
	})

	it("result has exactly the keys hasHardware, isEnrolled, supportedTypes", async () => {
		const result = await fetchData()

		expect(Object.keys(result).sort()).toEqual(["hasHardware", "isEnrolled", "supportedTypes"])
	})

	it("propagates a rejection from hasHardwareAsync", async () => {
		mockHasHardwareAsync.mockRejectedValueOnce(new Error("hardware check failed"))

		await expect(fetchData()).rejects.toThrow("hardware check failed")
	})

	it("propagates a rejection from isEnrolledAsync", async () => {
		mockIsEnrolledAsync.mockRejectedValueOnce(new Error("enrollment check failed"))

		await expect(fetchData()).rejects.toThrow("enrollment check failed")
	})

	it("propagates a rejection from supportedAuthenticationTypesAsync", async () => {
		mockSupportedAuthenticationTypesAsync.mockRejectedValueOnce(new Error("types check failed"))

		await expect(fetchData()).rejects.toThrow("types check failed")
	})
})
