import { type, type Type } from "arktype"
import { log } from "@/lib/log"

// Validates a value at a trust boundary; an invalid one is dropped (and logged), never thrown.
export function decodeValue<T>(value: unknown, schema: Type<T>, tag: string, context: string): T | null {
	const out = schema(value)

	if (out instanceof type.errors) {
		log.warn(tag, `dropping invalid ${context}`, out.summary)

		return null
	}

	// arktype's `Type<t>` callable returns `distill.Out<t>` (its "morph-aware" output shape), which
	// TS cannot statically prove equals the bare `T` this function is generic over — that distinction
	// only matters for schemas with `.pipe()`/default morphs, none of which this app's schemas use.
	// This narrow assertion (arktype's own documented generic-wrapper friction) is the bridge.
	return out as T
}
