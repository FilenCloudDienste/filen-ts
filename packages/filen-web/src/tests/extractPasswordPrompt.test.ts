import { beforeEach, describe, expect, it, vi } from "vitest"
import { extractJob } from "@/tests/support/archiveJobFixtures"

type Prompt = typeof import("@/features/transfers/lib/extractPasswordPrompt")
type Store = typeof import("@/features/transfers/store/useDriveJobsStore")

// The queue and its subscription are module state: every test starts from fresh modules.
let prompt: Prompt
let store: Store["useDriveJobsStore"]

beforeEach(async () => {
	vi.resetModules()

	store = (await import("@/features/transfers/store/useDriveJobsStore")).useDriveJobsStore
	prompt = await import("@/features/transfers/lib/extractPasswordPrompt")
})

function start(id: string): void {
	store.getState().put(extractJob({ phase: "extracting" }, id))
}

function settle(id: string, status: "passwordRequired" | "wrongPassword" | "done" | "cancelled"): void {
	store.getState().update("extract", id, job => ({ ...job, outcome: { status } }))
}

function current(): string | null {
	return store.getState().passwordPromptId
}

describe("extract password prompt", () => {
	it("opens by itself for an armed run that needs a password, and again when the password was wrong", () => {
		start("a")
		prompt.armPasswordPrompt("a")
		settle("a", "passwordRequired")

		expect(current()).toBe("a")

		store.getState().setPasswordPromptId(null)
		start("a")
		prompt.armPasswordPrompt("a")
		settle("a", "wrongPassword")

		expect(current()).toBe("a")
	})

	it("stays closed for a run nothing armed, such as a retry of failed entries", () => {
		start("retry")
		settle("retry", "passwordRequired")

		expect(current()).toBeNull()
	})

	it("disarms a run that ended otherwise, so a later password state does not open it", () => {
		start("a")
		prompt.armPasswordPrompt("a")
		settle("a", "done")
		settle("a", "passwordRequired")

		expect(current()).toBeNull()
	})

	it("queues runs in the order they settled and hands the prompt on when the current one closes", () => {
		for (const id of ["a", "b", "c"]) {
			start(id)
			prompt.armPasswordPrompt(id)
		}

		settle("a", "passwordRequired")
		settle("b", "passwordRequired")
		settle("c", "wrongPassword")

		expect(current()).toBe("a")
		expect(prompt.queuedPasswordPrompts()).toEqual(["b", "c"])

		prompt.closePasswordPrompt()

		expect(current()).toBe("b")
		expect(prompt.queuedPasswordPrompts()).toEqual(["c"])

		prompt.closePasswordPrompt()
		prompt.closePasswordPrompt()

		expect(current()).toBeNull()
		expect(prompt.queuedPasswordPrompts()).toEqual([])
	})

	it("skips a queued run that no longer waits for a password", () => {
		for (const id of ["a", "b", "c"]) {
			start(id)
			prompt.armPasswordPrompt(id)
			settle(id, "passwordRequired")
		}

		// Rerun from elsewhere, then gone: neither waits any longer.
		start("b")
		store.getState().remove("b")

		expect(prompt.queuedPasswordPrompts()).toEqual(["c"])

		prompt.closePasswordPrompt()

		expect(current()).toBe("c")
	})

	it("puts an explicit request first in line, or opens it at once when nothing is open", () => {
		for (const id of ["a", "b", "c"]) {
			start(id)
			settle(id, "passwordRequired")
		}

		prompt.promptExtractPassword("a")

		expect(current()).toBe("a")

		prompt.promptExtractPassword("b")
		prompt.promptExtractPassword("c")
		prompt.promptExtractPassword("a")

		expect(current()).toBe("a")
		expect(prompt.queuedPasswordPrompts()).toEqual(["c", "b"])
	})

	it("clears the line for runs answered along with the current one", () => {
		for (const id of ["a", "b"]) {
			start(id)
			prompt.armPasswordPrompt(id)
			settle(id, "passwordRequired")
		}

		prompt.clearQueuedPasswordPrompts()
		prompt.closePasswordPrompt()

		expect(current()).toBeNull()
	})

	it("subscribes to the store once, however many runs it watches", () => {
		const subscribe = vi.spyOn(store, "subscribe")

		for (const id of ["a", "b", "c"]) {
			start(id)
			prompt.armPasswordPrompt(id)
		}

		prompt.promptExtractPassword("a")

		expect(subscribe).toHaveBeenCalledTimes(1)
	})
})
