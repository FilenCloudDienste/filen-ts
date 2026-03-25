import { vi } from "vitest"

export const mockMmkv = {
	getString: vi.fn().mockReturnValue(undefined),
	set: vi.fn()
}

export const createMMKV = vi.fn(() => mockMmkv)
