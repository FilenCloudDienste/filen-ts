import { useEffect, useState, type ComponentType } from "react"
import { useTranslation } from "react-i18next"
import { MinusIcon, SquareIcon, CopyIcon, EyeOffIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import {
	deriveSystemStripLayout,
	deriveMaximizeIconState,
	SYSTEM_STRIP_HEIGHT_PX,
	type DesktopPlatform
} from "@/features/shell/lib/systemStrip.logic"

type IconType = ComponentType<{ className?: string }>

// Reads window.desktop exactly once — a real preload script defines it before the page's own
// scripts run, so it can never appear/disappear mid-session (unlike, say, a media-query match).
// AppShell (a sibling consumer that needs the same presence check to grow the canvas gap) calls the
// bare accessor directly instead of this hook; this hook adds the maximized-state subscription only
// this component needs.
function useDesktopBridge(): { platform: DesktopPlatform; maximized: boolean } | undefined {
	const [platform] = useState(() => window.desktop?.platform)
	const [maximized, setMaximized] = useState(false)

	useEffect(() => {
		const bridge = window.desktop

		if (!bridge) {
			return
		}

		return bridge.onMaximizedChange(setMaximized)
	}, [])

	if (platform === undefined) {
		return undefined
	}

	return { platform, maximized }
}

// Shared by every win32/linux control below — full strip height, no rounding (a title-bar control
// reads as part of the frame, not a floating chip), tonal hover per the soft-chrome language. `close`
// gets the destructive hover instead of the neutral one.
function WindowControlButton({
	icon: Icon,
	label,
	onClick,
	destructive
}: {
	icon: IconType
	label: string
	onClick: () => void
	destructive?: boolean
}) {
	return (
		<button
			type="button"
			aria-label={label}
			onClick={onClick}
			className={cn(
				"flex h-full w-11 items-center justify-center text-muted-foreground transition-colors outline-none app-region-no-drag focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:ring-inset [&_svg]:size-4",
				destructive ? "hover:bg-destructive hover:text-primary-foreground" : "hover:bg-rail-hover hover:text-foreground"
			)}
		>
			<Icon />
		</button>
	)
}

// Renders only when window.desktop exists (a plain browser has no bridge, so this returns null and
// AppShell never mounts the strip's height into the layout). darwin gets a bare canvas-toned drag
// strip with a left inset for the native traffic lights; win32/linux add custom window controls
// top-right. The whole strip is a drag region (spec: "responds to drag moving it around"); every
// control opts back out via app-region-no-drag so it stays clickable.
export function SystemStrip() {
	const { t } = useTranslation()
	const desktop = useDesktopBridge()

	if (!desktop) {
		return null
	}

	const layout = deriveSystemStripLayout(desktop.platform)
	const maximizeIcon = deriveMaximizeIconState(desktop.maximized)

	return (
		<div
			className="flex shrink-0 items-stretch bg-canvas app-region-drag"
			style={{ paddingLeft: layout.leftInsetPx, height: SYSTEM_STRIP_HEIGHT_PX }}
		>
			{layout.showWindowControls ? (
				<div className="ml-auto flex items-stretch">
					<WindowControlButton
						icon={MinusIcon}
						label={t("windowMinimize")}
						onClick={() => window.desktop?.minimize()}
					/>
					<WindowControlButton
						icon={maximizeIcon === "maximize" ? SquareIcon : CopyIcon}
						label={t(maximizeIcon === "maximize" ? "windowMaximize" : "windowRestore")}
						onClick={() => window.desktop?.toggleMaximize()}
					/>
					<WindowControlButton
						icon={EyeOffIcon}
						label={t("windowHide")}
						onClick={() => window.desktop?.hide()}
					/>
					<WindowControlButton
						icon={XIcon}
						label={t("windowClose")}
						destructive
						onClick={() => window.desktop?.close()}
					/>
				</div>
			) : null}
		</div>
	)
}
