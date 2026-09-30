import prompts, { type AlertPromptOptions, type InputPromptOptions } from "@/lib/prompts"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"

// How a caller logs a prompt that threw (a native dialog bug); each site keeps its own tag, message, level and context.
export type PromptFailureLog = {
	tag: string
	message: string
	level?: "warn" | "error"
	context?: Record<string, unknown>
}

function reportPromptFailure(log: PromptFailureLog, error: unknown): void {
	logger[log.level ?? "warn"](log.tag, log.message, {
		...log.context,
		error
	})

	alerts.error(error)
}

// True only when the prompt was shown and confirmed. A throw is logged and surfaced, and reads as not confirmed.
export async function confirmPrompt(options: AlertPromptOptions, log: PromptFailureLog): Promise<boolean> {
	try {
		const result = await prompts.alert(options)

		return !result.cancelled
	} catch (e) {
		reportPromptFailure(log, e)

		return false
	}
}

// The entered value, or null on a throw (logged and surfaced), a cancel, or an empty value unless `allowEmpty`.
export async function inputPrompt(
	options: InputPromptOptions,
	log: PromptFailureLog,
	opts?: {
		trim?: boolean
		allowEmpty?: boolean
	}
): Promise<string | null> {
	try {
		const result = await prompts.input(options)

		if (result.cancelled) {
			return null
		}

		const value = opts?.trim ? result.value.trim() : result.value

		if (!opts?.allowEmpty && value.length === 0) {
			return null
		}

		return value
	} catch (e) {
		reportPromptFailure(log, e)

		return null
	}
}
