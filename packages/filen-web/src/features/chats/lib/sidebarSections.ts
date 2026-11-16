import { useSyncExternalStore } from "react"
import { type } from "arktype"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"
import type { ChatSection } from "@/features/chats/components/chatsSidebar.logic"

// Which conversation-list sections the user has collapsed, kept on this device and read during boot
// (lib/sdk/boot.ts) so the list's first render lays them out as the user left them.

export type CollapsedChatSections = Readonly<Record<ChatSection, boolean>>

const preference = preloadedPreference<CollapsedChatSections>({
	key: "chats.collapsedSections.v1",
	schema: type({ direct: "boolean", groups: "boolean" }),
	fallback: { direct: false, groups: false },
	scope: "chats",
	same: (a, b) => a.direct === b.direct && a.groups === b.groups
})

export const loadCollapsedChatSections = preference.load

export function useCollapsedChatSections(): CollapsedChatSections {
	return useSyncExternalStore(preference.subscribe, preference.get, preference.get)
}

export function toggleChatSection(section: ChatSection): void {
	const current = preference.get()

	preference.set({ ...current, [section]: !current[section] })
}
