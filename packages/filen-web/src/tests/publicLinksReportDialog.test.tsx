// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type RefObject } from "react"
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import "@/lib/i18n"
import type { ReportOutcome, AbuseReport, ReportSubject } from "@/features/publicLinks/lib/report.logic"
import type { TurnstileApi, TurnstileRenderOptions } from "@/features/publicLinks/lib/turnstile"

const { submitAbuseReport, toastSuccess } = vi.hoisted(() => ({
	submitAbuseReport: vi.fn<(report: AbuseReport, token: string, signal: AbortSignal) => Promise<ReportOutcome>>(),
	toastSuccess: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }) }))
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: vi.fn() } }))
vi.mock("@/features/publicLinks/lib/report", () => ({ submitAbuseReport }))

import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { ReportAbuseButton } from "@/features/publicLinks/components/reportAbuseDialog"
import { EMPTY_REPORT_SUBJECT, ReportSubjectContext, useReportPassword, useReportViewing } from "@/features/publicLinks/lib/reportSubject"

// A stand-in Turnstile: each render issues the next token unless `issue` is off.
let issue = true
let tokens = 0
const turnstile = {
	render: vi.fn<TurnstileApi["render"]>((_container: HTMLElement, options: TurnstileRenderOptions) => {
		tokens++

		const token = `token-${String(tokens)}`

		if (issue) {
			queueMicrotask(() => {
				options.callback(token)
			})
		}

		return `widget-${String(tokens)}`
	}),
	reset: vi.fn<TurnstileApi["reset"]>(),
	remove: vi.fn<TurnstileApi["remove"]>()
}

function renderButton({ signedIn = false, subject }: { signedIn?: boolean; subject?: ReportSubject } = {}) {
	const button = createElement(ReportAbuseButton, { signedIn })

	if (subject === undefined) {
		return render(button)
	}

	const ref: RefObject<ReportSubject> = { current: subject }

	return render(createElement(ReportSubjectContext, { value: ref }, button))
}

function openDialog(): void {
	fireEvent.click(screen.getByRole("button", { name: "Report abuse" }))
}

function send(): HTMLButtonElement {
	return screen.getByRole("button", { name: /Send$/ })
}

function emailInput(): HTMLInputElement {
	return screen.getByLabelText("Your email")
}

function fill(email: string): void {
	fireEvent.click(screen.getByRole("radio", { name: "Malware" }))
	fireEvent.change(emailInput(), { target: { value: email } })
}

beforeEach(() => {
	issue = true
	tokens = 0
	queryClient.clear()
	window.turnstile = turnstile
})

afterEach(() => {
	cleanup()
	delete window.turnstile
})

