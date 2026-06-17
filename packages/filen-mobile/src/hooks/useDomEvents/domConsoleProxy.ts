// DOM/WebView-side console proxy. Runs INSIDE the WebView, where the RN diagnostic logger does not
// exist — so this file must NEVER import "@/lib/logger". It overrides console.* to also forward a
// compact envelope to the native side over window.ReactNativeWebView; the native receiver
// (forwardDomConsoleLog) hands it to the RN logger. The original console is still called so the
// WebView dev console keeps working.
//
// In production, console.log/info/debug call sites inside the WebView bundle are stripped by babel
// (transform-remove-console, exclude error/warn — see babel.config.js), so only warn/error actually
// forward — matching the app-wide prod policy without any extra gating here.

export const DOM_LOG_KEY = "__filenLog"

export type DomLogLevel = "log" | "info" | "warn" | "error" | "debug"

export type DomLogEnvelope = {
	[DOM_LOG_KEY]: {
		level: DomLogLevel
		message: string
	}
}

const LEVELS: DomLogLevel[] = ["log", "info", "warn", "error", "debug"]

let installed = false

function formatArg(arg: unknown): string {
	if (typeof arg === "string") {
		return arg
	}

	if (arg instanceof Error) {
		return arg.stack ? `${arg.name}: ${arg.message}\n${arg.stack}` : `${arg.name}: ${arg.message}`
	}

	try {
		return JSON.stringify(arg)
	} catch {
		return String(arg)
	}
}

/**
 * Idempotently override console.* in the current WebView/DOM context to forward each call to the
 * native side. Safe to call on every render — the first successful install wins. A no-op if
 * window.ReactNativeWebView isn't available (then a later call retries).
 */
export function installDomConsoleProxy(): void {
	if (installed) {
		return
	}

	const g = globalThis as unknown as {
		ReactNativeWebView?: { postMessage?: (message: string) => void }
		console: Record<DomLogLevel, (...args: unknown[]) => void>
	}

	const rnWebView = g.ReactNativeWebView

	if (!rnWebView || typeof rnWebView.postMessage !== "function") {
		return
	}

	installed = true

	const post = rnWebView.postMessage.bind(rnWebView)

	// IMPORTANT (babel compatibility): override through `globalThis.console` (a local alias), NEVER
	// bare `console.<method>`. Our babel plugin (transform-remove-console, exclude: error/warn) also
	// runs on the WebView bundle and rewrites assignments to a BARE `console.<method>` by replacing
	// the assigned value with a noop in production. It matches by literal identifier, so a computed
	// bare `console[level]` looks non-excluded for EVERY level → it would noop all overrides,
	// including warn/error, and break forwarding in prod. `globalThis.console` / a local alias is not
	// matched by the plugin, so the overrides survive intact. (App-side console.log/info/debug CALL
	// sites are still stripped in prod, so those simply never fire their override — the intended
	// lean-prod behavior; warn/error call sites survive and forward.)
	const con = g.console

	for (const level of LEVELS) {
		const original = con[level]

		con[level] = (...args: unknown[]): void => {
			original(...args)

			try {
				const envelope: DomLogEnvelope = {
					[DOM_LOG_KEY]: {
						level,
						message: args.map(formatArg).join(" ")
					}
				}

				post(JSON.stringify(envelope))
			} catch {
				// The console proxy must never throw.
			}
		}
	}
}
