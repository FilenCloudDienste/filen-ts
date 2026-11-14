// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { PDF_PERMISSIONS_ALL } from "@filen/office/core/pdfedit/security"
import type { PdfSecurityDescription } from "@filen/office/dom/pdfedit/security"
import { PdfProtectDialog } from "@/features/pdf/security/protectDialog"
import { PdfOwnerUnlockDialog } from "@/features/pdf/security/ownerUnlockDialog"
import "@/lib/i18n"

// The Protect document dialog and the owner password prompt: values in, callbacks out.

const GRANTED = { print: true, printHq: true, copy: true, edit: true, annotate: true, form: true, assemble: true, accessibility: true }

function description(overrides: Partial<PdfSecurityDescription>): PdfSecurityDescription {
	return {
		method: "none",
		rc4: false,
		openPassword: false,
		permissions: PDF_PERMISSIONS_ALL,
		restricted: false,
		allowed: { print: true, copy: true, change: true },
		ownerAccess: true,
		granted: GRANTED,
		upgrade: "notRc4",
		...overrides
	}
}

function protect(current: PdfSecurityDescription) {
	const onApply = vi.fn()
	const onUnlock = vi.fn()

	render(
		<PdfProtectDialog
			open
			pending={false}
			current={current}
			onOpenChange={() => undefined}
			onApply={onApply}
			onUnlock={onUnlock}
		/>
	)

	return { onApply, onUnlock }
}

function type(label: string, value: string): void {
	fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function apply(): HTMLButtonElement {
	const button = screen.getByRole("button", { name: "Apply" })

	if (!(button instanceof HTMLButtonElement)) throw new Error("no submit button")

	return button
}

afterEach(() => {
	cleanup()
})

describe("PdfProtectDialog", () => {
	it("sets a password to open typed twice, in fields no password manager takes", () => {
		const { onApply } = protect(description({}))

		fireEvent.click(screen.getByRole("radio", { name: "Password to open" }))
		expect(screen.getByText("New passwords encrypt the file with AES-256.")).toBeTruthy()

		type("Password", "pässwörd")
		type("Confirm password", "pässword")
		expect(screen.getByText("The passwords don't match.")).toBeTruthy()
		expect(apply().disabled).toBe(true)

		type("Confirm password", "pässwörd")

		const field = screen.getByLabelText("Password")

		expect(field.getAttribute("type")).toBe("text")
		expect(field.getAttribute("data-1p-ignore")).toBe("true")

		fireEvent.click(apply())
		expect(onApply).toHaveBeenCalledWith({ kind: "open", password: "pässwörd" })
	})

	it("flags a password PDF encryption refuses", () => {
		protect(description({}))
		fireEvent.click(screen.getByRole("radio", { name: "Password to open" }))
		type("Password", "bell\u0007")
		expect(screen.getByText("This password has a character PDF encryption can't use.")).toBeTruthy()
	})

	it("restricts editing with the advisory note and the allowed actions", () => {
		const { onApply } = protect(description({}))

		fireEvent.click(screen.getByRole("radio", { name: "Restrict editing" }))
		expect(
			screen.getByText(
				"Restrictions ask other apps to limit editing and printing. They don't encrypt the file; only a password to open does."
			)
		).toBeTruthy()

		fireEvent.click(screen.getByRole("checkbox", { name: "Copying" }))
		fireEvent.click(screen.getByRole("checkbox", { name: "Changes" }))
		type("Owner password", "owner")
		type("Confirm owner password", "owner")
		fireEvent.click(apply())
		expect(onApply).toHaveBeenCalledWith({
			kind: "restrict",
			ownerPassword: "owner",
			openPassword: null,
			allowed: { print: true, copy: false, change: false }
		})
	})

	it("locks changes without owner access, with the owner restriction text and Unlock", () => {
		const { onUnlock } = protect(description({ method: "aes-256", restricted: true, ownerAccess: false }))

		expect(screen.getByText("The document's author restricted this. Unlock with the owner password.")).toBeTruthy()
		expect(screen.getByRole("radio", { name: "No password" }).getAttribute("aria-disabled")).toBe("true")
		expect(apply().disabled).toBe(true)

		fireEvent.click(screen.getByRole("button", { name: "Unlock" }))
		expect(onUnlock).toHaveBeenCalled()
	})

	it("removes encryption with owner access", () => {
		const { onApply } = protect(description({ method: "aes-256", openPassword: true }))

		fireEvent.click(screen.getByRole("radio", { name: "No password" }))
		expect(screen.getByText("Saving removes the password and restrictions.")).toBeTruthy()
		fireEvent.click(apply())
		expect(onApply).toHaveBeenCalledWith({ kind: "remove" })
	})

	it("offers the RC4 upgrade", () => {
		const { onApply } = protect(description({ method: "rc4-128", rc4: true, openPassword: true, upgrade: null }))
		const offer = screen.getByRole("checkbox", { name: "This PDF uses outdated encryption. Upgrade to AES-256 when you save?" })

		expect(offer).toHaveProperty("checked", true)
		fireEvent.click(apply())
		expect(onApply).toHaveBeenCalledWith({ kind: "upgrade" })
	})

	it("explains an upgrade that can't carry the passwords over", () => {
		protect(description({ method: "rc4-40", rc4: true, restricted: true, ownerAccess: false, upgrade: "ownerRequired" }))

		expect(
			screen.getByRole("checkbox", { name: "This PDF uses outdated encryption. Upgrade to AES-256 when you save?" })
		).toHaveProperty("disabled", true)
		expect(screen.getByText("To upgrade, unlock with the owner password or set new passwords.")).toBeTruthy()
	})
})

describe("PdfOwnerUnlockDialog", () => {
	it("hands the typed password over and shows a wrong one", () => {
		const onUnlock = vi.fn()

		render(
			<PdfOwnerUnlockDialog
				open
				pending={false}
				wrong
				onOpenChange={() => undefined}
				onUnlock={onUnlock}
			/>
		)

		expect(screen.getByText("That isn't the owner password. Try again.")).toBeTruthy()

		const field = screen.getByLabelText("Owner password")

		expect(field.getAttribute("type")).toBe("text")
		fireEvent.change(field, { target: { value: "密码" } })
		fireEvent.click(screen.getByRole("button", { name: "Unlock" }))
		expect(onUnlock).toHaveBeenCalledWith("密码")
	})
})
