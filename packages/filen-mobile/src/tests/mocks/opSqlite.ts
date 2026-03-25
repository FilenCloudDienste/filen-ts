import { vi } from "vitest"

export const mockDb = {
	execute: vi.fn().mockResolvedValue({ rows: [], insertId: undefined, rowsAffected: 0 }),
	executeSync: vi.fn().mockReturnValue({ rows: [], insertId: undefined, rowsAffected: 0 }),
	executeBatch: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
	close: vi.fn()
}

export const open = vi.fn(() => mockDb)
