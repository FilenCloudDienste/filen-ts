// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"

const toastError = vi.hoisted(() => vi.fn())

vi.mock("sonner", () => ({ toast: { error: toastError } }))

import "@/lib/i18n"
import { MasterKeysFileField } from "@/features/auth/components/masterKeysFileField"

function fileWithText(name: string, text: () => Promise<string>): File {
	const file = new File([""], name, { type: "text/plain" })

	Object.defineProperty(file, "text", { value: text })

	return file
}

function pick(file: File): HTMLInputElement {
	const input = document.getElementById("master-keys-file")

	if (!(input instanceof HTMLInputElement)) {
		throw new Error("master keys file input not rendered")
	}

	fireEvent.change(input, { target: { files: [file] } })

	return input
}

beforeEach(() => {
	toastError.mockClear()
})

afterEach(() => {
	cleanup()
})

describe("MasterKeysFileField", () => {
	it("hands the caller the file's text without its trailing newline", async () => {
		const onChange = vi.fn()

		render(createElement(MasterKeysFileField, { disabled: false, onChange }))
		pick(fileWithText("keys.txt", () => Promise.resolve("  QUJDREVGR0g=\r\n")))

		await waitFor(() => {
			expect(onChange).toHaveBeenCalledWith("QUJDREVGR0g=")
		})
		expect(screen.getByText("Master keys imported (keys.txt)")).toBeTruthy()
		expect(toastError).not.toHaveBeenCalled()
	})

	it("treats a whitespace-only file as a failed pick", async () => {
		const onChange = vi.fn()

		render(createElement(MasterKeysFileField, { disabled: false, onChange }))
		pick(fileWithText("blank.txt", () => Promise.resolve(" \r\n\t\n")))

		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith("The master keys file is invalid. Please check the file and try again.")
		})
		expect(onChange).not.toHaveBeenCalledWith("")
		expect(onChange).toHaveBeenLastCalledWith(undefined)
		expect(screen.queryByText(/Master keys imported/)).toBeNull()
	})

	it("drops the previous file when re-picking fails to read", async () => {
		const onChange = vi.fn()

		render(createElement(MasterKeysFileField, { disabled: false, onChange }))
		pick(fileWithText("keys.txt", () => Promise.resolve("QUJDREVGR0g=")))

		await waitFor(() => {
			expect(screen.getByText("Master keys imported (keys.txt)")).toBeTruthy()
		})

		const input = pick(fileWithText("broken.txt", () => Promise.reject(new Error("read failed"))))

		await waitFor(() => {
			expect(toastError).toHaveBeenCalledOnce()
		})
		expect(onChange).toHaveBeenLastCalledWith(undefined)
		expect(screen.queryByText(/Master keys imported/)).toBeNull()
		expect(input.value).toBe("")
	})
})
