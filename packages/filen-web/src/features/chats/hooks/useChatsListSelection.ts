import { useEffect, useState, type MouseEvent } from "react"
import type { Chat } from "@filen/sdk-rs"
import { clampListboxIndex, listboxRange, resolveCursorIndex } from "@/features/drive/lib/listbox"
import { useChatsSelectionStore } from "@/features/chats/store/useChatsSelectionStore"

export interface UseChatsListSelectionParams {
	// The ordered, currently-rendered (search-filtered) conversation set click-selection ranges walk —
	// chatsSidebar.tsx's own `rows`, in render order. Shift-range math walks this array's indices.
	chats: readonly Chat[]
}

export interface ChatsListSelection {
	// Drive/notes' modifier-click model, ported: plain click replaces the selection with just this chat
	// (the row's own onClick still lets the Link navigate — see chatRow.tsx); Ctrl/Cmd+click toggles it
	// into a multi-selection; Shift+click extends a range from the last non-shift anchor.
	handlePointerSelect: (index: number, event: MouseEvent) => void
}

// The chats-list counterpart to useNotesListSelection, sized down to what a single flat Link-based row
// list needs — chats has no secondary "view mode" the way notes has notes/tags, so there is no
// resetKey to key a reset off. Reuses drive's own pure range helpers (listbox.ts) rather than
// re-deriving them.
export function useChatsListSelection({ chats }: UseChatsListSelectionParams): ChatsListSelection {
	// Tracked by uuid, not position — a positional index alone drifts under a background reorder (a
	// live socket patch re-sorting the list by lastMessage timestamp, with no click involved) with no
	// click involved, silently retargeting the next Shift+click's range onto the wrong item.
	// `fallbackIndex` is the last position the tracked uuid resolved to, used only once that uuid is no
	// longer present (mirrors useNotesListSelection's identical anchorFallback rationale).
	const [anchorUuid, setAnchorUuid] = useState<string | null>(null)
	const [anchorFallback, setAnchorFallback] = useState(0)

	const uuids = chats.map(chat => chat.uuid)
	const safeAnchorIndex = clampListboxIndex(resolveCursorIndex(anchorUuid, uuids, anchorFallback), chats.length)

	if (anchorFallback !== safeAnchorIndex) {
		setAnchorFallback(safeAnchorIndex)
	}

	// Clears on BOTH mount and unmount. ChatsSidebar only mounts while routed under /chats* (appShell.tsx
	// swaps the contextual sidebar out entirely off that route) — that mount/unmount cycle is the web
	// equivalent of mobile's own List-screen useFocusEffect, which clears `selectedChats` on both focus
	// and blur. A fresh mount must never inherit a selection left over from elsewhere, and navigating away
	// from the chats module entirely must never leave a stale selection sitting in the background store.
	useEffect(() => {
		useChatsSelectionStore.getState().clearSelectedChats()
		// eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate mount reset, mirrors useNotesListSelection
		setAnchorUuid(null)
		setAnchorFallback(0)

		return () => {
			useChatsSelectionStore.getState().clearSelectedChats()
		}
	}, [])

	function selectRange(anchor: number, active: number): void {
		const rangeChats: Chat[] = []

		for (const i of listboxRange(anchor, active)) {
			const chat = chats[i]

			if (chat) {
				rangeChats.push(chat)
			}
		}

		useChatsSelectionStore.getState().setSelectedChats(rangeChats)
	}

	function handlePointerSelect(index: number, event: MouseEvent): void {
		const chat = chats[index]

		if (!chat) {
			return
		}

		if (event.shiftKey) {
			// The anchor deliberately does NOT move here — a run of consecutive Shift+clicks must keep
			// ranging from the same fixed starting point (the last plain/Ctrl+click), exactly like
			// useNotesListSelection's own handlePointerSelect.
			selectRange(safeAnchorIndex, index)

			return
		}

		if (event.metaKey || event.ctrlKey) {
			useChatsSelectionStore.getState().toggleSelectedChat(chat)
			setAnchorUuid(chat.uuid)

			return
		}

		useChatsSelectionStore.getState().setSelectedChats([chat])
		setAnchorUuid(chat.uuid)
	}

	return { handlePointerSelect }
}
