// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ExternalToast } from "sonner"

const { toast } = vi.hoisted(() => ({
	toast: Object.assign(
		vi.fn<(title: string, options?: ExternalToast) => string>(() => "id"),
		{
			success: vi.fn<(title: string, options?: ExternalToast) => string>(),
			error: vi.fn<(title: string, options?: ExternalToast) => string>(),
			dismiss: vi.fn()
		}
	)
}))

vi.mock("sonner", () => ({ toast }))

import "@/lib/i18n"
import { runBulkActivity, runOutcomeActivity } from "@/lib/activity/activity"
import { useActivityStore } from "@/lib/activity/activityStore"
import { hasUnloadHold } from "@/lib/unloadGuard"
import { runBulk } from "@/lib/actions/bulk"
import { activityKeys } from "@/lib/activity/activity.logic"

// Real catalog keys, so the words are checked too.
const KEYS = activityKeys("drive:driveTrash")

const name = (item: string): string => `${item}.txt`

// Presses a toast's action or cancel button, as sonner would.
function press(button: unknown): void {
	if (typeof button !== "object" || button === null || !("onClick" in button) || typeof button.onClick !== "function") {
		throw new Error("no button")
	}

	;(button.onClick as (event: unknown) => void)({})
}

beforeEach(() => {
	vi.clearAllMocks()
	useActivityStore.setState({ progress: {}, details: null })
})

afterEach(() => {
	vi.useRealTimers()
})

describe("runBulkActivity", () => {
	it("shows the running toast at once, counts settled items, holds the tab and turns into the result in place", async () => {
		const { promise: gate, resolve: open } = Promise.withResolvers<undefined>()
		const run = runBulkActivity({
			items: ["a", "b"],
			keys: KEYS,
			name,
			run: (items, onSettled) =>
				runBulk(
					items,
					async item => {
						if (item === "b") {
							await gate
						}
					},
					onSettled
				)
		})

		const [label, running] = toast.mock.lastCall ?? []

		expect(label).toBe("Moving 2 items to trash")
		expect(running?.duration).toBe(Infinity)
		expect(hasUnloadHold()).toBe(true)

		await vi.waitFor(() => {
			expect(Object.values(useActivityStore.getState().progress)).toEqual([{ kind: "count", settled: 1, total: 2 }])
		})

		open(undefined)
		await run

		expect(toast.success).toHaveBeenCalledWith("Moved 2 items to trash", expect.objectContaining({ id: running?.id, duration: 4_000 }))
		expect(hasUnloadHold()).toBe(false)
		expect(useActivityStore.getState().progress).toEqual({})
	})

	it("says why one failure failed and offers to try it again", async () => {
		const perItem = vi.fn<(item: string) => Promise<void>>().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined)

		await runBulkActivity({ items: ["a"], keys: KEYS, name, run: (items, onSettled) => runBulk(items, perItem, onSettled) })

		const [title, options] = toast.error.mock.lastCall ?? []

		expect(title).toBe("Couldn't move a.txt to trash")
		expect(options?.description).toBe("boom")
		expect(options?.cancel).toBeUndefined()

		press(options?.action)

		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Moved a.txt to trash", expect.anything())
		})
		expect(perItem).toHaveBeenCalledTimes(2)
	})

	it("lists several failures behind Details, retrying only the failed items", async () => {
		const seen: string[][] = []

		await runBulkActivity({
			items: ["a", "b", "c"],
			keys: KEYS,
			name,
			run: (items, onSettled) => {
				seen.push(items)

				return runBulk(items, item => (item === "a" ? Promise.resolve() : Promise.reject(new Error(item))), onSettled)
			}
		})

		const [title, options] = toast.error.mock.lastCall ?? []

		expect(title).toBe("Moved 1 item to trash, 2 failed")

		press(options?.cancel)

		expect(useActivityStore.getState().details?.failures.map(failure => failure.name)).toEqual(["b.txt", "c.txt"])

		press(options?.action)

		await vi.waitFor(() => {
			expect(seen).toEqual([
				["a", "b", "c"],
				["b", "c"]
			])
		})
	})

	it("fails every item of a run that throws, instead of rejecting", async () => {
		const outcome = await runBulkActivity({ items: ["a", "b"], keys: KEYS, name, run: () => Promise.reject(new Error("worker gone")) })

		expect(outcome.failed.map(failure => failure.item)).toEqual(["a", "b"])
		expect(toast.error.mock.lastCall?.[0]).toBe("Couldn't move 2 items to trash")
		expect(hasUnloadHold()).toBe(false)
	})

	it("shows only the result when something else shows it running", async () => {
		await runBulkActivity({ items: ["a"], keys: KEYS, name, showRunning: false, run: items => runBulk(items, () => Promise.resolve()) })

		expect(toast).not.toHaveBeenCalled()
		expect(toast.success.mock.lastCall?.[1]?.id).toBeUndefined()
	})

	it("shows its result as a toast of its own once its running toast was hidden", async () => {
		const { promise: gate, resolve: open } = Promise.withResolvers<undefined>()
		const run = runBulkActivity({ items: ["a"], keys: KEYS, name, run: items => runBulk(items, () => gate) })

		toast.mock.lastCall?.[1]?.onDismiss?.({} as never)
		open(undefined)
		await run

		expect(toast.success.mock.lastCall?.[1]?.id).toBeUndefined()
	})
})

describe("runOutcomeActivity", () => {
	it("runs one outcome-returning write in the same words", async () => {
		await runOutcomeActivity("a", { keys: KEYS, name, run: () => Promise.resolve({ status: "success" }) })

		expect(toast.mock.lastCall?.[0]).toBe("Moving a.txt to trash")
		expect(toast.success.mock.lastCall?.[0]).toBe("Moved a.txt to trash")
	})
})
