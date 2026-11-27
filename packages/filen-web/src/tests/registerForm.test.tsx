// @vitest-environment jsdom

// Register warns up front that a forgotten password means unrecoverable data.
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import "@/lib/i18n"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/features/auth/queries/registerCheck", () => ({ useRegisterCheckQuery: () => ({ data: undefined }) }))
vi.mock("@/features/auth/lib/referral", () => ({ getReferral: () => ({}) }))

import { RegisterForm } from "@/features/auth/components/registerForm"

afterEach(() => {
	cleanup()
})

describe("RegisterForm", () => {
	it("shows the unrecoverable-password note after the password field", () => {
		render(<RegisterForm />)
		const note = screen.getByText("Filen can't reset your password. If you forget it, your data can't be recovered.")
		const password = screen.getByLabelText("Password", { exact: true })

		expect(note.className).toContain("text-muted-foreground")
		expect(password.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})
})
