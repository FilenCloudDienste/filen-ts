import { type TFunction } from "i18next"
import { type NoteTag } from "@/types"
import { NoteType } from "@filen/sdk-rs"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import { router } from "expo-router"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import notesLib from "@/features/notes/notes"
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
	const result = await run(async () => {
		return await prompts.input({
			title: t("create_note"),
			message: t("enter_note_name"),
			cancelText: t("cancel"),
			okText: t("create")
		})
	})

	if (!result.success) {
		logger.error("notes", "create note prompt failed", { error: result.error })
		alerts.error(result.error)

		return
	}

	if (result.data.cancelled || result.data.type !== "string") {
		return
	}

	const title = result.data.value.trim()

	if (title.length === 0) {
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
	const result = await run(async () => {
		return await prompts.input({
			title: t("new_tag_name"),
			message: t("enter_tag_name"),
			cancelText: t("cancel"),
			okText: t("add")
		})
	})

	if (!result.success) {
		logger.error("notes", "create tag prompt failed", { error: result.error })
		alerts.error(result.error)

		return
	}

	if (result.data.cancelled || result.data.type !== "string") {
		return
	}

	const name = result.data.value.trim()

	if (name.length === 0) {
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
