import logger from "@/lib/logger"

// Capture the errors that are otherwise INVISIBLE in production:
//
//   1. Uncaught JS exceptions — via React Native's global error handler (ErrorUtils). We chain the
//      previous handler so RN's red box (dev) and native crash reporting (prod) still fire.
//   2. Unhandled promise rejections — RN only enables Hermes' rejection tracker in __DEV__
//      (Libraries/Core/polyfillPromise.js), so PRODUCTION has no rejection tracking at all. We
//      enable our own there. In dev we leave RN's tracker (red box) untouched.
//
// Both route to the on-disk logger and flush immediately, since the app may be about to die.

type ErrorHandler = (error: unknown, isFatal?: boolean) => void

type ErrorUtilsLike = {
	getGlobalHandler?: () => ErrorHandler | undefined
	setGlobalHandler: (handler: ErrorHandler) => void
}

type HermesLike = {
	hasPromise?: () => boolean
	enablePromiseRejectionTracker?: (options: {
		allRejections: boolean
		onUnhandled: (id: number, rejection?: unknown) => void
		onHandled?: (id: number) => void
	}) => void
}

export function installGlobalErrorHandlers(): void {
	const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils

	if (errorUtils) {
		const previous = errorUtils.getGlobalHandler?.()

		errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
			try {
				logger.error("uncaught", isFatal === true ? "Fatal uncaught error" : "Uncaught error", {
					error,
					isFatal: isFatal === true
				})

				// Persist now — a fatal error is about to tear the app down.
				logger.flushNow()
			} catch {
				// Never let logging mask the original crash.
			}

			// Preserve RN's existing behavior (dev red box, native crash reporting).
			if (previous) {
				previous(error, isFatal)
			}
		})
	}

	const hermes = (globalThis as { HermesInternal?: HermesLike }).HermesInternal

	if (!__DEV__ && hermes?.hasPromise?.() === true && hermes.enablePromiseRejectionTracker) {
		hermes.enablePromiseRejectionTracker({
			allRejections: true,
			onUnhandled: (id: number, rejection?: unknown) => {
				try {
					logger.error("unhandledRejection", "Unhandled promise rejection", {
						id,
						rejection
					})

					// An unhandled rejection can precede a crash — persist now, like the uncaught handler.
					logger.flushNow()
				} catch {
					// Never throw from the rejection tracker.
				}
			},
			onHandled: () => {}
		})
	}
}
