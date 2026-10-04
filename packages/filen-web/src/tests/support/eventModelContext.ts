import { i18n } from "@/lib/i18n"
import type { EventModelContext } from "@/features/settings/lib/eventModel"

// The event model's context over the real English catalog and empty caches, unless overridden.
export function testEventModelContext(overrides: Partial<EventModelContext> = {}): EventModelContext {
	return {
		t: i18n.getFixedT<["events", "drive"]>("en", ["events", "drive"]),
		directoryName: () => undefined,
		contact: () => undefined,
		rootUuid: undefined,
		...overrides
	}
}
