import { type } from "arktype"
import { isValidEmail } from "@filen/shared"

// The abuse report a public-link visitor sends. Structured, not preformatted: the server formats the ticket.
//
// ★ SECURITY: the report carries the full link URL (the #key fragment included, so staff can open it) and
// the accepted password. It is built only at send time from in-memory state and never persisted, logged or
// put in a query key.

// The order the dialog lists them in.
export const REPORT_REASONS = ["copyright", "stolen", "malware", "csam", "spam", "other"] as const

export type ReportReason = (typeof REPORT_REASONS)[number]

// The server's limit.
export const REPORT_COMMENT_MAX_LENGTH = 10_000

// What the visitor is on, read from the link views when the dialog opens.
export interface ReportSubject {
	// The accepted password; undefined while the gate still shows or for an unprotected link.
	password: string | undefined
	// Inside a directory link: the browse path from the link's root, then the opened file's name if one is.
	viewing: readonly string[]
}

export interface ReportForm {
	reason: ReportReason | null
	email: string
	comment: string
}

// The request body without the challenge token. Empty optional fields are left out.
export interface AbuseReport {
	email: string
	reason: ReportReason
	link: string
	password?: string
	viewing?: string
	comment?: string
}

export function isReportReason(value: unknown): value is ReportReason {
	return REPORT_REASONS.some(reason => reason === value)
}

export function hasReportPassword(subject: ReportSubject): boolean {
	return subject.password !== undefined && subject.password !== ""
}

// Send needs a reason, a valid email and a challenge token.
export function canSendReport(form: ReportForm, token: string | null): boolean {
	return form.reason !== null && isValidEmail(form.email) && token !== null
}

// Null when the form is not sendable.
export function buildAbuseReport(form: ReportForm, subject: ReportSubject, link: string): AbuseReport | null {
	if (form.reason === null || !isValidEmail(form.email)) {
		return null
	}

	const report: AbuseReport = { email: form.email.trim(), reason: form.reason, link }
	const comment = form.comment.trim()

	if (subject.password !== undefined && subject.password !== "") {
		report.password = subject.password
	}

	if (subject.viewing.length > 0) {
		report.viewing = subject.viewing.join("/")
	}

	if (comment !== "") {
		report.comment = comment.slice(0, REPORT_COMMENT_MAX_LENGTH)
	}

	return report
}

export type ReportError = "invalid" | "turnstile" | "rate-limited" | "server"

export type ReportOutcome = { status: "sent" } | { status: "error"; error: ReportError }

const reportResponseSchema = type({ success: "true" }).or({
	success: "false",
	error: "'invalid' | 'turnstile' | 'rate-limited' | 'server'"
})

// Any body the contract does not describe counts as a server failure, as does a success body on an error status.
export function parseReportResponse(ok: boolean, body: unknown): ReportOutcome {
	const parsed = reportResponseSchema(body)

	if (parsed instanceof type.errors) {
		return { status: "error", error: "server" }
	}

	if (parsed.success) {
		return ok ? { status: "sent" } : { status: "error", error: "server" }
	}

	return { status: "error", error: parsed.error }
}
