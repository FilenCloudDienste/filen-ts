import { type TFunction } from "i18next"
import { type NoteTag } from "@/types"
import { NoteType } from "@filen/sdk-rs"
import alerts from "@/lib/alerts"
import { router } from "@/lib/router"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { inputPrompt } from "@/lib/promptFlow"
import notesLib from "@/features/notes/notes"
import { confirmedAction } from "@/lib/confirmedAction"
import logger from "@/lib/logger"

export const createNoteFlow = async ({
	t,
	tag,
	type = NoteType.Text
}: {
	t: TFunction
	tag: NoteTag | null
	type?: NoteType
}): Promise<void> => {
	const title = await inputPrompt(
		{
			title: t("create_note"),
			message: t("enter_note_name"),
			cancelText: t("cancel"),
			okText: t("create")
		},
		{ tag: "notes", message: "create note prompt failed", level: "error" },
		{ trim: true }
	)

	if (title === null) {
		return
	}

	const createResult = await runWithLoading(async () => {
		return await notesLib.createWithOptionalTag({
			title,
			type,
			tag: tag ?? undefined
		})
	})

	if (!createResult.success) {
		logger.error("notes", "create note failed", { error: createResult.error })
		alerts.error(createResult.error)

		return
	}

	router.push(`/note/${createResult.data.uuid}`)
}

export const createTagFlow = async ({ t }: { t: TFunction }): Promise<void> => {
	const name = await inputPrompt(
		{
			title: t("new_tag_name"),
			message: t("enter_tag_name"),
			cancelText: t("cancel"),
			okText: t("add")
		},
		{ tag: "notes", message: "create tag prompt failed", level: "error" },
		{ trim: true }
	)

	if (name === null) {
		return
	}

	const createResult = await runWithLoading(async () => {
		await notesLib.createTag({ name })
	})

	if (!createResult.success) {
		logger.error("notes", "create tag failed", { error: createResult.error })
		alerts.error(createResult.error)

		return
	}
}

export const deleteTagAction = ({ t, tag }: { t: TFunction; tag: NoteTag }): (() => Promise<void>) =>
	confirmedAction({
		promptTitle: t("delete_tag"),
		promptMessage: t("are_you_sure_delete_tag"),
		promptOkText: t("delete"),
		action: () => notesLib.deleteTag({ tag })
	})
