import { type Mock } from "vitest"
import { type Note } from "@/types"

// The replace/patch helpers call notesQueryUpdate inside their own module, so a test that mocks that
// module routes them through its notesQueryUpdate spy with these.
export function notesQueryWriters(update: Mock) {
	return {
		notesQueryReplace: (note: Note) => {
			update({
				updater: (prev: Note[]) => prev.map(n => (n.uuid === note.uuid ? note : n))
			})
		},
		notesQueryPatch: (uuid: string, patch: (live: Note) => Partial<Note>) => {
			update({
				updater: (prev: Note[]) =>
					prev.map(n =>
						n.uuid === uuid
							? {
									...n,
									...patch(n)
								}
							: n
					)
			})
		}
	}
}