describe("ReportAbuseDialog", () => {
	it("enables Send only with a reason, a valid email and a challenge token", async () => {
		renderButton()
		openDialog()

		await waitFor(() => {
			expect(turnstile.render).toHaveBeenCalledTimes(1)
		})
		expect(send().disabled).toBe(true)
		expect(screen.getAllByRole("radio").some(radio => radio.getAttribute("aria-checked") === "true")).toBe(false)

		fireEvent.change(emailInput(), { target: { value: "visitor@example.com" } })
		expect(send().disabled).toBe(true)

		fireEvent.click(screen.getByRole("radio", { name: "Malware" }))
		await waitFor(() => {
			expect(send().disabled).toBe(false)
		})

		fireEvent.change(emailInput(), { target: { value: "visitor@" } })
		expect(send().disabled).toBe(true)
	})

	it("keeps Send disabled until the challenge issues a token", async () => {
		issue = false
		renderButton()
		openDialog()
		fill("visitor@example.com")

		await waitFor(() => {
			expect(turnstile.render).toHaveBeenCalledTimes(1)
		})
		expect(send().disabled).toBe(true)
	})

	it("prefills a signed-in visitor's email from the cached account, editable", () => {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, { email: "me@example.com" })
		renderButton({ signedIn: true })
		openDialog()

		expect(emailInput().value).toBe("me@example.com")
		fireEvent.change(emailInput(), { target: { value: "other@example.com" } })
		expect(emailInput().value).toBe("other@example.com")
	})

	it("leaves the email empty for a signed-out visitor", () => {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, { email: "me@example.com" })
		renderButton()
		openDialog()

		expect(emailInput().value).toBe("")
	})

	it("mentions the password only when one opened the link", () => {
		const note = "Your report includes this link and its password so our team can review it."

		renderButton({ subject: { password: "hunter2", viewing: [] } })
		openDialog()
		expect(screen.getByText(note)).toBeDefined()

		cleanup()
		renderButton({ subject: { password: undefined, viewing: [] } })
		openDialog()
		expect(screen.queryByText(note)).toBeNull()
		expect(screen.getByText("Your report includes this link so our team can review it.")).toBeDefined()
	})

	it("sends the report with the token, closes and shows a success toast", async () => {
		submitAbuseReport.mockResolvedValue({ status: "sent" })
		renderButton({ subject: { password: "hunter2", viewing: ["Shared", "kit.exe"] } })
		openDialog()
		fill("visitor@example.com")
		fireEvent.change(screen.getByLabelText("Details (optional)"), { target: { value: "phishing kit" } })

		await waitFor(() => {
			expect(send().disabled).toBe(false)
		})
		fireEvent.click(send())

		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull()
		})
		expect(submitAbuseReport).toHaveBeenCalledTimes(1)
		expect(submitAbuseReport.mock.calls[0]?.[0]).toEqual({
			email: "visitor@example.com",
			reason: "malware",
			link: window.location.href,
			password: "hunter2",
			viewing: "Shared/kit.exe",
			comment: "phishing kit"
		})
		expect(submitAbuseReport.mock.calls[0]?.[1]).toBe("token-1")
		expect(toastSuccess).toHaveBeenCalledWith("Report sent. Thank you.")
		expect(turnstile.remove).toHaveBeenCalledWith("widget-1")
	})

	it("disables the inputs while sending", async () => {
		submitAbuseReport.mockReturnValue(new Promise(() => undefined))
		renderButton()
		openDialog()
		fill("visitor@example.com")

		await waitFor(() => {
			expect(send().disabled).toBe(false)
		})
		fireEvent.click(send())

		await waitFor(() => {
			expect(emailInput().disabled).toBe(true)
		})
		expect(send().disabled).toBe(true)
		expect(screen.getByLabelText<HTMLTextAreaElement>("Details (optional)").disabled).toBe(true)
	})

	it("shows a failure inline, keeps the inputs and asks for a fresh token", async () => {
		submitAbuseReport.mockResolvedValue({ status: "error", error: "rate-limited" })
		renderButton()
		openDialog()
		fill("visitor@example.com")

		await waitFor(() => {
			expect(send().disabled).toBe(false)
		})
		fireEvent.click(send())

		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toBe("Too many reports. Try again later.")
		})
		expect(screen.getByRole("dialog")).toBeDefined()
		expect(emailInput().value).toBe("visitor@example.com")
		expect(screen.getByRole("radio", { name: "Malware" }).getAttribute("aria-checked")).toBe("true")
		expect(toastSuccess).not.toHaveBeenCalled()
		// The used token's widget goes and a new one issues the next token. The old widget goes in the remounted
		// challenge's effect cleanup, which React runs after the commit that shows the alert.
		await waitFor(() => {
			expect(turnstile.remove).toHaveBeenCalledWith("widget-1")
		})
		await waitFor(() => {
			expect(send().disabled).toBe(false)
		})
		expect(turnstile.render).toHaveBeenCalledTimes(2)

		submitAbuseReport.mockResolvedValue({ status: "sent" })
		fireEvent.click(send())

		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull()
		})
		expect(submitAbuseReport.mock.calls[1]?.[1]).toBe("token-2")
	})

	it("says so when the challenge cannot load", async () => {
		delete window.turnstile
		turnstile.render.mockImplementationOnce((_container, options) => {
			queueMicrotask(() => {
				options["error-callback"]("110200")
			})

			return "widget-x"
		})
		window.turnstile = turnstile
		renderButton()
		openDialog()

		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toBe("The security check couldn't load. Check your connection and try again.")
		})
	})

	it("retries a challenge that could not load and keeps what was typed", async () => {
		turnstile.render.mockImplementationOnce((_container, options) => {
			queueMicrotask(() => {
				options["error-callback"]("110200")
			})

			return "widget-x"
		})
		renderButton()
		openDialog()
		fill("visitor@example.com")
		fireEvent.change(screen.getByLabelText("Details (optional)"), { target: { value: "phishing kit" } })

		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toBe("The security check couldn't load. Check your connection and try again.")
		})
		expect(send().disabled).toBe(true)

		fireEvent.click(screen.getByRole("button", { name: "Try again" }))

		await waitFor(() => {
			expect(turnstile.render).toHaveBeenCalledTimes(2)
		})
		await waitFor(() => {
			expect(send().disabled).toBe(false)
		})
		expect(screen.queryByRole("alert")).toBeNull()
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
		expect(turnstile.remove).toHaveBeenCalledWith("widget-x")
		expect(emailInput().value).toBe("visitor@example.com")
		expect(screen.getByRole("radio", { name: "Malware" }).getAttribute("aria-checked")).toBe("true")
		expect(screen.getByLabelText<HTMLTextAreaElement>("Details (optional)").value).toBe("phishing kit")
	})
})

describe("report subject", () => {
	it("holds the views' password and browse path only while they are mounted", () => {
		const ref: RefObject<ReportSubject> = { current: EMPTY_REPORT_SUBJECT }
		const viewing = ["Shared", "tools"]
		const hook = renderHook(
			() => {
				useReportPassword("hunter2")
				useReportViewing(viewing)
			},
			{ wrapper: ({ children }) => createElement(ReportSubjectContext, { value: ref }, children) }
		)

		expect(ref.current).toEqual({ password: "hunter2", viewing })

		hook.unmount()
		expect(ref.current).toEqual(EMPTY_REPORT_SUBJECT)
	})
})
