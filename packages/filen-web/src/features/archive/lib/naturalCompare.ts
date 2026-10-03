// Natural, case-insensitive name order without allocating: the shared naturalSort parses every name
// into a module-level cache that is never cleared on web, which would pin an archive's names for the
// page's life. On ASCII it orders exactly as naturalSort: digit runs compare by value, other runs by
// their lowercased code units, a digit sorts before anything else, and a name ending first sorts first.
// A difference involving non-ASCII text goes to the collator, from the start of the run it is in.

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "accent" })

// naturalSort reads a run through parseInt, which rounds past 15 digits; this does too, where it matters.
const EXACT_DIGITS = 15

function isDigit(code: number): boolean {
	return code >= 48 && code <= 57
}

function compareDigitRuns(a: string, aStart: number, aEnd: number, b: string, bStart: number, bEnd: number): number {
	let i = aStart
	let j = bStart

	// Leading zeros carry no value; the last digit stays.
	while (i < aEnd - 1 && a.charCodeAt(i) === 48) {
		i++
	}

	while (j < bEnd - 1 && b.charCodeAt(j) === 48) {
		j++
	}

	const aLength = aEnd - i
	const bLength = bEnd - j

	if (aLength > EXACT_DIGITS && bLength > EXACT_DIGITS) {
		const aValue = parseInt(a.slice(aStart, aEnd), 10)
		const bValue = parseInt(b.slice(bStart, bEnd), 10)

		return aValue === bValue ? 0 : aValue < bValue ? -1 : 1
	}

	if (aLength !== bLength) {
		return aLength < bLength ? -1 : 1
	}

	for (; i < aEnd; i++, j++) {
		const difference = a.charCodeAt(i) - b.charCodeAt(j)

		if (difference !== 0) {
			return difference < 0 ? -1 : 1
		}
	}

	return 0
}

export function compareNames(a: string, b: string): number {
	if (a === b) {
		return 0
	}

	const aLength = a.length
	const bLength = b.length
	let i = 0
	let j = 0
	// Where the current non-digit run began, the same text in both up to i / j.
	let aRun = 0
	let bRun = 0

	while (i < aLength && j < bLength) {
		let ca = a.charCodeAt(i)
		let cb = b.charCodeAt(j)
		const aDigit = isDigit(ca)
		const bDigit = isDigit(cb)

		if (aDigit && bDigit) {
			let aEnd = i + 1
			let bEnd = j + 1

			while (aEnd < aLength && isDigit(a.charCodeAt(aEnd))) {
				aEnd++
			}

			while (bEnd < bLength && isDigit(b.charCodeAt(bEnd))) {
				bEnd++
			}

			const order = compareDigitRuns(a, i, aEnd, b, j, bEnd)

			if (order !== 0) {
				return order
			}

			i = aRun = aEnd
			j = bRun = bEnd

			continue
		}

		if (aDigit !== bDigit) {
			return aDigit ? -1 : 1
		}

		if (ca !== cb) {
			if (ca >= 128 || cb >= 128) {
				return collator.compare(a.slice(aRun), b.slice(bRun))
			}

			if (ca >= 65 && ca <= 90) {
				ca += 32
			}

			if (cb >= 65 && cb <= 90) {
				cb += 32
			}

			if (ca !== cb) {
				return ca < cb ? -1 : 1
			}
		}

		i++
		j++
	}

	const aLeft = aLength - i
	const bLeft = bLength - j

	return aLeft === bLeft ? 0 : aLeft < bLeft ? -1 : 1
}
