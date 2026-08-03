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
import { StrengthMeter, type PasswordStrengthTier } from "@/features/auth/components/strengthMeter"

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

const STRENGTH_TIERS: PasswordStrengthTier[] = ["weak", "normal", "strong", "best"]

// The bar's fill is the only inline-styled element (its width steps in quarters); the label is the
// meter's first paragraph.
function strengthShades(tier: PasswordStrengthTier): { fill: string; label: string } {
	const { container, unmount } = render(createElement(StrengthMeter, { tier }))
	const fill = container.querySelector("div[style]")
	const label = container.querySelector("p")

	if (!fill || !label) {
		throw new Error(`strength meter rendered no fill/label for tier: ${tier}`)
	}

	const shades = { fill: fill.className, label: label.className }

	unmount()

	return shades
}

describe("StrengthMeter — distinct hue per tier", () => {
	// Asserts the PROPERTY the design promises rather than each tier's utility class: pinning the
	// literals breaks on any equivalent restyle while still never proving the tiers read apart.
	it("gives each tier its own bar and label color instead of a shared grayscale step", () => {
		const shades = STRENGTH_TIERS.map(strengthShades)

		expect(new Set(shades.map(shade => shade.fill)).size).toBe(STRENGTH_TIERS.length)
		expect(new Set(shades.map(shade => shade.label)).size).toBe(STRENGTH_TIERS.length)
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

// Asserted on TEXT and on the region NODE, never on element presence: the live region is mounted at
// all times (a region inserted already-populated is commonly not announced), so a presence query is
// true in both states -- and role="status" is not unique in these forms anyway, the submit spinner
// carries it too, which is why the same node is held across the transition.
describe("Auth forms — caps-lock warning", () => {
	it("LoginForm shows the warning while caps lock is on and clears the text, not the region, when it goes off", () => {
		render(createElement(LoginForm))
		const input = screen.getByLabelText("Password")

		expect(screen.queryByText("Caps Lock is on")).toBeNull()

		fireEvent.keyDown(input, { key: "a", modifierCapsLock: true })

		const region = screen.getByText("Caps Lock is on")

		fireEvent.keyUp(input, { key: "a" })

		expect(region.isConnected).toBe(true)
		expect(region.getAttribute("role")).toBe("status")
		expect(region.textContent).toBe("")
	})

	it("RegisterForm warns under the typed field only, and blurring it clears the warning", () => {
		render(createElement(RegisterForm))
		const input = screen.getByLabelText("Password")

		fireEvent.keyDown(input, { key: "a", modifierCapsLock: true })

		expect(screen.getAllByText("Caps Lock is on")).toHaveLength(1)

		fireEvent.blur(input)

		expect(screen.queryByText("Caps Lock is on")).toBeNull()
	})
})
