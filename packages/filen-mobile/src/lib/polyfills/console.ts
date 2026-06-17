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
function unwrapSdkArgs(args: unknown[]): unknown[] {
	return args.map(arg => {
		const sdk = unwrapSdkError(arg)

		return sdk
			? {
					sdkKind: sdk.kind(),
					sdkMessage: sdk.message()
				}
			: arg
	})
}

// Tee every console.* into the diagnostic logger (gated, redacted at flush), then — in dev only —
// forward to the native console. In production the native console is left silent (as before); the
// difference is that the output now lands in the on-disk logger instead of being discarded.
global.console = {
	...global.console,
	log(...args: unknown[]): void {
		logger.captureConsole("debug", args)

		if (__DEV__) {
			original.log(...args)
		}
	},
	info(...args: unknown[]): void {
		logger.captureConsole("info", args)

		if (__DEV__) {
			original.info(...args)
		}
	},
	debug(...args: unknown[]): void {
		logger.captureConsole("debug", args)

		if (__DEV__) {
			original.debug(...args)
		}
	},
	trace(...args: unknown[]): void {
		logger.captureConsole("debug", args)

		if (__DEV__) {
			original.trace(...args)
		}
	},
	warn(...args: unknown[]): void {
		logger.captureConsole("warn", unwrapSdkArgs(args))

		if (__DEV__) {
			original.warn(...args)
		}
	},
	error(...args: unknown[]): void {
		logger.captureConsole("error", unwrapSdkArgs(args))

		if (!__DEV__) {
			return
		}

		// Dev: preserve the SDK-error pretty-print.
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
	}
}
