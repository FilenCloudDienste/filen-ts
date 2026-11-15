import { parseReportResponse, type AbuseReport, type ReportOutcome } from "@/features/publicLinks/lib/report.logic"
import { log } from "@/lib/log"

// The website's report endpoint, not the Filen API, so a plain fetch rather than the SDK.
export const REPORT_URL = "https://filen.io/api/v1/abuse-report"

const REPORT_TIMEOUT_MS = 20_000

// Never rejects: a network failure, a timeout or an abort is a server error. Only the status is logged, never the
// report (it holds the link key and password).
export async function submitAbuseReport(report: AbuseReport, turnstileToken: string, signal: AbortSignal): Promise<ReportOutcome> {
	try {
		const response = await fetch(REPORT_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ turnstileToken, ...report }),
			credentials: "omit",
			signal: AbortSignal.any([signal, AbortSignal.timeout(REPORT_TIMEOUT_MS)])
		})
		const outcome = parseReportResponse(response.ok, await response.json().catch(() => null))

		if (outcome.status === "error") {
			log.warn("abuseReport", `rejected: HTTP ${String(response.status)} ${outcome.error}`)
		}

		return outcome
	} catch (e) {
		log.warn("abuseReport", "request failed", e instanceof Error ? e.name : "unknown")

		return { status: "error", error: "server" }
	}
}
