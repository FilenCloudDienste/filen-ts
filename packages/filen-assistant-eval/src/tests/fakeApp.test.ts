import { describe, expect, it } from "vitest"
import { DIRECTORIES_BY_SIZE_NOTE, LISTING_PAGE_ITEMS, readWithTextFile } from "@filen/shared/assistant"
import { FakeApp } from "../fakeApp"

function ok(result: ReturnType<FakeApp["execute"]>): Record<string, unknown> {
	if (!result.ok) {
		throw new Error(result.error)
	}

	return result.result as Record<string, unknown>
}

describe("FakeApp", () => {
	it("finds items by name tokens, folding plurals", () => {
		const app = new FakeApp()
		const found = ok(
			app.execute({
				name: "search_items",
				args: {
					query: "invoices 2024"
				}
			})
		)["results"] as {
			handle: string
		}[]

		expect(found.map(item => item.handle).sort()).toEqual(["f1", "f2", "f3"])
		expect(app.exposed.has("f1")).toBe(true)
	})

	it("counts what a search left out from the pool its results come from, like the app", () => {
		const search = (query: string) =>
			ok(
				new FakeApp().execute({
					name: "search_items",
					args: {
						query
					}
				})
			) as {
				results: { handle: string }[]
				more?: number
			}

		// One name matches both tokens; the partial matches it outranks are not left-out results.
		expect(search("PDF files").results.map(item => item.handle)).toEqual(["f7"])
		expect(search("PDF files").more).toBeUndefined()
		expect(search("pdf").results).toHaveLength(12)
		expect(search("pdf").more).toBe(2)
	})

	it("refuses handles the conversation has not seen and offers candidates for names", () => {
		const app = new FakeApp()
		const unseen = app.execute({
			name: "read_note",
			args: {
				handle: "n3"
			}
		})
		const named = app.execute({
			name: "read_note",
			args: {
				handle: "Groceries"
			}
		})

		expect(unseen.ok).toBe(false)
		expect(!unseen.ok && unseen.invalid).toBe(true)
		expect(!named.ok && named.candidates).toEqual([
			{
				handle: "n1",
				name: "Groceries"
			}
		])
		expect(app.exposed.has("n1")).toBe(true)
	})

	it("moves items and keeps sibling names unique case-insensitively", () => {
		const app = new FakeApp()

		app.exposed.add("f1").add("d8")

		expect(
			ok(
				app.execute({
					name: "move_items",
					args: {
						handles: ["f1"],
						destination: "d8"
					}
				})
			)
		).toEqual({
			moved: ["Invoice_2024-01_Telekom.pdf"],
			to: "/Archive"
		})

		const clash = app.execute({
			name: "create_directory",
			args: {
				parent: "d0",
				name: "archive"
			}
		})

		expect(clash.ok).toBe(false)
		expect(!clash.ok && clash.invalid).toBe(false)
	})

	it("cannot put a directory inside itself", () => {
		const app = new FakeApp()

		app.exposed.add("d8").add("d9")

		expect(
			app.execute({
				name: "move_items",
				args: {
					handles: ["d8"],
					destination: "d9"
				}
			}).ok
		).toBe(false)
	})

	it("resolves paths given where a handle belongs", () => {
		const app = new FakeApp()

		expect(
			app.resolvePaths({
				destination: "/Archive/",
				handles: ["/Downloads/report_Q3.pdf", "f1"],
				name: "/not/a/handle"
			})
		).toEqual({
			destination: "d8",
			handles: ["f33", "f1"],
			name: "/not/a/handle"
		})
	})

	it("lists a directory by path even when a handle is given too", () => {
		const app = new FakeApp()
		const listing = ok(
			app.execute({
				name: "list_directory",
				args: {
					handle: "d0",
					path: "/Documents/Invoices"
				}
			})
		)

		expect(listing["directory"]).toEqual({
			handle: "d2",
			path: "/Documents/Invoices"
		})
	})

	it("checks a guessed handle beside a directory's path as left out, like the app, and refuses it otherwise", () => {
		const app = new FakeApp()

		expect(app.checkHandles({ tool: "list_directory", args: { handle: "f99", path: "/Documents/Invoices" } })).toBeNull()
		expect(app.checkHandles({ tool: "list_directory", args: { handle: "f99", path: "/Nowhere" } })).toMatchObject({
			ok: false,
			invalid: true
		})
		expect(app.checkHandles({ tool: "list_directory", args: { handle: "f99" } })).toMatchObject({ ok: false, invalid: true })
		expect(app.checkHandles({ tool: "get_item_info", args: { handle: "f99", path: "/Documents" } })).toMatchObject({ ok: false })
	})

	it("plays a playlist from its first track and controls playback", () => {
		const app = new FakeApp()

		app.exposed.add("p3")
		ok(
			app.execute({
				name: "play",
				args: {
					handle: "p3"
				}
			})
		)
		ok(
			app.execute({
				name: "audio_control",
				args: {
					action: "next"
				}
			})
		)

		expect(app.state.context.playing).toMatchObject({
			handle: "f18",
			playlist: "p3"
		})
	})

	it("trashes drive items and notes but never the root", () => {
		const app = new FakeApp()

		app.exposed.add("n15").add("f32")
		ok(
			app.execute({
				name: "trash_items",
				args: {
					handles: ["n15", "f32"]
				}
			})
		)

		expect(app.state.notes.find(note => note.handle === "n15")?.trashed).toBe(true)
		expect(app.state.drive.find(item => item.handle === "f32")?.trashed).toBe(true)
		expect(
			app.execute({
				name: "trash_items",
				args: {
					handles: ["d0"]
				}
			}).ok
		).toBe(false)
	})

	it("trashes nothing when one handle fails, and a repeated handle once", () => {
		const app = new FakeApp()
		const before = structuredClone(app.state)

		app.exposed.add("f32")

		expect(app.execute({ name: "trash_items", args: { handles: ["f32", "d0"] } })).toMatchObject({ ok: false, invalid: false })
		expect(app.state).toEqual(before)
		expect(ok(app.execute({ name: "trash_items", args: { handles: ["f32", "f32"] } }))).toEqual({
			trashed: ["setup_installer.dmg"],
			restorable: true
		})
		expect(app.state.drive.filter(item => item.trashed).map(item => item.handle)).toEqual(
			before.drive.filter(item => item.trashed || item.handle === "f32").map(item => item.handle)
		)
	})

	it("drafts a chat message into the chat's input and opens the chat", () => {
		const app = new FakeApp()

		app.exposed.add("c3")

		expect(ok(app.execute({ name: "draft_chat_message", args: { chat: "c3", text: "Te lo mando hoy." } }))).toMatchObject({
			drafted: true,
			chat: "Carlos Ruiz"
		})
		expect(app.state.draft).toEqual({ chat: "c3", text: "Te lo mando hoy." })
		expect(app.state.context.screen).toBe("chat")
		expect(app.state.opened).toBe("c3")
	})

	it("opens screens, notes, chats and playlists", () => {
		const app = new FakeApp()

		app.exposed.add("n1").add("c1").add("p2")

		expect(ok(app.execute({ name: "open_note", args: { handle: "n1" } }))).toEqual({ opened: "Groceries" })
		expect(app.state.context.screen).toBe("note")
		expect(app.state.opened).toBe("n1")
		expect(ok(app.execute({ name: "open_chat", args: { handle: "c1" } }))).toEqual({ opened: "Anna Schmidt" })
		expect(app.state.context.screen).toBe("chat")
		expect(app.state.opened).toBe("c1")

		const playlist = ok(app.execute({ name: "open_playlist", args: { handle: "p2" } })) as {
			opened: string
			tracks: { handle: string }[]
		}

		expect(playlist.opened).toBe("Chill")
		expect(playlist.tracks.map(track => track.handle)).toEqual(["f17", "f22", "f23"])
		expect(app.state.context.screen).toBe("playlist")
		expect(app.state.opened).toBe("p2")
		expect(ok(app.execute({ name: "open_route", args: { route: "favorites" } }))).toEqual({ opened: "favorites", contentsRead: false })
		expect(app.state.context.screen).toBe("favorites")
		expect(app.state.opened).toBeNull()
	})

	it("reveals an item in its directory, selected", () => {
		const app = new FakeApp()

		app.exposed.add("f33")

		expect(ok(app.execute({ name: "reveal_item", args: { handle: "f33" } }))).toEqual({ shown: "/Downloads/report_Q3.pdf" })
		expect(app.state.context).toMatchObject({ screen: "drive", directory: "d13", selection: ["f33"] })
	})

	it("reads a chat, a text file and a note", () => {
		const app = new FakeApp()

		app.exposed.add("c1").add("f9").add("n3")

		const chat = ok(app.execute({ name: "read_chat", args: { handle: "c1", limit: 2 } })) as {
			chat: string
			messages: { from: string; text: string }[]
		}

		expect(chat.chat).toBe("Anna Schmidt")
		expect(chat.messages.map(message => message.from)).toEqual(["me", "Anna Schmidt"])
		expect(ok(app.execute({ name: "read_text_file", args: { handle: "f9" } }))).toEqual({
			handle: "f9",
			name: "tax_notes_2024.txt",
			content: app.state.drive.find(item => item.handle === "f9")?.content
		})
		expect(ok(app.execute({ name: "read_note", args: { handle: "n3" } }))).toEqual({
			handle: "n3",
			title: "Meeting 2025-10-01",
			content: "Decisions: launch moves to 15 November. Lena owns the pricing page. Next sync on 8 October."
		})
	})

	it("searches only the note text the device holds and returns titles, never the text", () => {
		const app = new FakeApp()

		expect(ok(app.execute({ name: "search_note_text", args: { query: "pricing page" } }))).toEqual({
			searched: "all 15 notes",
			notes: [{ handle: "n3", title: "Meeting 2025-10-01", tokensMatched: 2 }],
			queryTokens: 2
		})
		expect(app.exposed.has("n3")).toBe(true)

		for (const note of app.state.notes.slice(1)) {
			note.textOnDevice = false
		}

		const partial = ok(app.execute({ name: "search_note_text", args: { query: "pricing" } }))

		expect(partial["notes"]).toEqual([])
		expect(partial["searched"]).toContain("only 1 of 15 notes")
		expect(partial["note"]).toContain("list_notes")
		expect(app.execute({ name: "search_note_text", args: { query: "?" } })).toMatchObject({ ok: false, invalid: true })
	})

	it("sends a search for words only in note titles to list_notes", () => {
		const app = new FakeApp()
		const titled = app.state.notes.find(note => note.title.length > 0 && !note.trashed)
		const word = titled?.title
			.split(/\s+/u)
			.find(part => part.length >= 4 && !titled.content.toLowerCase().includes(part.toLowerCase()))

		expect(word).toBeDefined()
		expect(app.execute({ name: "search_note_text", args: { query: word ?? "" } })).toMatchObject({
			ok: false,
			invalid: true,
			error: expect.stringContaining("list_notes") as unknown
		})
	})

	it("keeps one reading tool per file type, each pointing at the other", () => {
		const app = new FakeApp()

		app.exposed.add("f27")
		app.exposed.add("f7")

		expect(app.execute({ name: "read_document", args: { handle: "f27" } })).toMatchObject({
			ok: false,
			invalid: true,
			error: readWithTextFile("roadmap.md")
		})
		expect(app.execute({ name: "read_text_file", args: { handle: "f7" } })).toMatchObject({
			ok: false,
			invalid: true,
			error: expect.stringContaining("read_document") as unknown
		})
	})

	it("lists playlists and describes the context on request", () => {
		const app = new FakeApp()
		const playlists = ok(app.execute({ name: "list_playlists", args: {} }))["playlists"] as { handle: string; tracks: number }[]

		expect(playlists).toContainEqual({ handle: "p3", name: "Road trip", tracks: 4 })
		expect(app.exposed.has("p5")).toBe(true)
		expect(ok(app.execute({ name: "get_context", args: {} }))).toEqual({ context: app.describeContext() })
	})

	it("renames an item, refusing a sibling's name in any case and the root", () => {
		const app = new FakeApp()

		app.exposed.add("f1")

		expect(ok(app.execute({ name: "rename_item", args: { handle: "f1", new_name: "Telekom_Januar.pdf" } }))).toMatchObject({
			renamed: { handle: "f1", name: "Telekom_Januar.pdf" }
		})
		expect(app.state.drive.find(item => item.handle === "f1")?.name).toBe("Telekom_Januar.pdf")
		expect(app.execute({ name: "rename_item", args: { handle: "f1", new_name: "invoice_2024-03_stadtwerke.pdf" } })).toMatchObject({
			ok: false,
			invalid: false
		})
		expect(app.execute({ name: "rename_item", args: { handle: "d0", new_name: "Home" } })).toMatchObject({
			ok: false,
			invalid: false
		})
	})

	it("copies items under a new handle and leaves the source in place", () => {
		const app = new FakeApp()

		app.exposed.add("f1").add("d8")

		const copied = ok(app.execute({ name: "copy_items", args: { handles: ["f1"], destination: "d8" } }))["copied"] as {
			handle: string
			name: string
			path: string
		}[]
		const copy = copied[0]

		expect(copied).toHaveLength(1)
		expect(copy?.handle).not.toBe("f1")
		expect(copy).toMatchObject({ name: "Invoice_2024-01_Telekom.pdf", path: "/Archive/Invoice_2024-01_Telekom.pdf" })
		expect(app.state.drive.find(item => item.handle === copy?.handle)?.parent).toBe("d8")
		expect(app.state.drive.find(item => item.handle === "f1")?.parent).toBe("d2")
		expect(app.exposed.has(copy?.handle ?? "")).toBe(true)
	})

	it("sets and clears favorites", () => {
		const app = new FakeApp()

		app.exposed.add("f1").add("f8")

		expect(ok(app.execute({ name: "set_favorite", args: { handles: ["f1"], favorite: true } }))).toEqual({
			updated: ["Invoice_2024-01_Telekom.pdf"]
		})
		expect(app.state.drive.find(item => item.handle === "f1")?.favorite).toBe(true)
		ok(app.execute({ name: "set_favorite", args: { handles: ["f8"], favorite: false } }))
		expect(app.state.drive.find(item => item.handle === "f8")?.favorite).toBe(false)
	})

	it("creates a directory under its parent and grounds its handle", () => {
		const app = new FakeApp()
		const created = ok(app.execute({ name: "create_directory", args: { parent: "d0", name: "Receipts" } }))["created"] as {
			handle: string
			path: string
		}

		expect(created.path).toBe("/Receipts")
		expect(app.state.drive.find(item => item.handle === created.handle)).toMatchObject({
			kind: "directory",
			name: "Receipts",
			parent: "d0"
		})
		expect(app.exposed.has(created.handle)).toBe(true)
	})

	it("creates a note and grounds its handle", () => {
		const app = new FakeApp()
		const created = ok(
			app.execute({ name: "create_note", args: { title: "Packing list", type: "checklist", content: "[ ] passport" } })
		)["created"] as { handle: string; title: string; type: string }

		expect(created).toMatchObject({ title: "Packing list", type: "checklist" })
		expect(app.state.notes.find(note => note.handle === created.handle)).toMatchObject({
			title: "Packing list",
			type: "checklist",
			content: "[ ] passport",
			trashed: false
		})
		expect(app.exposed.has(created.handle)).toBe(true)
	})

	it("sets each note flag it is given and leaves the others", () => {
		const app = new FakeApp()
		const flags = () => {
			const note = app.state.notes.find(item => item.handle === "n2")

			return { pinned: note?.pinned, favorite: note?.favorite, archived: note?.archived }
		}

		app.exposed.add("n2")

		ok(app.execute({ name: "set_note_flags", args: { handle: "n2", pinned: true } }))
		expect(flags()).toEqual({ pinned: true, favorite: false, archived: false })
		ok(app.execute({ name: "set_note_flags", args: { handle: "n2", favorite: true } }))
		expect(flags()).toEqual({ pinned: true, favorite: true, archived: false })
		expect(ok(app.execute({ name: "set_note_flags", args: { handle: "n2", archived: true, pinned: false } }))).toMatchObject({
			updated: { handle: "n2", archived: true }
		})
		expect(flags()).toEqual({ pinned: false, favorite: true, archived: true })
	})

	it("refuses a note-flag or playlist call that would change nothing, as the web app does", () => {
		const app = new FakeApp()

		app.exposed.add("n2").add("p1").add("f22")

		expect(app.execute({ name: "set_note_flags", args: { handle: "n2", pinned: false } })).toMatchObject({ ok: false, invalid: false })
		expect(app.execute({ name: "add_tracks_to_playlist", args: { playlist: "p1", handles: ["f22"] } })).toMatchObject({
			ok: false,
			invalid: false
		})
	})

	it("adds tracks to a playlist once, counting those already there", () => {
		const app = new FakeApp()

		app.exposed.add("p1").add("f18").add("f16")

		expect(ok(app.execute({ name: "add_tracks_to_playlist", args: { playlist: "p1", handles: ["f18", "f16"] } }))).toEqual({
			added: ["Bohemian Rhapsody.mp3"],
			alreadyThere: 1,
			playlist: "Workout"
		})
		expect(app.state.playlists.find(item => item.handle === "p1")?.tracks).toEqual(["f18", "f22", "f25", "f16"])
	})

	it("describes the context with handles", () => {
		const app = new FakeApp({
			directory: "d2",
			selection: ["f3"]
		})

		expect(app.describeContext()).toBe(
			`screen: drive; current directory: ${JSON.stringify("/Documents/Invoices")} (handle d2); selected: ${JSON.stringify("Invoice_2024-11_Hetzner.pdf")} (handle f3); nothing playing`
		)
		expect([...app.exposed].sort()).toEqual(["d0", "d2", "f3"])
	})
	it("filters by dates resolved in code and says which days it kept", () => {
		const app = new FakeApp()
		const listing = ok(
			app.execute({
				name: "list_directory",
				args: {
					path: "/Downloads",
					period: "this_month"
				}
			})
		) as {
			items: { handle: string; modified: string }[]
			dates: string
		}

		expect(listing.items).toEqual([
			expect.objectContaining({ handle: "f33", modified: "2025-10-01" }),
			expect.objectContaining({ handle: "f36", modified: "2025-10-02" })
		])
		expect(listing.dates).toBe("modified 2025-10-01 to 2025-10-31")

		const explicit = ok(app.execute({ name: "search_items", args: { query: "invoice", from: "2024", to: "2024-06" } })) as {
			results: { handle: string }[]
		}

		expect(explicit.results.map(item => item.handle).sort()).toEqual(["f1", "f2"])
		expect(app.execute({ name: "search_items", args: { query: "invoice", from: "last year" } })).toMatchObject({
			ok: false,
			invalid: true
		})
		expect(app.execute({ name: "search_items", args: { query: " ", period: "this_month" } })).toMatchObject({
			ok: false,
			invalid: true
		})
	})

	it("ranks directories by total size with files, showing what it sorted by and that they are not files", () => {
		const listing = ok(new FakeApp().execute({ name: "list_directory", args: { path: "/Documents", sort: "largest" } })) as {
			items: { handle: string; size?: string }[]
			note?: string
		}

		expect(listing.items.map(item => item.handle)).toEqual(["d3", "f10", "d2", "f8", "f44", "f9"])
		expect(listing.items[0]?.size).toBe("2.3 MiB")
		expect(listing.note).toBe(DIRECTORIES_BY_SIZE_NOTE)
		expect(ok(new FakeApp().execute({ name: "list_directory", args: { path: "/Music", sort: "largest" } }))["note"]).toBeUndefined()

		const root = ok(new FakeApp().execute({ name: "list_directory", args: { path: "/", sort: "largest", kind: "directory" } })) as {
			items: { handle: string }[]
		}

		expect(root.items[0]?.handle).toBe("d4")
	})

	it("lists a long directory a page at a time, like the app", () => {
		const app = new FakeApp()

		for (let index = 0; index < LISTING_PAGE_ITEMS + 5; index++) {
			app.state.drive.push({
				handle: `f${String(200 + index)}`,
				kind: "file",
				name: `Scan_${String(index)}.pdf`,
				parent: "d13",
				size: 1000,
				modified: "2024-01-01T10:00:00Z",
				favorite: false,
				trashed: false,
				shared: false
			})
		}

		const first = ok(app.execute({ name: "list_directory", args: { path: "/Downloads" } })) as { items: unknown[]; more?: number }
		const total = first.items.length + (first.more ?? 0)
		const second = ok(app.execute({ name: "list_directory", args: { path: "/Downloads", offset: LISTING_PAGE_ITEMS } })) as {
			items: unknown[]
			offset?: number
			more?: number
		}

		expect(first.items).toHaveLength(LISTING_PAGE_ITEMS)
		expect(first).toMatchObject({ next: LISTING_PAGE_ITEMS })
		expect(second).toMatchObject({ offset: LISTING_PAGE_ITEMS })
		expect(second.items).toHaveLength(total - LISTING_PAGE_ITEMS)
		expect(second.more).toBeUndefined()
		expect(ok(app.execute({ name: "list_directory", args: { path: "/Downloads", offset: 500 } }))["note"]).toBe(
			`The directory holds only ${String(total)} items.`
		)
	})

	it("names a one-on-one chat once, a group's participants all", () => {
		const chats = ok(new FakeApp().execute({ name: "list_chats", args: {} }))["chats"] as Record<string, unknown>[]

		expect(chats.find(chat => chat["handle"] === "c7")).not.toHaveProperty("participants")
		expect(chats.some(chat => Array.isArray(chat["participants"]))).toBe(true)
	})

	it("filters notes by their edited date before the cut, archived ones included", () => {
		const app = new FakeApp()

		for (let index = 0; index < 45; index++) {
			app.state.notes.push({
				handle: `n${String(100 + index)}`,
				title: `Recent ${String(index)}`,
				type: "text",
				content: "",
				tags: [],
				pinned: false,
				favorite: false,
				archived: false,
				trashed: false,
				edited: "2025-10-07T10:00:00Z"
			})
		}

		const old = app.state.notes.find(note => note.handle === "n2")

		if (old !== undefined) {
			old.archived = true
			old.edited = "2025-03-15T10:00:00Z"
		}

		const all = ok(app.execute({ name: "list_notes", args: {} })) as { notes: { handle: string }[]; more?: number }

		expect(all.notes).toHaveLength(40)
		expect(all.more).toBeGreaterThan(0)
		expect(all.notes.map(note => note.handle)).not.toContain("n2")

		const march = ok(app.execute({ name: "list_notes", args: { period: "custom", from: "2025-03", to: "2025-03" } })) as {
			notes: { handle: string }[]
			dates: string
		}

		expect(march.notes.map(note => note.handle)).toEqual(["n2"])
		expect(march.dates).toBe("edited 2025-03-01 to 2025-03-31")
		expect(app.execute({ name: "list_notes", args: { query: "einkaufsliste", period: "today" } })).toMatchObject({
			result: { notes: [{ handle: "n2" }], note: expect.stringContaining("None of these is dated 2025-10-08") }
		})
	})

	it("lists the trashed notes only when asked for them, like the app", () => {
		const app = new FakeApp()
		const binned = app.state.notes.find(note => note.handle === "n2")

		if (binned !== undefined) {
			binned.trashed = true
		}

		const handles = (args: Record<string, unknown>) =>
			(ok(app.execute({ name: "list_notes", args })) as { notes: { handle: string; trashed?: boolean }[] }).notes

		expect(handles({ only: "trashed" })).toEqual([expect.objectContaining({ handle: "n2", trashed: true })])
		expect(handles({}).map(note => note.handle)).not.toContain("n2")
	})

	it("lists the Photos timeline by the date taken", () => {
		const photos = ok(new FakeApp().execute({ name: "list_photos", args: { period: "custom", from: "2024-05", to: "2024-05" } })) as {
			photos: { handle: string; taken: string }[]
		}

		expect(photos.photos.map(photo => photo.handle)).toEqual(["f13", "f12", "f11"])
	})

	it("lists recent uploads by upload date and notes how far back they reach", () => {
		const recent = ok(new FakeApp().execute({ name: "recent_items", args: { kind: "image" } })) as {
			items: { handle: string; uploaded: string }[]
		}

		expect(recent.items).toEqual([expect.objectContaining({ handle: "f14", uploaded: "2025-10-06" })])

		const lastYear = ok(new FakeApp().execute({ name: "recent_items", args: { period: "last_year" } })) as {
			items: unknown[]
			note?: string
		}

		expect(lastYear.items).toEqual([])
		expect(lastYear.note).toContain("Recents reaches back to uploads of 2025-08-30")
	})

	it("reports directory totals and storage like the app", () => {
		const app = new FakeApp({ directory: "d4" })

		expect(ok(app.execute({ name: "get_item_info", args: { handle: "d4" } }))["size"]).toBe("195.6 MiB in 5 files and 2 directories")
		expect(ok(app.execute({ name: "get_storage", args: {} }))).toEqual({
			used: "3.2 GiB",
			total: "10 GiB",
			free: "6.8 GiB",
			usedPercent: 32,
			versions: "450 MiB"
		})
	})

	it("lists the drive's own lists, with shared items outside My Drive", () => {
		const app = new FakeApp()
		const section = (name: string) =>
			(ok(app.execute({ name: "list_section", args: { section: name } })) as { items: { handle: string }[] }).items.map(
				item => item.handle
			)

		expect(section("favorites")).toEqual(["d5", "f8"])
		expect(section("trash")).toEqual(["d49", "f84", "f45"])
		expect(section("shared_with_me")).toEqual(["d51", "d50", "f83"])
		expect(section("shared_by_me")).toEqual(["d11", "f10"])
		expect(section("public_links")).toEqual(["d5", "f33"])

		// Neither search nor a path reaches into someone else's drive.
		expect(ok(app.execute({ name: "search_items", args: { query: "Lohnsteuerbescheinigung" } }))["results"]).toEqual([])
		expect(app.execute({ name: "list_directory", args: { path: "/Steuerunterlagen 2025" } }).ok).toBe(false)
		expect(ok(app.execute({ name: "list_directory", args: { handle: "d50" } }))["directory"]).toEqual({
			handle: "d50",
			sharedBy: "anna.schmidt@example.com"
		})
	})

	it("reports links and shares, also through a parent directory", () => {
		const app = new FakeApp({ directory: "d11", selection: ["f27"] })

		expect(ok(app.execute({ name: "get_sharing", args: { handle: "f27" } }))).toEqual({
			handle: "f27",
			name: "roadmap.md",
			publicLink: "none",
			sharedWith: [],
			sharedThrough: { directory: "Website relaunch", with: ["lena.hoffmann@example.com", "tom.becker@example.com"] }
		})
		expect(ok(app.execute({ name: "get_sharing", args: { handle: "d11" } }))["sharedWith"]).toEqual([
			"lena.hoffmann@example.com",
			"tom.becker@example.com"
		])
	})

	it("finds contacts with the chat to write them in, and reports it as returned", () => {
		const app = new FakeApp()
		const found = app.execute({ name: "find_contacts", args: { query: "carlos.ruiz@example.com" } })

		expect(found).toEqual({
			ok: true,
			result: { contacts: [{ name: "Carlos Ruiz", email: "carlos.ruiz@example.com", chat: "c3" }] },
			returned: [{ handle: "c3", name: "Carlos Ruiz" }]
		})
		expect(app.exposed.has("c3")).toBe(true)
		expect(ok(app.execute({ name: "find_contacts", args: { query: "Lena" } }))["note"]).toContain("no chat")
	})

	it("matches contacts only on an exact address or every word, so a domain grounds no one's chat", () => {
		const app = new FakeApp()

		for (const query of ["example.com", "carlos@example.com", "Carlos Becker"]) {
			expect(app.execute({ name: "find_contacts", args: { query } })).toEqual({
				ok: true,
				result: { contacts: [], note: "No contact matches. Ask the user for the contact's name or exact email address." },
				returned: []
			})
		}
	})

	it("narrows a drive list by name or by whom an item is shared with, and leaves an owned item's sharing unchecked", () => {
		const app = new FakeApp({ directory: "d11", selection: ["f27"] })

		expect(
			(ok(app.execute({ name: "list_section", args: { section: "trash", query: "bewerbung" } })) as { items: { handle: string }[] })
				.items
		).toMatchObject([{ handle: "f84" }])
		expect(
			(
				ok(app.execute({ name: "list_section", args: { section: "shared_with_me", query: "anna" } })) as {
					items: { handle: string }[]
				}
			).items
		).toMatchObject([{ handle: "d50" }])
		expect(ok(app.execute({ name: "get_item_info", args: { handle: "f27" } }))["sharing"]).toBe(
			"unknown: this tool does not show shares or links"
		)
	})

	it("reports transfers with progress, failures and the item an upload became", () => {
		const transfers = ok(new FakeApp().execute({ name: "get_transfers", args: {} }))

		expect(transfers).toMatchObject({ running: 2, overall: "23%", failed: 1 })
		expect(transfers["transfers"]).toContainEqual({ name: "report_Q3.pdf", handle: "f33", kind: "upload", status: "done" })
	})

	it("names the open document in the context line as the web app does, never its selected text", () => {
		const app = new FakeApp({ screen: "drive", directory: "d3", openDocument: { handle: "f7", page: 2, selection: "Bruttogehalt" } })

		expect(app.describeContext()).toContain(
			`open document: ${JSON.stringify("Arbeitsvertrag_Filen.pdf")} (handle f7), PDF, page 2 of 3, 12 characters selected`
		)
		expect(app.describeContext()).not.toContain("Bruttogehalt")
		expect(app.contextHandles()).toContain("f7")
		expect(new FakeApp({ openDocument: { handle: "f30", sheet: "Gastos" } }).describeContext()).toContain(
			`open document: ${JSON.stringify("presupuesto.xlsx")} (handle f30), spreadsheet, sheet ${JSON.stringify("Gastos")} (2 of 2)`
		)
	})

	it("reads document units by range, sheet and selection", () => {
		const app = new FakeApp({ screen: "drive", directory: "d3", openDocument: { handle: "f7", page: 1, selection: "Probezeit" } })
		const pages = ok(app.execute({ name: "read_document", args: { handle: "f7", from: 2, to: 9 } }))

		expect(pages).toMatchObject({ kind: "pdf", units: 3, range: "pages 2–3 of 3" })
		expect((pages["content"] as { unit: number; label: string }[]).map(unit => unit.label)).toEqual(["page 2", "page 3"])
		expect(ok(app.execute({ name: "read_document", args: { handle: "f7", part: "selection" } }))["content"]).toEqual([
			{ unit: 1, label: "selection", text: "Probezeit" }
		])

		app.exposed.add("f30")

		const sheet = ok(app.execute({ name: "read_document", args: { handle: "f30", sheet: "gastos" } }))

		expect(sheet["range"]).toBe("sheet 2 of 2")
		expect(app.execute({ name: "read_document", args: { handle: "f30", part: "selection" } })).toMatchObject({
			ok: false,
			invalid: true
		})
	})

	it("reads the whole long report within the read cap, so a chunked extraction reaches its last pages", () => {
		const app = new FakeApp({ openDocument: { handle: "f33", page: 1 } })
		const read = ok(app.execute({ name: "read_document", args: { handle: "f33" } }))
		const content = read["content"] as { label: string; text: string }[]

		expect(read["truncated"]).toBeUndefined()
		expect(content).toHaveLength(40)
		expect(content[30]?.text).toContain("2.1%")
	})
})
