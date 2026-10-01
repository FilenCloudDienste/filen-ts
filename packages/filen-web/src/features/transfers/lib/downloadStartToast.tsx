import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import { i18n } from "@/lib/i18n"

// Said once a download has a place to save to and its transfer row exists, never for a cancelled save
// picker. `count` is the items a zip holds; a lone file or directory is named instead. The action is a
// real link (the Toaster renders inside the router), styled as sonner's own action button by its data
// attributes.
export function toastDownloadStarted(name: string, count: number): void {
	const id = toast(
		count > 1 ? i18n.t("transfers:transfersDownloadStartedItems", { count }) : i18n.t("transfers:transfersDownloadStarted", { name }),
		{
			action: (
				<Link
					to="/transfers"
					data-button=""
					data-action=""
					onClick={() => {
						toast.dismiss(id)
					}}
				>
					{i18n.t("transfers:transfersDownloadStartedView")}
				</Link>
			)
		}
	)
}
