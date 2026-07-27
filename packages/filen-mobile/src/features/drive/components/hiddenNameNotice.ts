import { type TFunction } from "i18next"
import { isHiddenName, readHideHiddenItems } from "@/features/drive/driveHiddenItems"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"

/**
 * Tell the user when the name they just typed will be filtered out from under them by the
 * hide-hidden-items preference.
 *
 * Creating a directory or renaming an item has no success feedback of its own — the row appearing
 * IS the feedback — so with the preference on, naming something `.private` completes silently and
 * is indistinguishable from a failure.
 *
 * `appliesHere` is the caller's answer to "would this listing actually hide it": the photos
 * timeline offers rename but is not filtered, so the notice would otherwise claim "not listed"
 * about a row still on screen.
 *
 * Reads the preference at call time rather than as reactive state — these run from menu handlers,
 * not from render. Never throws: it is the last step of an action that already succeeded, and a
 * failed preference read must not surface as an unhandled rejection.
 */
export async function notifyIfNameIsHidden({
	name,
	action,
	appliesHere,
	t
}: {
	name: string
	action: "created" | "renamed"
	appliesHere: boolean
	t: TFunction
}): Promise<void> {
	if (!appliesHere || !isHiddenName(name)) {
		return
	}

	try {
		if (!(await readHideHiddenItems())) {
			return
		}
	} catch (error) {
		logger.warn("drive", "hidden-items preference read failed", { error })

		return
	}

	alerts.normal(t(action === "created" ? "created_item_is_hidden" : "renamed_item_is_hidden", { setting: t("hide_hidden_items") }))
}
