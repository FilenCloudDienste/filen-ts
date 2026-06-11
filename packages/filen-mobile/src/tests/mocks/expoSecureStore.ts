import { vi } from "vitest"

export const isAvailableAsync = vi.fn().mockResolvedValue(true)
export const getItemAsync = vi.fn().mockResolvedValue(null)
export const setItemAsync = vi.fn().mockResolvedValue(undefined)

// Sentinel mirroring expo-secure-store's KeychainAccessibilityConstant export — the real
// value is a native enum constant; tests only assert it is threaded through to writes.
export const AFTER_FIRST_UNLOCK = "AFTER_FIRST_UNLOCK"
