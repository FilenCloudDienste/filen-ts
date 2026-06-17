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

// Turn SDK error objects into a plain { sdkKind, sdkMessage } so they serialize usefully in the
// on-disk logger (and the dev console). The SDK message can carry a file path/name — kept by
// design; only true secrets are stripped at flush by logRedaction.
//
// Never-throw + zero-alloc on the common path: a stale/freed FilenSdkError can make kind()/message()
// (or unwrapSdkError itself) throw — that must NOT escape a console.* call. Each arg is probed in its
// own try/catch, and the array is only copied (copy-on-write) once an SDK error is actually found, so
// the overwhelmingly common "no SDK error" case keeps the original array and allocates nothing.
function unwrapSdkArgs(args: unknown[]): unknown[] {
	let result = args

	for (let i = 0; i < args.length; i++) {
		let replacement: unknown

		try {
			const sdk = unwrapSdkError(args[i])

			if (!sdk) {
				continue
			}

			replacement = {
				sdkKind: sdk.kind(),
				sdkMessage: sdk.message()
			}
		} catch {
			continue
		}

		if (result === args) {
			result = args.slice()
		}

		result[i] = replacement
	}

	return result
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
	logger.captureConsole("warn", unwrapSdkArgs(args))

	if (__DEV__) {
		original.warn(...args)
	}
}

global.console.error = (...args: unknown[]): void => {
	logger.captureConsole("error", unwrapSdkArgs(args))

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
