import { unwrapSdkError } from "@/lib/utils"

const originalConsoleError = global.console.error

global.console = {
	...global.console,
	error(...args: unknown[]): void {
		const unwrappedSdkErrors = args.map(arg => unwrapSdkError(arg)).filter(err => err !== null)

		if (unwrappedSdkErrors.length > 0) {
			for (const err of unwrappedSdkErrors) {
				originalConsoleError("[Filen SDK Error]", err.kind(), err.message())
			}

			if (unwrappedSdkErrors.length === args.length) {
				return
			}
		}

		originalConsoleError(...args)
	}
}
