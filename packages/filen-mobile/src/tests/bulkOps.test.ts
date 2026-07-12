import { vi, describe, it, expect, beforeEach } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

const { mockRunWithLoading, mockAlertsError, mockPromptsAlert } = vi.hoisted(() => ({
	mockRunWithLoading: vi.fn(),
	mockAlertsError: vi.fn(),
	mockPromptsAlert: vi.fn()
}))

vi.mock("@/components/ui/fullScreenLoadingModal", () => ({
	runWithLoading: mockRunWithLoading
}))

vi.mock("@/lib/alerts", () => ({
	default: {
		error: mockAlertsError,
		normal: vi.fn()
	}
}))

vi.mock("@/lib/prompts", () => ({
	default: {
		alert: mockPromptsAlert
	}
}))

import { runBulk } from "@/lib/bulkOps"

type Item = { id: string }

const item1: Item = { id: "1" }
const item2: Item = { id: "2" }

describe("runBulk", () => {
	beforeEach(() => {
		mockRunWithLoading.mockReset()
		mockAlertsError.mockReset()
		mockPromptsAlert.mockReset()
	})

	it("returns false on empty items, calls nothing", async () => {
		const op = vi.fn()
		const clearSelection = vi.fn()

		const result = await runBulk({ items: [], op, clearSelection })

		expect(result).toBe(false)
		expect(op).not.toHaveBeenCalled()
		expect(clearSelection).not.toHaveBeenCalled()
		expect(mockPromptsAlert).not.toHaveBeenCalled()
		expect(mockRunWithLoading).not.toHaveBeenCalled()
	})

	it("returns false when confirm is cancelled — selection stays", async () => {
		mockPromptsAlert.mockResolvedValueOnce({ cancelled: true })

		const op = vi.fn()
		const clearSelection = vi.fn()

		const result = await runBulk({
			items: [item1, item2],
			op,
			clearSelection,
			confirm: { title: "T", message: "M", okText: "OK", destructive: true }
		})

		expect(result).toBe(false)
		expect(op).not.toHaveBeenCalled()
		expect(clearSelection).not.toHaveBeenCalled()
		expect(mockRunWithLoading).not.toHaveBeenCalled()
	})

	it("returns false and toasts when prompts.alert throws", async () => {
		const promptError = new Error("dialog crashed")

		mockPromptsAlert.mockRejectedValueOnce(promptError)

		const op = vi.fn()
		const clearSelection = vi.fn()

		const result = await runBulk({
			items: [item1],
			op,
			clearSelection,
			confirm: { title: "T", message: "M", okText: "OK" }
		})

		expect(result).toBe(false)
		expect(op).not.toHaveBeenCalled()
		expect(clearSelection).not.toHaveBeenCalled()
		expect(mockRunWithLoading).not.toHaveBeenCalled()
		expect(mockAlertsError).toHaveBeenCalledTimes(1)
		expect(mockAlertsError).toHaveBeenCalledWith(promptError)
	})

	it("returns true, calls op per item, clears selection on full success (with confirm)", async () => {
		mockPromptsAlert.mockResolvedValueOnce({ cancelled: false })
		mockRunWithLoading.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
			await fn()

			return { success: true, data: undefined }
		})

		const op = vi.fn(async () => undefined)
		const clearSelection = vi.fn()

		const result = await runBulk({
			items: [item1, item2],
			op,
			clearSelection,
			confirm: { title: "T", message: "M", okText: "OK" }
		})

		expect(result).toBe(true)
		expect(op).toHaveBeenCalledTimes(2)
		expect(op).toHaveBeenNthCalledWith(1, item1)
		expect(op).toHaveBeenNthCalledWith(2, item2)
		expect(clearSelection).toHaveBeenCalledTimes(1)
		expect(mockAlertsError).not.toHaveBeenCalled()
	})

	it("returns true and clears selection on full success without confirm", async () => {
		mockRunWithLoading.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
			await fn()

			return { success: true, data: undefined }
		})

		const op = vi.fn(async () => undefined)
		const clearSelection = vi.fn()

		const result = await runBulk({ items: [item1], op, clearSelection })

		expect(result).toBe(true)
		expect(op).toHaveBeenCalledTimes(1)
		expect(clearSelection).toHaveBeenCalledTimes(1)
		expect(mockPromptsAlert).not.toHaveBeenCalled()
	})

	it("returns true and clears selection on single-item success with confirm", async () => {
		mockPromptsAlert.mockResolvedValueOnce({ cancelled: false })
		mockRunWithLoading.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
			await fn()

			return { success: true, data: undefined }
		})

		const op = vi.fn(async () => undefined)
		const clearSelection = vi.fn()

		const result = await runBulk({
			items: [item1],
			op,
			clearSelection,
			confirm: { title: "T", message: "M", okText: "OK" }
		})

		expect(result).toBe(true)
		expect(op).toHaveBeenCalledTimes(1)
		expect(op).toHaveBeenCalledWith(item1)
		expect(clearSelection).toHaveBeenCalledTimes(1)
		expect(mockAlertsError).not.toHaveBeenCalled()
	})

	it("returns false and KEEPS selection on op failure — first error toasted (runWithLoading short-circuit)", async () => {
		const opError = new Error("boom")

		// Mock returns failure without calling fn — tests runBulk's error dispatch logic
		mockRunWithLoading.mockResolvedValueOnce({ success: false, error: opError })

		const op = vi.fn()
		const clearSelection = vi.fn()

		const result = await runBulk({ items: [item1, item2], op, clearSelection })

		expect(result).toBe(false)
		expect(clearSelection).not.toHaveBeenCalled()
		expect(mockAlertsError).toHaveBeenCalledTimes(1)
		expect(mockAlertsError).toHaveBeenCalledWith(opError)
	})

	it("returns false and KEEPS selection when op throws — error propagates through Promise.all into runWithLoading result", async () => {
		const opError = new Error("op threw")

		// runWithLoading actually executes fn() so the throwing op propagates
		// through Promise.all → runWithLoading's run() wrapper → { success: false, error }
		mockRunWithLoading.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
			try {
				await fn()

				return { success: true, data: undefined }
			} catch (error) {
				return { success: false, error }
			}
		})

		const op = vi.fn().mockRejectedValueOnce(opError)
		const clearSelection = vi.fn()

		const result = await runBulk({ items: [item1, item2], op, clearSelection })

		expect(result).toBe(false)
		expect(op).toHaveBeenCalled()
		expect(clearSelection).not.toHaveBeenCalled()
		expect(mockAlertsError).toHaveBeenCalledTimes(1)
		expect(mockAlertsError).toHaveBeenCalledWith(opError)
	})

	it("forwards cancelText and destructive fields to prompts.alert", async () => {
		mockPromptsAlert.mockResolvedValueOnce({ cancelled: true })

		const op = vi.fn()
		const clearSelection = vi.fn()

		await runBulk({
			items: [item1],
			op,
			clearSelection,
			confirm: {
				title: "Delete",
				message: "Are you sure?",
				okText: "Delete",
				cancelText: "Cancel",
				destructive: true
			}
		})

		expect(mockPromptsAlert).toHaveBeenCalledTimes(1)
		expect(mockPromptsAlert).toHaveBeenCalledWith({
			title: "Delete",
			message: "Are you sure?",
			okText: "Delete",
			cancelText: "Cancel",
			destructive: true
		})
	})

	it("omits cancelText and destructive from prompts.alert when not provided", async () => {
		mockPromptsAlert.mockResolvedValueOnce({ cancelled: true })

		const op = vi.fn()
		const clearSelection = vi.fn()

		await runBulk({
			items: [item1],
			op,
			clearSelection,
			confirm: { title: "T", message: "M", okText: "OK" }
		})

		expect(mockPromptsAlert).toHaveBeenCalledTimes(1)
		expect(mockPromptsAlert).toHaveBeenCalledWith({
			title: "T",
			message: "M",
			okText: "OK",
			cancelText: undefined,
			destructive: undefined
		})
	})

	it("dispatches all items concurrently (Promise.all semantics)", async () => {
		mockRunWithLoading.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
			await fn()

			return { success: true, data: undefined }
		})

		// Track when each op was called (before any await) and when it resolved.
		// Resolvers are populated in forEach iteration order (item1 first, item2 second)
		// so the final expected order is deterministic: both called before either resolves.
		const callOrder: string[] = []
		const resolvers: Array<() => void> = []

		const op = vi.fn(async (item: Item) => {
			callOrder.push(`called:${item.id}`)

			await new Promise<void>(resolve => {
				resolvers.push(resolve)
			})

			callOrder.push(`resolved:${item.id}`)

			return item.id
		})
		const clearSelection = vi.fn()

		const bulkPromise = runBulk({ items: [item1, item2], op, clearSelection })

		// Flush the microtask queue so both ops are called before either resolves
		await Promise.resolve()
		await Promise.resolve()

		// Both ops must have been called before either settled — proof of concurrency
		expect(callOrder).toEqual(["called:1", "called:2"])
		expect(op).toHaveBeenCalledTimes(2)

		// Resolve both in insertion order; both resolve:N events follow in the same order
		resolvers.forEach(r => r())

		await bulkPromise

		// Both resolved in the order they were queued (insertion order of resolvers array)
		expect(callOrder).toEqual(["called:1", "called:2", "resolved:1", "resolved:2"])
	})
})

