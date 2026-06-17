import logger from "@/lib/logger"
import { DOM_LOG_KEY, type DomLogEnvelope, type DomLogLevel } from "@/hooks/useDomEvents/domConsoleProxy"

// console level → logger method. `log` is a dev-trace breadcrumb → debug; the rest map 1:1.
const LEVEL_TO_LOGGER: Record<DomLogLevel, "debug" | "info" | "warn" | "error"> = {
	log: "debug",
	debug: "debug",
	info: "info",
	warn: "warn",
	error: "error"
}

/**
 * Native-side receiver for WebView console-proxy envelopes (see installDomConsoleProxy). If `parsed`
 * is a console envelope, forwards it to the RN diagnostic logger (tag "webview") and returns true so
 * the caller skips its own app-message handling. Returns false for everything else.
 */
export function forwardDomConsoleLog(parsed: unknown): boolean {
	if (typeof parsed !== "object" || parsed === null || !(DOM_LOG_KEY in parsed)) {
		return false
	}

	const envelope = (parsed as DomLogEnvelope)[DOM_LOG_KEY]

	if (typeof envelope !== "object" || envelope === null || typeof envelope.message !== "string") {
		return false
	}

	const method = LEVEL_TO_LOGGER[envelope.level] ?? "info"

	logger[method]("webview", envelope.message)

	return true
}
