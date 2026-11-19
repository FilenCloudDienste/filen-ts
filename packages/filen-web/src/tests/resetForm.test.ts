// @vitest-environment jsdom

// The reset form's two-factor surface: there is no code field — the SDK cannot forward one — so a
// two-factor account always ends on the terminal "sign in to continue" panel that replaces the form.
// That panel is deliberately terminal: completePasswordReset posts the reset BEFORE its auto-login,
// so resubmitting would re-post with an already-spent token.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"

const { completePasswordReset, navigate } = vi.hoisted(() => ({ completePasswordReset: vi.fn(), navigate: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { completePasswordReset } }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }))
vi.mock("@/lib/sdk/session", () => ({ persistSession: vi.fn(), clearSession: vi.fn(), broadcastAuth: vi.fn() }))
vi.mock("@/lib/sdk/boot", () => ({ whenBootReady: vi.fn() }))

const { ResetForm } = await import("@/features/auth/components/resetForm")
const { rememberReturnTarget, takeSignInTarget } = await import("@/features/settings/lib/pendingPlans")

// length>=10 with lowercase+special only — ratePasswordStrength's "normal" tier, enough to submit.
const STRONG_ENOUGH_PASSWORD = "abcdefgh!!"

// Choosing a master-keys file takes submit down the DIRECT path, skipping the 4-stage skip-keys
// ceremony.
function fillForm(): void {
	fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } })
	fireEvent.change(screen.getByLabelText("New password"), { target: { value: STRONG_ENOUGH_PASSWORD } })
	fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: STRONG_ENOUGH_PASSWORD } })
	fireEvent.change(screen.getByLabelText("Master keys file"), { target: { files: [new File(["k"], "k.txt")] } })
}

function sdkDto(kind: string): Record<string, string> {
	return { species: "sdk", kind, message: `${kind} message`, label: `${kind} label` }
}

beforeEach(() => {
	vi.clearAllMocks()
	sessionStorage.clear()
	completePasswordReset.mockImplementation(() => new Promise(() => undefined))
})

afterEach(() => {
	cleanup()
})

describe("ResetForm — terminal sign-in-required panel", () => {
	async function submitAndRejectWith(kind: string): Promise<void> {
		completePasswordReset.mockRejectedValue(sdkDto(kind))

		render(createElement(ResetForm, { token: "reset-token" }))

		fillForm()
		await waitFor(() => {
			expect(screen.getByText("Master keys imported (k.txt)")).toBeTruthy()
		})
		fireEvent.click(screen.getByRole("button", { name: "Reset password" }))

		await waitFor(() => {
			expect(screen.getByText("Password reset submitted — sign in to continue")).toBeTruthy()
		})
	}

	it("offers no code field: the SDK has no param to forward one under", () => {
		render(createElement(ResetForm, { token: "reset-token" }))

		expect(screen.queryByLabelText("Authenticator code")).toBeNull()
	})

	it("replaces the form when a two-factor account blocks the automatic sign-in", async () => {
		await submitAndRejectWith("Enter2fa")

		expect(screen.getByText(/could not sign you in automatically/)).toBeTruthy()
		// The form is gone: resubmitting would re-post the reset with an already-spent token.
		expect(screen.queryByRole("button", { name: "Reset password" })).toBeNull()
	})

	it("shows the same panel whichever two-factor kind the backend answers with", async () => {
		await submitAndRejectWith("Wrong2fa")

		expect(screen.getByText(/could not sign you in automatically/)).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Reset password" })).toBeNull()
	})

	it("sends the user to sign in with their new password", async () => {
		await submitAndRejectWith("Enter2fa")

		fireEvent.click(screen.getByRole("button", { name: "Go to sign in" }))

		expect(navigate).toHaveBeenCalledWith({ to: "/login" })
	})
})

// The automatic sign-in after a reset goes where a form sign-in goes: the page a signed-out visit asked for, else the
// configured start screen ("/" resolves it). Taking the target clears it, so it never reaches a later sign-in.
describe("ResetForm — landing after the automatic sign-in", () => {
	async function submitSuccessfully(): Promise<void> {
		completePasswordReset.mockResolvedValue("client-blob")

		render(createElement(ResetForm, { token: "reset-token" }))

		fillForm()
		await waitFor(() => {
			expect(screen.getByText("Master keys imported (k.txt)")).toBeTruthy()
		})
		fireEvent.click(screen.getByRole("button", { name: "Reset password" }))

		await waitFor(() => {
			expect(navigate).toHaveBeenCalledTimes(1)
		})
	}

	it("lands on the start screen when nothing was asked for", async () => {
		await submitSuccessfully()

		expect(navigate).toHaveBeenCalledWith({ to: "/" })
	})

	it("lands on the page a signed-out visit asked for and clears it", async () => {
		rememberReturnTarget("/notes/x")

		await submitSuccessfully()

		expect(navigate).toHaveBeenCalledWith({ href: "/notes/x" })
		expect(takeSignInTarget()).toBeNull()
	})
})
