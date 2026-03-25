import { vi } from "vitest"

export const isAvailableAsync = vi.fn().mockResolvedValue(true)
export const getItemAsync = vi.fn().mockResolvedValue(null)
export const setItemAsync = vi.fn().mockResolvedValue(undefined)
