import { describe, it, expect } from "vitest"

import { common } from "@/locales/en/common"
import { auth } from "@/locales/en/auth"
import { en } from "@/locales/en"

describe("auth catalog", () => {
	it("exposes the shared auth field/label keys via common", () => {
		expect(common.email).toBe("Email")
		expect(common.password).toBe("Password")
		expect(common.sign_in).toBe("Sign in")
		expect(common.email_placeholder_hint).toBe("you@example.com")
		expect(common.please_enter_valid_email).toBe("Please enter a valid email address.")
	})

	it("exposes the auth-specific copy", () => {
		expect(auth.welcome_back).toBe("Welcome back")
		expect(auth.register).toBe("Register")
		expect(auth.create_account).toBe("Create account")
	})

	it("renders the split-sentence link strings with a single <link> placeholder", () => {
		expect(auth.dont_have_an_account).toContain("<link>")
		expect(auth.dont_have_an_account).toContain("</link>")
		expect(auth.already_have_an_account).toContain("<link>")
		expect(auth.already_have_an_account).toContain("</link>")
	})

	it("carries every password-strength label", () => {
		expect(auth.password_strength_weak).toBe("Weak")
		expect(auth.password_strength_normal).toBe("Normal")
		expect(auth.password_strength_strong).toBe("Strong")
		expect(auth.password_strength_best).toBe("Best")
	})

	it("merges auth + common keys into the flat catalog without collisions", () => {
		const commonKeys = Object.keys(common)
		const authKeys = Object.keys(auth)
		const overlap = authKeys.filter(key => commonKeys.includes(key))

		expect(overlap).toEqual([])

		for (const key of [...commonKeys, ...authKeys]) {
			expect(en).toHaveProperty(key)
		}
	})
})
