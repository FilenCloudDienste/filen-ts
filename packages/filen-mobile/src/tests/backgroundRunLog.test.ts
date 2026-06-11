/**
 * Unit suite for src/features/cameraUpload/backgroundRunLog.ts (audit B6, 2026-06-11).
 *
 * Release builds no-op console.* and both OS schedulers discard the task's returned
 * result, so this capped kv row is the ONLY field-diagnosable trace of background
 * runs. Pins: append-to-empty, the entry cap, corrupt-row tolerance, list fallback.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const { mockKvGet, mockKvSet } = vi.hoisted(() => ({
	mockKvGet: vi.fn(async (_key: string) => null as unknown),
	mockKvSet: vi.fn(async (_key: string, _value: unknown) => null as number | null)
}))

vi.mock("@/lib/sqlite", () => ({
	default: {
		kvAsync: {
			get: mockKvGet,
			set: mockKvSet
		}
	}
}))

import backgroundRunLog, {
	BACKGROUND_RUN_LOG_KEY,
	BACKGROUND_RUN_LOG_MAX_ENTRIES,
	type BackgroundRunLogEntry
} from "@/features/cameraUpload/backgroundRunLog"

function makeEntry(overrides?: Partial<BackgroundRunLogEntry>): BackgroundRunLogEntry {
	return {
		v: 1,
		startedAt: 1_000,
		finishedAt: 2_000,
		phase: "done",
		cancelled: false,
		result: "success",
		...overrides
	}
}

beforeEach(() => {
	mockKvGet.mockReset().mockResolvedValue(null)
	mockKvSet.mockReset().mockResolvedValue(null)
})

describe("backgroundRunLog", () => {
	it("append() writes a single-entry array when no log exists", async () => {
		const entry = makeEntry()

		await backgroundRunLog.append(entry)

		expect(mockKvSet).toHaveBeenCalledTimes(1)
		expect(mockKvSet).toHaveBeenCalledWith(BACKGROUND_RUN_LOG_KEY, [entry])
	})

	it("append() appends to an existing log", async () => {
		const existing = [makeEntry({ startedAt: 1 })]

		mockKvGet.mockResolvedValue(existing)

		const entry = makeEntry({ startedAt: 2 })

		await backgroundRunLog.append(entry)

		expect(mockKvSet).toHaveBeenCalledWith(BACKGROUND_RUN_LOG_KEY, [existing[0], entry])
	})

	it("append() caps the log at the newest BACKGROUND_RUN_LOG_MAX_ENTRIES entries", async () => {
		const existing = Array.from({ length: BACKGROUND_RUN_LOG_MAX_ENTRIES }, (_, i) => makeEntry({ startedAt: i }))

		mockKvGet.mockResolvedValue(existing)

		const entry = makeEntry({ startedAt: 999 })

		await backgroundRunLog.append(entry)

		const written = mockKvSet.mock.calls[0]?.[1] as BackgroundRunLogEntry[]

		expect(written).toHaveLength(BACKGROUND_RUN_LOG_MAX_ENTRIES)
		expect(written[0]?.startedAt).toBe(1)
		expect(written[written.length - 1]).toEqual(entry)
	})

	it("append() tolerates a corrupt (non-array) stored value by starting fresh", async () => {
		mockKvGet.mockResolvedValue("garbage" as unknown)

		const entry = makeEntry()

		await backgroundRunLog.append(entry)

		expect(mockKvSet).toHaveBeenCalledWith(BACKGROUND_RUN_LOG_KEY, [entry])
	})

	it("list() returns the stored entries, or [] when absent/corrupt", async () => {
		const existing = [makeEntry()]

		mockKvGet.mockResolvedValue(existing)

		await expect(backgroundRunLog.list()).resolves.toEqual(existing)

		mockKvGet.mockResolvedValue(null)

		await expect(backgroundRunLog.list()).resolves.toEqual([])

		mockKvGet.mockResolvedValue(42 as unknown)

		await expect(backgroundRunLog.list()).resolves.toEqual([])
	})
})
