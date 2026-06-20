import { unwrapSdkError } from "@/lib/sdkErrors"
import logger from "@/lib/logger"

// Native console methods captured BEFORE we reassign global.console. Forwarding to these (dev) and
// the logger's own internal error handling can never recurse back through this tee.
const original = {
	log: global.console.log.bind(global.console),
	info: global.console.info.bind(global.console),
	warn: global.console.warn.bind(global.console),
	error: global.console.error.bind(global.console),
	debug: global.console.debug.bind(global.console),
	trace: global.console.trace.bind(global.console)
}

// Tee every leveled console.* into the diagnostic logger (gated, redacted at flush), then — in dev
// only — forward to the native console. In production the native console stays silent for these
// methods (as before); the difference is that the output now lands in the on-disk logger instead of
// being discarded. The console object is mutated IN PLACE (rather than replaced with a spread clone)
// so non-leveled methods (group/table/assert/dir/…) are preserved untouched.
global.console.log = (...args: unknown[]): void => {
	logger.captureConsole("debug", args)

	if (__DEV__) {
		original.log(...args)
	}
}

global.console.info = (...args: unknown[]): void => {
	logger.captureConsole("info", args)

	if (__DEV__) {
		original.info(...args)
	}
}

global.console.debug = (...args: unknown[]): void => {
	logger.captureConsole("debug", args)

	if (__DEV__) {
		original.debug(...args)
	}
}

global.console.trace = (...args: unknown[]): void => {
	logger.captureConsole("debug", args)

	if (__DEV__) {
		original.trace(...args)
	}
}

global.console.warn = (...args: unknown[]): void => {
	// Pass args RAW: the logger's enqueue-time freeze (logRedaction.freezeForLog) snapshots any live
	// FilenSdkError into plain { __sdkError } fields, identically for direct logger.* calls and this
	// tee — one code path, one shape. (Previously the tee pre-normalized here; that duplicated the
	// logic and emitted a different, numeric-kind shape.)
	logger.captureConsole("warn", args)

	if (__DEV__) {
		original.warn(...args)
	}
}

global.console.error = (...args: unknown[]): void => {
	// Pass args RAW — see the note on console.warn above (the logger freeze handles SDK errors).
	logger.captureConsole("error", args)

	if (!__DEV__) {
		return
	}

	// Dev: preserve the SDK-error pretty-print. Guarded — a stale SDK error's kind()/message() must
	// not make console.error itself throw.
	try {
		const unwrappedSdkErrors = args.map(arg => unwrapSdkError(arg)).filter(err => err !== null)

		if (unwrappedSdkErrors.length > 0) {
			for (const err of unwrappedSdkErrors) {
				original.error("[Filen SDK Error]", err.kind(), err.message())
			}

			if (unwrappedSdkErrors.length === args.length) {
				return
			}
		}

		const nonSdkArgs = args.filter(arg => unwrapSdkError(arg) === null)

		if (nonSdkArgs.length > 0) {
			original.error(...nonSdkArgs)
		}
	} catch {
		original.error(...args)
	}
}

// Dev DX: also mirror DIRECT logger.* calls (logger.warn/error/info/debug, which otherwise only land
// on disk) to the native console, so they're visible in Metro/devtools alongside console.* output.
// Uses the pre-tee `original` methods, so it can't recurse back through the tee above. Production
// stays silent — in prod globalThis.__DEV__ === false, so the sink is never wired and the logger's
// hot path stays a single null check. (captureConsole-originated entries are NOT mirrored here — the
// tee above already forwarded those console.* calls in dev — so nothing double-prints.)
//
// This reads globalThis.__DEV__ (like the Logger constructor) rather than the bare __DEV__ used in the
// method bodies above: this gate runs at module-eval time, and bare __DEV__ is undefined-at-eval in the
// test runner (would throw), whereas the lazy method-body checks only run after a __DEV__ is in scope.
if ((globalThis as { __DEV__?: boolean }).__DEV__ === true) {
	logger.setDevConsole((level, tag, msg, data): void => {
		const emit = level === "error" ? original.error : level === "warn" ? original.warn : level === "info" ? original.info : original.debug

		if (data !== undefined) {
			emit(`[${tag}] ${msg}`, data)
		} else {
			emit(`[${tag}] ${msg}`)
		}
	})
}
