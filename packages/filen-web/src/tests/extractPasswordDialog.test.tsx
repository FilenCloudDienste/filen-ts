// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"

const { rerunExtractWithPassword } = vi.hoisted(() => ({
	rerunExtractWithPassword: vi.fn<(jobId: string, password: string) => boolean>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))
vi.mock("@/features/drive/lib/archiveJobs", () => ({ rerunExtractWithPassword }))

import { ExtractPasswordDialog } from "@/features/transfers/components/extractPasswordDialog"
import {
	armPasswordPrompt,
	clearQueuedPasswordPrompts,
	promptExtractPassword,
	queuedPasswordPrompts
} from "@/features/transfers/lib/extractPasswordPrompt"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { extractJob } from "@/tests/support/archiveJobFixtures"

const SECRET = "correct horse"

function running(id: string): void {
	useDriveJobsStore.getState().put(extractJob({ phase: "extracting", archiveName: `${id}.zip` }, id))
}

function settle(id: string, status: "passwordRequired" | "wrongPassword"): void {
	useDriveJobsStore.getState().update("extract", id, job => ({ ...job, outcome: { status } }))
}

// Several archives started from this tab, all settled needing a password: the first prompts, the rest wait.
function waiting(...ids: string[]): void {
	act(() => {
		for (const id of ids) {
			running(id)
			armPasswordPrompt(id)
		}

		for (const id of ids) {
			settle(id, "passwordRequired")
		}
	})
}

beforeEach(() => {
	clearQueuedPasswordPrompts()
	useDriveJobsStore.setState({ jobs: {}, cancelPromptId: null, passwordPromptId: null, reportJobId: null })
	// A rerun starts the same job again, as the runner does.
	rerunExtractWithPassword.mockImplementation(id => {
		running(id)

		return true
	})
})

afterEach(() => {
	cleanup()
})

function serialized(value: unknown): string {
	return JSON.stringify(value, (_key, entry: unknown) => (typeof entry === "bigint" ? entry.toString() : entry))
}

function typePassword(): void {
	fireEvent.change(screen.getByLabelText("Password"), { target: { value: SECRET } })
}

describe("ExtractPasswordDialog", () => {
	it("opens by itself for an extract started here that needs a password, and reruns it with the one typed", async () => {
		render(<ExtractPasswordDialog />)
		waiting("a")

		const dialog = await screen.findByRole("dialog")

		expect(dialog.textContent).toContain("Password required")
		expect(dialog.textContent).toContain("“a.zip” is encrypted. Enter its password to extract it.")
		expect(screen.getByRole("button", { name: "Extract" }).hasAttribute("disabled")).toBe(true)

		typePassword()
		fireEvent.click(screen.getByRole("button", { name: "Extract" }))

		expect(rerunExtractWithPassword).toHaveBeenCalledWith("a", SECRET)
		expect(useDriveJobsStore.getState().passwordPromptId).toBeNull()
	})

	it("refuses a password longer than archives allow, saying so", async () => {
		render(<ExtractPasswordDialog />)
		waiting("a")
		await screen.findByRole("dialog")

		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a".repeat(1025) } })

		expect(screen.getByText("A password can have at most 1024 characters")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Extract" }).hasAttribute("disabled")).toBe(true)
	})

	it("asks again, as a wrong password, when the rerun's password was wrong", async () => {
		render(<ExtractPasswordDialog />)
		waiting("a")
		await screen.findByRole("dialog")
		typePassword()
		fireEvent.click(screen.getByRole("button", { name: "Extract" }))

		act(() => {
			settle("a", "wrongPassword")
		})

		await waitFor(() => {
			expect(screen.getByRole("dialog").textContent).toContain("That password didn't open “a.zip”. Try again.")
		})
		expect(screen.getByLabelText<HTMLInputElement>("Password").value).toBe("")
	})

	it("hands the prompt to the next archive waiting once dismissed, leaving the dismissed one as it was", async () => {
		render(<ExtractPasswordDialog />)
		waiting("a", "b")
		await screen.findByRole("dialog")

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		await waitFor(() => {
			expect(screen.getByRole("dialog").textContent).toContain("“b.zip” is encrypted.")
		})
		expect(rerunExtractWithPassword).not.toHaveBeenCalled()
		expect(useDriveJobsStore.getState().jobs["a"]?.outcome.status).toBe("passwordRequired")
	})

	it("tries the password for every archive waiting when asked to, and arms each again", async () => {
		render(<ExtractPasswordDialog />)
		waiting("a", "b", "c")
		await screen.findByRole("dialog")

		typePassword()
		fireEvent.click(screen.getByRole("switch", { name: "Also try it for the 2 other archives waiting for a password" }))
		fireEvent.click(screen.getByRole("button", { name: "Extract" }))

		expect(rerunExtractWithPassword.mock.calls).toEqual([
			["a", SECRET],
			["b", SECRET],
			["c", SECRET]
		])
		expect(queuedPasswordPrompts()).toEqual([])
		expect(useDriveJobsStore.getState().passwordPromptId).toBeNull()

		// Re-armed: a wrong password for one of them asks again.
		act(() => {
			settle("c", "wrongPassword")
		})

		expect(useDriveJobsStore.getState().passwordPromptId).toBe("c")
	})

	it("tries it for the current archive only by default", async () => {
		render(<ExtractPasswordDialog />)
		waiting("a", "b")
		await screen.findByRole("dialog")

		typePassword()
		fireEvent.click(screen.getByRole("button", { name: "Extract" }))

		expect(rerunExtractWithPassword.mock.calls).toEqual([["a", SECRET]])
		await waitFor(() => {
			expect(useDriveJobsStore.getState().passwordPromptId).toBe("b")
		})
	})

	it("passes over a prompt for a job that no longer waits", async () => {
		running("gone")
		render(<ExtractPasswordDialog />)

		act(() => {
			promptExtractPassword("gone")
		})

		await waitFor(() => {
			expect(useDriveJobsStore.getState().passwordPromptId).toBeNull()
		})
		expect(screen.queryByRole("dialog")).toBeNull()
	})

	it("keeps the password out of the store and the console", async () => {
		const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")]

		render(<ExtractPasswordDialog />)
		waiting("a")
		await screen.findByRole("dialog")
		typePassword()
		fireEvent.click(screen.getByRole("button", { name: "Show password" }))
		fireEvent.click(screen.getByRole("button", { name: "Extract" }))

		expect(serialized(useDriveJobsStore.getState())).not.toContain(SECRET)

		for (const log of logs) {
			expect(serialized(log.mock.calls)).not.toContain(SECRET)
		}
	})
})
