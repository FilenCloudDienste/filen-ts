import { useTranslation } from "react-i18next"
import type { AssistantProposal } from "@/features/assistant/types"

// A card's title, also what the live region announces when the card appears.
export function useProposalTitle(): (proposal: AssistantProposal) => string {
	const { t } = useTranslation("assistant")

	return proposal => {
		const count = proposal.targets.length

		switch (proposal.action) {
			case "draft-message":
				return t("assistantProposalDraftMessage", { chat: proposal.targets[0]?.name ?? "" })
			case "move":
				return t("assistantProposalMove", { count })
			case "copy":
				return t("assistantProposalCopy", { count })
			case "trash":
				return t("assistantProposalTrash", { count })
			case "restore":
				return t("assistantProposalRestore", { count })
			case "rename":
				return t("assistantProposalRename", { count })
			case "batch-rename":
				return t("assistantProposalBatchRename", { count })
			case "organize-by-date":
				return t("assistantProposalOrganizeByDate", { count })
			case "favorite":
				return t("assistantProposalFavorite", { count })
			case "unfavorite":
				return t("assistantProposalUnfavorite", { count })
			case "create-directory":
				return t("assistantProposalCreateDirectory")
			case "create-note":
				return t("assistantProposalCreateNote")
			case "note-flags":
				return t("assistantProposalNoteFlags")
			case "add-to-playlist":
				return t("assistantProposalAddTracks", { count })
		}
	}
}
