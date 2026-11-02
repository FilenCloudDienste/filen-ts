import { useTranslation } from "react-i18next"
import { MessageSquarePlusIcon, MessagesSquareIcon } from "lucide-react"
import { RibbonButton } from "@/features/office/components/ribbon/ribbonControls"
import { slideReview, useSlideReviewState } from "@/features/presentation/components/commentsPane.logic"
import type { PresentationGroups } from "@/features/presentation/components/ribbon/tabs"

// The presentation ribbon's Review groups: New Comment (the Comments pane opens on its field) and the Comments pane
// shown or hidden. Show Comments is offered in a deck that can only be viewed too; its comments read there.

const BUTTON = 30

function CommentButtons({ editable, empty }: { editable: boolean; empty: boolean }) {
	const { t } = useTranslation("preview")
	const state = useSlideReviewState()

	return (
		<>
			{editable ? (
				<RibbonButton
					label={t("previewPptxCommentNew")}
					icon={<MessageSquarePlusIcon />}
					text={t("previewPptxCommentNew")}
					disabled={empty}
					onClick={() => {
						slideReview.openThread(undefined)
						slideReview.compose(true)
					}}
				/>
			) : null}
			<RibbonButton
				label={t("previewPptxCommentsShow")}
				icon={<MessagesSquareIcon />}
				disabled={empty}
				pressed={state.open}
				onClick={() => {
					slideReview.setOpen(!state.open)
				}}
			/>
		</>
	)
}

export const reviewGroups: PresentationGroups = context => {
	const editor = context.editor

	if (editor === undefined) return []

	const editable = context.editable

	return [
		{
			id: "comments",
			label: context.t("previewPptxReviewComments", { ns: "preview" }),
			icon: MessagesSquareIcon,
			width: (editable ? 4 : 1) * BUTTON,
			priority: 3,
			content: (
				<CommentButtons
					editable={editable}
					empty={editor.render === undefined}
				/>
			)
		}
	]
}
