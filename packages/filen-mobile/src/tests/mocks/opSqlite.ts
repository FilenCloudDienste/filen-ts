import { vi } from "vitest"

export function createMockPreparedStatement() {
	let boundParams: unknown[] = []

	return {
		bind: vi.fn(async (params: unknown[]) => {
			boundParams = params
		}),
		bindSync: vi.fn((params: unknown[]) => {
			boundParams = params
		}),
		execute: vi.fn(async () => {
			return { rows: [], insertId: undefined, rowsAffected: 0 }
		}),
		getBoundParams: () => boundParams
	}
}

export const mockDb = {
	execute: vi.fn().mockResolvedValue({ rows: [], insertId: undefined, rowsAffected: 0 }),
	executeSync: vi.fn().mockReturnValue({ rows: [], insertId: undefined, rowsAffected: 0 }),
	executeRaw: vi.fn().mockResolvedValue([]),
	executeRawSync: vi.fn().mockReturnValue([]),
	executeBatch: vi.fn().mockResolvedValue({ rowsAffected: 0 }),
	prepareStatement: vi.fn(() => createMockPreparedStatement()),
	close: vi.fn()
}

export const open = vi.fn(() => mockDb)
