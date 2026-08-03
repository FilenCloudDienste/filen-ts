import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { isHiddenName } from "@/features/drive/lib/hiddenItems"

// Tells the user when the name they just typed will be filtered out from under them. Creating or
// renaming has no success feedback of its own — the row appearing IS the feedback — so with the
// hidden-items filter on, naming something ".private" completes silently and is indistinguishable
// from a failure. `applies` is the caller's answer to "would THIS listing actually hide it" (the
// preference AND hiddenFilterAppliesTo), threaded in rather than re-read here: every call site
// already holds it. Uses the global i18n singleton for the same reason bulkToast.ts does — every call
// site is an event handler, not a render.
export function notifyIfNameIsHidden(name: string, action: "created" | "renamed", applies: boolean): void {
	if (!applies || !isHiddenName(name)) {
		return
	}

	toast.info(
		i18n.t(action === "created" ? "drive:driveCreatedItemHiddenToast" : "drive:driveRenamedItemHiddenToast", {
			setting: i18n.t("drive:driveShowHiddenItems"),
			display: i18n.t("drive:driveDisplay")
		})
	)
}
