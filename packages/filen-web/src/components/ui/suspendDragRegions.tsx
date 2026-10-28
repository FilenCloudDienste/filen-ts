import { useEffect } from "react"
import { desktopBridge } from "@/lib/desktop"

// A desktop window's drag regions swallow the press that would close a non-modal popup: the OS takes it as a
// window drag, so the page never sees it. Modal popups mark the page inert, which index.css keys off; a popover
// doesn't, so while one is mounted (its portal renders only then) `<html>` carries data-popover-open instead.
let mounted = 0

export function SuspendDragRegions(): null {
	useEffect(() => {
		if (desktopBridge() === undefined) {
			return
		}

		const root = document.documentElement

		mounted++
		root.setAttribute("data-popover-open", "")

		return () => {
			mounted--

			if (mounted === 0) {
				root.removeAttribute("data-popover-open")
			}
		}
	}, [])

	return null
}
