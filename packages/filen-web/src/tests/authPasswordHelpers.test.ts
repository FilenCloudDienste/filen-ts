// @vitest-environment jsdom

// Three small auth-form behaviors, covered together since they touch the same forms: an inline
// helper telling the user their password confirmation doesn't match, a distinct color per
// password-strength tier, and locking every field (not just the submit button) while a submit is
// in flight. registerForm.tsx is the representative surface for the mismatch helper and the
// field-locking behavior: resetForm.tsx and changePassword.tsx reuse the exact same inline-mismatch
// pattern already proven here and in changeEmail.tsx, not a bespoke one per form.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import { StrengthMeter } from "@/features/auth/components/strengthMeter"

const { register, login, logout } = vi.hoisted(() => ({ register: vi.fn(), login: vi.fn(), logout: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { register, resendRegistrationConfirmation: vi.fn(), login, logout }
}))
vi.mock("@/features/auth/queries/registerCheck", () => ({ useRegisterCheckQuery: () => ({ data: undefined }) }))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))
vi.mock("@/lib/sdk/session", () => ({ persistSession: vi.fn(), clearSession: vi.fn(), broadcastAuth: vi.fn() }))

const { RegisterForm } = await import("@/features/auth/components/registerForm")
const { LoginForm } = await import("@/features/auth/components/loginForm")

// length>=10 with lowercase+special only (no uppercase) -- ratePasswordStrength's "normal" tier.
const STRONG_ENOUGH_PASSWORD = "abcdefgh!!"

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	cleanup()
})

describe("StrengthMeter — distinct hue per tier", () => {
	it("gives each tier its own color instead of a shared grayscale step", () => {
		const { unmount: unmountWeak } = render(createElement(StrengthMeter, { tier: "weak" }))
		expect(screen.getByText("Weak").className).toContain("text-destructive")
		unmountWeak()

		const { unmount: unmountNormal } = render(createElement(StrengthMeter, { tier: "normal" }))
		expect(screen.getByText("Fair").className).toContain("text-yellow-500")
		unmountNormal()

		const { unmount: unmountStrong } = render(createElement(StrengthMeter, { tier: "strong" }))
		expect(screen.getByText("Strong").className).toContain("text-blue-500")
		unmountStrong()

		render(createElement(StrengthMeter, { tier: "best" }))
		expect(screen.getByText("Very strong").className).toContain("text-green-500")
	})
})

describe("RegisterForm — password-mismatch helper text", () => {
	it("stays silent while the confirm field is still empty", () => {
		render(createElement(RegisterForm))

		fireEvent.change(screen.getByLabelText("Password"), { target: { value: STRONG_ENOUGH_PASSWORD } })

		expect(screen.queryByText("Passwords do not match")).toBeNull()
	})

	it("shows the mismatch helper once both fields are non-empty and differ", () => {
		render(createElement(RegisterForm))

		fireEvent.change(screen.getByLabelText("Password"), { target: { value: STRONG_ENOUGH_PASSWORD } })
		fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "something-else!!" } })

		expect(screen.getByText("Passwords do not match")).toBeTruthy()
	})

	it("clears the helper once the fields match", () => {
		render(createElement(RegisterForm))

		fireEvent.change(screen.getByLabelText("Password"), { target: { value: STRONG_ENOUGH_PASSWORD } })
		fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: STRONG_ENOUGH_PASSWORD } })

		expect(screen.queryByText("Passwords do not match")).toBeNull()
	})
})

describe("Auth forms — inputs lock during an in-flight submit", () => {
	it("RegisterForm disables every field once submit is pending, not just the button", () => {
		// Never settles -- the test only needs the pending WINDOW, not the eventual outcome.
		register.mockImplementation(() => new Promise<void>(() => undefined))

		render(createElement(RegisterForm))

		fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } })
		fireEvent.change(screen.getByLabelText("Password"), { target: { value: STRONG_ENOUGH_PASSWORD } })
		fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: STRONG_ENOUGH_PASSWORD } })
		fireEvent.click(screen.getByRole("button", { name: "Create account" }))

		expect(screen.getByLabelText("Email").hasAttribute("disabled")).toBe(true)
		expect(screen.getByLabelText("Password").hasAttribute("disabled")).toBe(true)
		expect(screen.getByLabelText("Confirm password").hasAttribute("disabled")).toBe(true)
	})

	it("LoginForm disables the email/password fields once submit is pending, not just the button", () => {
		// Never settles -- the test only needs the pending WINDOW, not the eventual outcome.
		login.mockImplementation(() => new Promise(() => undefined))

		render(createElement(LoginForm))

		fireEvent.change(screen.getByLabelText("Email"), { target: { value: "user@example.com" } })
		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "whatever-password" } })
		fireEvent.click(screen.getByRole("button", { name: "Sign in" }))

		expect(screen.getByLabelText("Email").hasAttribute("disabled")).toBe(true)
		expect(screen.getByLabelText("Password").hasAttribute("disabled")).toBe(true)
	})
})
