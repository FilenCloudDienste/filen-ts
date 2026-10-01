import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"

// The toasts' type icons, shared by the Toaster and the activity toasts, which swap their running spinner
// for the result's icon in place (an `icon` set on a toast replaces its type's).
export const TOAST_ICONS = {
	success: <CircleCheckIcon className="size-4" />,
	info: <InfoIcon className="size-4" />,
	warning: <TriangleAlertIcon className="size-4" />,
	error: <OctagonXIcon className="size-4" />,
	// Spinner's data-slot exempts it from the global reduced-motion freeze (index.css); a frozen
	// loading toast reads as a hung app.
	loading: <Spinner />
}