describe("runBulk — background mode (#60)", () => {
	beforeEach(() => {
		mockRunWithLoading.mockReset()
		mockAlertsError.mockReset()
		mockPromptsAlert.mockReset()
	})

	it("skips the blocking overlay, clears selection up front, dispatches every op, returns true", async () => {
		const op = vi.fn(async () => undefined)
		const clearSelection = vi.fn()

		const result = await runBulk({ items: [item1, item2], op, clearSelection, background: true })

		expect(result).toBe(true)
		// The whole point of #60: no full-screen loading overlay in background mode.
		expect(mockRunWithLoading).not.toHaveBeenCalled()
		expect(clearSelection).toHaveBeenCalledTimes(1)
		expect(op).toHaveBeenCalledTimes(2)
		expect(op).toHaveBeenNthCalledWith(1, item1)
		expect(op).toHaveBeenNthCalledWith(2, item2)
	})

	it("returns and clears selection BEFORE the ops finish (fire-and-forget)", async () => {
		// Ops that never resolve — runBulk must still return true and clear immediately,
		// proving the app is never blocked waiting on the downloads.
		const op = vi.fn(() => new Promise<void>(() => {}))
		const clearSelection = vi.fn()

		const result = await runBulk({ items: [item1, item2], op, clearSelection, background: true })

		expect(result).toBe(true)
		expect(clearSelection).toHaveBeenCalledTimes(1)
		expect(op).toHaveBeenCalledTimes(2)
		expect(mockRunWithLoading).not.toHaveBeenCalled()
	})

	it("surfaces a failing op via alerts without blocking the others or throwing", async () => {
		const opError = new Error("offline store failed")
		const op = vi
			.fn()
			.mockRejectedValueOnce(opError) // item1 fails
			.mockResolvedValueOnce(undefined) // item2 succeeds
		const clearSelection = vi.fn()

		const result = await runBulk({ items: [item1, item2], op, clearSelection, background: true })

		// Dispatched immediately, selection cleared, no throw despite the rejection.
		expect(result).toBe(true)
		expect(clearSelection).toHaveBeenCalledTimes(1)
		expect(op).toHaveBeenCalledTimes(2)

		// Let the per-item run()/.then() error surfacing settle.
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(mockAlertsError).toHaveBeenCalledTimes(1)
		expect(mockAlertsError).toHaveBeenCalledWith(opError)
	})

	it("still honors a cancelled confirm — no dispatch, no clear", async () => {
		mockPromptsAlert.mockResolvedValueOnce({ cancelled: true })

		const op = vi.fn()
		const clearSelection = vi.fn()

		const result = await runBulk({
			items: [item1],
			op,
			clearSelection,
			background: true,
			confirm: { title: "T", message: "M", okText: "OK" }
		})

		expect(result).toBe(false)
		expect(op).not.toHaveBeenCalled()
		expect(clearSelection).not.toHaveBeenCalled()
		expect(mockRunWithLoading).not.toHaveBeenCalled()
	})
})
