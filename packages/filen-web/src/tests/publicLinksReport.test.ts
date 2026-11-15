import { afterEach, describe, expect, it, vi } from "vitest"
import {
	buildAbuseReport,
	canSendReport,
	hasReportPassword,
	parseReportResponse,
	REPORT_COMMENT_MAX_LENGTH,
	type ReportForm,
	type ReportSubject
} from "@/features/publicLinks/lib/report.logic"
import { REPORT_URL, submitAbuseReport } from "@/features/publicLinks/lib/report"

const LINK = "https://app.filen.io/d/0e8f0a7c-1111-2222-3333-444444444444#secretkey"
const NO_SUBJECT: ReportSubject = { password: undefined, viewing: [] }
const FORM: ReportForm = { reason: "malware", email: " visitor@example.com ", comment: "" }

describe("buildAbuseReport", () => {
	it("carries the reason, the trimmed email and the full link with its key, nothing else when empty", () => {
		expect(buildAbuseReport(FORM, NO_SUBJECT, LINK)).toEqual({ email: "visitor@example.com", reason: "malware", link: LINK })
	})

	it("adds the accepted password", () => {
		expect(buildAbuseReport(FORM, { password: "hunter2", viewing: [] }, LINK)?.password).toBe("hunter2")
	})

	it("leaves an empty password out", () => {
		expect(buildAbuseReport(FORM, { password: "", viewing: [] }, LINK)).not.toHaveProperty("password")
	})

	it("adds the trimmed comment", () => {
		expect(buildAbuseReport({ ...FORM, comment: "  phishing kit\nin /tools  " }, NO_SUBJECT, LINK)?.comment).toBe(
			"phishing kit\nin /tools"
		)
	})

	it("leaves a blank comment out", () => {
		expect(buildAbuseReport({ ...FORM, comment: " \n " }, NO_SUBJECT, LINK)).not.toHaveProperty("comment")
	})

	it("caps the comment at the server's limit", () => {
		expect(buildAbuseReport({ ...FORM, comment: "x".repeat(REPORT_COMMENT_MAX_LENGTH + 5) }, NO_SUBJECT, LINK)?.comment).toHaveLength(
			REPORT_COMMENT_MAX_LENGTH
		)
	})

	it("joins the browse path and the opened file", () => {
		expect(buildAbuseReport(FORM, { password: undefined, viewing: ["Shared", "tools", "kit.exe"] }, LINK)?.viewing).toBe(
			"Shared/tools/kit.exe"
		)
	})

	it("is null without a reason or with an invalid email", () => {
		expect(buildAbuseReport({ ...FORM, reason: null }, NO_SUBJECT, LINK)).toBeNull()
		expect(buildAbuseReport({ ...FORM, email: "visitor@" }, NO_SUBJECT, LINK)).toBeNull()
	})
})

describe("canSendReport", () => {
	it("needs a reason, a valid email and a token", () => {
		expect(canSendReport(FORM, "token")).toBe(true)
		expect(canSendReport(FORM, null)).toBe(false)
		expect(canSendReport({ ...FORM, reason: null }, "token")).toBe(false)
		expect(canSendReport({ ...FORM, email: "no-at-sign" }, "token")).toBe(false)
		expect(canSendReport({ ...FORM, email: "a@b" }, "token")).toBe(false)
	})
})

describe("hasReportPassword", () => {
	it("is true only for a non-empty password", () => {
		expect(hasReportPassword({ password: "p", viewing: [] })).toBe(true)
		expect(hasReportPassword({ password: "", viewing: [] })).toBe(false)
		expect(hasReportPassword(NO_SUBJECT)).toBe(false)
	})
})

describe("parseReportResponse", () => {
	it("accepts a success body on an OK status", () => {
		expect(parseReportResponse(true, { success: true })).toEqual({ status: "sent" })
	})

	it("maps each error code", () => {
		for (const error of ["invalid", "turnstile", "rate-limited", "server"] as const) {
			expect(parseReportResponse(false, { success: false, error })).toEqual({ status: "error", error })
		}
	})

	it("treats anything outside the contract as a server error", () => {
		expect(parseReportResponse(true, null)).toEqual({ status: "error", error: "server" })
		expect(parseReportResponse(true, { status: true })).toEqual({ status: "error", error: "server" })
		expect(parseReportResponse(false, { success: false, error: "teapot" })).toEqual({ status: "error", error: "server" })
		expect(parseReportResponse(false, { success: true })).toEqual({ status: "error", error: "server" })
	})
})

describe("submitAbuseReport", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("posts the report with the token as JSON, without credentials", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))

		vi.stubGlobal("fetch", fetchMock)

		const report = { email: "visitor@example.com", reason: "spam" as const, link: LINK }

		await expect(submitAbuseReport(report, "tok", new AbortController().signal)).resolves.toEqual({ status: "sent" })

		const [url, init] = fetchMock.mock.calls[0] ?? []

		expect(url).toBe(REPORT_URL)
		expect(init?.method).toBe("POST")
		expect(init?.credentials).toBe("omit")
		expect(typeof init?.body).toBe("string")
		expect(JSON.parse(init?.body as string)).toEqual({ turnstileToken: "tok", ...report })
	})

	it("maps an error body", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn<typeof fetch>()
				.mockResolvedValue(new Response(JSON.stringify({ success: false, error: "rate-limited" }), { status: 429 }))
		)

		await expect(
			submitAbuseReport({ email: "a@example.com", reason: "spam", link: LINK }, "tok", new AbortController().signal)
		).resolves.toEqual({ status: "error", error: "rate-limited" })
	})

	it("turns a network failure or a non-JSON body into a server error", async () => {
		vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch")))

		await expect(
			submitAbuseReport({ email: "a@example.com", reason: "spam", link: LINK }, "tok", new AbortController().signal)
		).resolves.toEqual({ status: "error", error: "server" })

		vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>", { status: 502 })))

		await expect(
			submitAbuseReport({ email: "a@example.com", reason: "spam", link: LINK }, "tok", new AbortController().signal)
		).resolves.toEqual({ status: "error", error: "server" })
	})
})
