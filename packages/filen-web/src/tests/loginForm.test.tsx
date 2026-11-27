// @vitest-environment jsdom

// Login failures render inline and move focus to the password field; none surface as toasts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"

const { login, toastError } = vi.hoisted(() => ({ login: vi.fn(), toastError: vi.fn() }))

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }))
vi.mock("sonner", () => ({ toast: { error: toastError, warning: vi.fn(), success: vi.fn() } }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { login, logout: vi.fn() } }))
vi.mock("@/lib/sdk/session", () => ({ persistSession: vi.fn(), broadcastAuth: vi.fn() }))
vi.mock("@/features/auth/lib/guard", () => ({ navigateAfterSignIn: vi.fn() }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

import { LoginForm } from "@/features/auth/components/loginForm"

beforeEach(() => {
	login.mockReset()
	toastError.mockReset()
})

afterEach(() => {
	cleanup()
})

function fillAndSubmit(): { email: HTMLInputElement; password: HTMLInputElement } {
	render(<LoginForm />)
	const email = screen.getByLabelText<HTMLInputElement>("Email")
	const password = screen.getByLabelText<HTMLInputElement>("Password")

	fireEvent.change(email, { target: { value: "a@b.co" } })
	fireEvent.change(password, { target: { value: "hunter2" } })
	fireEvent.submit(email)

	return { email, password }
}

describe("LoginForm errors", () => {
	it("shows wrong credentials on the password field, focuses it and clears on edit", async () => {
		login.mockRejectedValue({ species: "sdk", kind: "EmailOrPasswordWrong", label: "x", message: "x" })
		const { email, password } = fillAndSubmit()

		const alert = await screen.findByRole("alert")

		expect(alert.textContent).toBe("Wrong email or password. Please try again.")
		expect(password.getAttribute("aria-invalid")).toBe("true")
		expect(password.getAttribute("aria-describedby")).toBe(alert.id)
		expect(email.getAttribute("aria-invalid")).toBe("true")
		await waitFor(() => {
			expect(document.activeElement).toBe(password)
		})
		expect(toastError).not.toHaveBeenCalled()

		fireEvent.change(password, { target: { value: "other" } })

		expect(screen.queryByRole("alert")).toBeNull()
		expect(password.getAttribute("aria-invalid")).toBe("false")
	})

	it("shows other failures as a form-level alert without a toast", async () => {
		login.mockRejectedValue({ species: "sdk", kind: "Server", label: "Rate limited", message: "m", serverMessage: "Rate limited" })
		const { password } = fillAndSubmit()

		const alert = await screen.findByRole("alert")

		expect(alert.textContent).toBe("Rate limited")
		expect(alert.id).toBe("login-form-error")
		expect(password.getAttribute("aria-invalid")).toBe("false")
		await waitFor(() => {
			expect(document.activeElement).toBe(password)
		})
		expect(toastError).not.toHaveBeenCalled()
	})
})
