// Page containers (.fo-docx-pages) sized as a browser with classic scrollbars sizes them, for DOM tests (happy-dom
// lays nothing out): `width` x `height`, less a vertical scrollbar of `scrollbar` once the content (the
// container's first child) is taller than `height`. Returns the function that puts the platform's sizes back.

type SizeKey = "clientWidth" | "clientHeight"

function platformGetter(key: SizeKey): (this: HTMLElement) => number {
	for (let proto: object | null = HTMLElement.prototype; proto !== null; proto = Object.getPrototypeOf(proto)) {
		const getter = Object.getOwnPropertyDescriptor(proto, key)?.get

		if (getter !== undefined)
			return function (this: HTMLElement) {
				return Number(Reflect.apply(getter, this, []))
			}
	}

	return () => 0
}

export function classicScrollbars(size: { width: number; height: number; scrollbar: number }): () => void {
	const proto = HTMLElement.prototype
	const own = new Map<SizeKey, PropertyDescriptor | undefined>()

	for (const key of ["clientWidth", "clientHeight"] as const) {
		const platform = platformGetter(key)

		own.set(key, Object.getOwnPropertyDescriptor(proto, key))
		Object.defineProperty(proto, key, {
			configurable: true,
			get(this: HTMLElement): number {
				if (!this.classList.contains("fo-docx-pages")) return platform.call(this)
				if (key === "clientHeight") return size.height

				const content = this.firstElementChild
				const tall = content instanceof HTMLElement && Number.parseFloat(content.style.height) > size.height

				return tall ? size.width - size.scrollbar : size.width
			}
		})
	}

	return () => {
		for (const [key, descriptor] of own) {
			if (descriptor === undefined) Reflect.deleteProperty(proto, key)
			else Object.defineProperty(proto, key, descriptor)
		}
	}
}
