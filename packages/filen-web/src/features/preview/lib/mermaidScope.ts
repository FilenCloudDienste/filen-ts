import { createContext } from "react"
import { CardObserver } from "@/features/videos/lib/cardObserver"
import { MermaidHost } from "@/features/preview/lib/mermaidFrame"

// How many of a document's diagrams draw without being asked.
export const MERMAID_AUTO_RENDER_LIMIT = 50

// One viewer's diagrams: their frame host, and one observer telling each diagram when it comes within a screen of the
// viewer's scrolled document (it renders then, not before).
export class MermaidScope {
	public readonly host = new MermaidHost()
	private observer: CardObserver | null = null

	// Calls `listener` once, when `element` first comes near; returns the cancel.
	public whenNear(element: Element, listener: () => void): () => void {
		this.observer ??= new CardObserver({ root: element.closest('[role="document"]'), rootMargin: "100% 0px", threshold: 0 })

		const stop = this.observer.observe(element, near => {
			if (near) {
				stop()
				listener()
			}
		})

		return stop
	}

	public release(): void {
		this.host.release()
		this.observer?.disconnect()
		this.observer = null
	}
}

export const MermaidScopeContext = createContext<MermaidScope | null>(null)
