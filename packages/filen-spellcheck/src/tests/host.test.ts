import { describe, expect, it } from "vitest"
import { SpellcheckHost, type SpellcheckHostOptions } from "../host"
import { fakeOrigin, inThreadWorker, tinyAssets, type InThreadWorker } from "./fixtures"

function setup(options: Partial<SpellcheckHostOptions> = {}) {
	const origin = fakeOrigin()
	const workers: InThreadWorker[] = []
	const host = new SpellcheckHost({
		assets: tinyAssets(origin),
		createWorker: () => {
			const worker = inThreadWorker({ fetch: origin.fetch, caches: undefined })

			workers.push(worker)

			return worker
		},
		...options
	})

	return { host, workers, origin }
}

const checks = (worker: InThreadWorker | undefined) => worker?.received.filter(message => message.type === "check") ?? []
const suggests = (worker: InThreadWorker | undefined) => worker?.received.filter(message => message.type === "suggest") ?? []

// Yields macrotasks until `condition` holds.
async function until(condition: () => boolean): Promise<void> {
	for (let round = 0; round < 1000 && !condition(); round++) await new Promise(resolve => setTimeout(resolve, 0))

	if (!condition()) throw new Error("condition not reached")
}

describe("SpellcheckHost", () => {
	it("maps languages to the dictionaries it has", () => {
		const { host } = setup()

		expect(host.dictionaryFor("en-US")).toBe("en_US")
		expect(host.dictionaryFor("de-AT")).toBeUndefined()
		expect(host.dictionaryFor("de-DE")).toBe("de_DE")
		expect(host.dictionaryFor("x-none")).toBeUndefined()
		host.dispose()
	})

	it("checks unknown words once and answers from its cache", async () => {
		const { host, workers } = setup()

		expect(host.known("en_US", "hello")).toBeUndefined()

		await Promise.all([host.check("en_US", ["hello", "helo", "hello", "worlds"]), host.check("en_US", ["helo", "café"])])

		expect(host.known("en_US", "hello")).toBe(true)
		expect(host.known("en_US", "helo")).toBe(false)
		expect(host.known("en_US", "café")).toBe(true)
		expect(workers).toHaveLength(1)

		const sent = checks(workers[0])

		expect(
			sent
				.map(message => (message.type === "check" ? message.words.split("\n") : []))
				.flat()
				.sort()
		).toEqual(["café", "hello", "helo", "worlds"])

		await host.check("en_US", ["hello", "helo"])
		expect(checks(workers[0])).toHaveLength(sent.length)
		host.dispose()
	})

	it("treats overlong words as correct without asking", async () => {
		const { host, workers } = setup()

		await host.check("en_US", ["x".repeat(101), ""])
		expect(host.known("en_US", "x".repeat(101))).toBe(true)
		expect(workers).toHaveLength(0)
		host.dispose()
	})

	it("treats words with a separator as correct without asking, and never takes them as the user's", async () => {
		const { host, workers } = setup()
		let changes = 0

		host.subscribe(() => changes++)
		await host.check("en_US", ["he\nllo"])
		expect(host.known("en_US", "he\nllo")).toBe(true)
		expect(await host.suggest("en_US", "a\nb")).toEqual([])
		host.setUserWords(["a\nb"])
		expect(changes).toBe(0)
		expect(host.userWords.size).toBe(0)
		expect(workers).toHaveLength(0)
		host.dispose()
	})

	it("keeps dictionaries apart", async () => {
		const { host } = setup()

		await Promise.all([host.check("en_US", ["Haus", "hello"]), host.check("de_DE", ["Haus", "hello"])])
		expect([host.known("en_US", "Haus"), host.known("en_US", "hello")]).toEqual([false, true])
		expect([host.known("de_DE", "Haus"), host.known("de_DE", "hello")]).toEqual([true, false])
		host.dispose()
	})

	it("rejects checks for a dictionary that fails to load, backs off doubling up to a cap, and starts over after a load", async () => {
		let time = 0
		const { host, origin, workers } = setup({ now: () => time })
		const dic = [...origin.files.keys()].find(url => url.endsWith("/de.dic.gz")) ?? ""
		const file = origin.files.get(dic)

		if (file === undefined) throw new Error("fixture")

		const loads = () => workers.flatMap(worker => worker.received).filter(message => message.type === "load").length

		origin.files.delete(dic)
		await expect(host.check("de_DE", ["Haus"])).rejects.toThrow(/404/)
		expect(loads()).toBe(1)

		// Within each back-off nothing is fetched again; it starts at 15 s and doubles per failure up to 5 min.
		for (const [index, delay] of [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000].entries()) {
			time += delay - 1
			await expect(host.check("de_DE", ["Haus"])).rejects.toThrow(/404/)
			expect(loads()).toBe(index + 1)

			time += 1
			await expect(host.check("de_DE", ["Haus"])).rejects.toThrow(/404/)
			expect(loads()).toBe(index + 2)
		}

		origin.files.set(dic, file)
		time += 300_000
		await host.check("de_DE", ["Haus"])
		expect(host.known("de_DE", "Haus")).toBe(true)
		expect(loads()).toBe(9)

		// A load forgets the failures: the next one backs off 15 s again.
		host.open()()
		origin.files.delete(dic)
		await expect(host.check("de_DE", ["Haus"])).rejects.toThrow(/404/)
		expect(loads()).toBe(10)

		origin.files.set(dic, file)
		time += 14_999
		await expect(host.check("de_DE", ["Haus"])).rejects.toThrow(/404/)
		expect(loads()).toBe(10)

		time += 1
		await host.check("de_DE", ["Haus"])
		expect(host.known("de_DE", "Haus")).toBe(true)
		expect(loads()).toBe(11)
		host.dispose()
	})

	it("suggests in a separate worker and caches the answer", async () => {
		const { host, workers } = setup()

		await host.check("en_US", ["helo"])

		const suggestions = await host.suggest("en_US", "helo")

		expect(suggestions).toContain("hello")
		expect(workers).toHaveLength(2)
		expect(await host.suggest("en_US", "helo")).toBe(suggestions)
		expect(workers[1]?.received.filter(message => message.type === "suggest")).toHaveLength(1)
		host.dispose()
	})

	it("abandons a slow suggestion request for a newer one", async () => {
		const { host, workers } = setup()
		const slow = host.suggest("en_US", "wrold", { more: true })
		const fast = host.suggest("en_US", "helo")

		await expect(slow).rejects.toMatchObject({ name: "AbortError" })
		expect(await fast).toContain("hello")
		expect(workers[0]?.terminated).toBe(true)

		// An abandoned request is not remembered: asking again asks the worker.
		expect(suggests(workers[1])).toHaveLength(1)
		expect(Array.isArray(await host.suggest("en_US", "wrold", { more: true }))).toBe(true)
		expect(suggests(workers[1])).toHaveLength(2)
		host.dispose()
	})

	it("answers [] when a suggestion request overruns, and remembers that", async () => {
		const { host, workers } = setup({ suggestTimeoutMs: 0 })

		expect(await host.suggest("en_US", "helo", { more: true })).toEqual([])
		expect(workers[0]?.terminated).toBe(true)

		// The same request would overrun again: no new worker, no new request.
		expect(await host.suggest("en_US", "helo", { more: true })).toEqual([])
		expect(workers).toHaveLength(1)
		host.dispose()
	})

	it("stops on an abort signal", async () => {
		const { host, workers } = setup()
		const controller = new AbortController()

		controller.abort()
		await expect(host.suggest("en_US", "helo", { signal: controller.signal })).rejects.toThrow()

		const running = new AbortController()
		const request = host.suggest("en_US", "wrold", { more: true, signal: running.signal })

		running.abort()
		await expect(request).rejects.toMatchObject({ name: "AbortError" })

		// An aborted request is not remembered.
		const sent = workers.flatMap(worker => suggests(worker)).length

		expect(Array.isArray(await host.suggest("en_US", "wrold", { more: true }))).toBe(true)
		expect(workers.flatMap(worker => suggests(worker)).length).toBe(sent + 1)
		host.dispose()
	})

	it("applies the user's words: additions in place, removals by restarting", async () => {
		const { host, workers } = setup()
		let changes = 0

		host.subscribe(() => changes++)
		await host.check("en_US", ["zorp", "hello"])
		expect(host.known("en_US", "zorp")).toBe(false)

		host.setUserWords(["zorp"])
		expect(changes).toBe(1)
		expect(host.known("en_US", "zorp")).toBeUndefined()
		expect(host.known("en_US", "hello")).toBe(true)

		await host.check("en_US", ["zorp", "Zorp"])
		expect([host.known("en_US", "zorp"), host.known("en_US", "Zorp")]).toEqual([true, true])
		expect(workers).toHaveLength(1)

		host.setUserWords(["zorp"])
		expect(changes).toBe(1)

		host.setUserWords([])
		expect(changes).toBe(2)
		expect(workers[0]?.terminated).toBe(true)
		expect(host.known("en_US", "hello")).toBeUndefined()

		await host.check("en_US", ["zorp"])
		expect(host.known("en_US", "zorp")).toBe(false)
		expect(workers).toHaveLength(2)
		host.dispose()
	})

	it("checks again a word added while its check was waited on", async () => {
		const { host } = setup()
		let recheck: Promise<void> | undefined

		host.subscribe(() => {
			recheck = host.check("en_US", ["zorp", "helo"])
		})

		const first = host.check("en_US", ["zorp", "helo"])

		host.setUserWords(["zorp"])
		await Promise.all([first, recheck])
		expect(host.known("en_US", "zorp")).toBe(true)
		expect(host.known("en_US", "helo")).toBe(false)
		host.dispose()
	})

	it("does not cache an answer computed before the user's words changed", async () => {
		const { host, workers } = setup()

		await host.check("en_US", ["hello"])

		const pending = host.check("en_US", ["zorp"])

		// The check is on its way to the worker, ahead of the addition.
		await until(() => checks(workers[0]).some(message => message.type === "check" && message.words === "zorp"))
		host.setUserWords(["zorp"])
		await pending
		expect(host.known("en_US", "zorp")).toBeUndefined()

		await host.check("en_US", ["zorp"])
		expect(host.known("en_US", "zorp")).toBe(true)
		expect(checks(workers[0])).toHaveLength(3)
		host.dispose()
	})

	it("rejects what a crashed worker had pending and starts a new one", async () => {
		const { host, workers } = setup()

		await host.check("en_US", ["hello"])

		const pending = host.check("en_US", ["helo"])

		await until(() => checks(workers[0]).length === 2)
		workers[0]?.crash()
		await expect(pending).rejects.toThrow(/worker failed/)
		expect(workers[0]?.terminated).toBe(true)

		// Not a load failure: no back-off.
		await host.check("en_US", ["helo"])
		expect(host.known("en_US", "helo")).toBe(false)
		expect(workers).toHaveLength(2)
		host.dispose()
	})

	it("backs off a dictionary whose worker crashed while loading it", async () => {
		let time = 0
		const { host, workers } = setup({ now: () => time })
		const pending = host.check("en_US", ["helo"])

		workers[0]?.crash()
		await expect(pending).rejects.toThrow(/worker failed/)
		await expect(host.check("en_US", ["helo"])).rejects.toThrow(/worker failed/)
		expect(workers).toHaveLength(1)

		time += 15_000
		await host.check("en_US", ["helo"])
		expect(host.known("en_US", "helo")).toBe(false)
		expect(workers).toHaveLength(2)
		host.dispose()
	})

	it("ends an idle worker and starts a new one on demand", async () => {
		const { host, workers } = setup({ checkIdleMs: 5 })

		await host.check("en_US", ["hello"])
		await new Promise(resolve => setTimeout(resolve, 30))
		expect(workers[0]?.terminated).toBe(true)

		await host.check("en_US", ["helo"])
		expect(host.known("en_US", "helo")).toBe(false)
		expect(workers).toHaveLength(2)
		host.dispose()
	})

	it("ends its workers and drops its caches once the last open document closes", async () => {
		const { host, workers } = setup()
		const first = host.open()
		const second = host.open()

		await host.check("en_US", ["hello", "helo"])
		await host.suggest("en_US", "helo")
		first()
		first()
		expect(workers.map(worker => worker.terminated)).toEqual([false, false])
		expect(host.known("en_US", "helo")).toBe(false)

		second()
		expect(workers.map(worker => worker.terminated)).toEqual([true, true])
		expect(host.known("en_US", "helo")).toBeUndefined()

		// The next document starts afresh.
		const third = host.open()

		await host.check("en_US", ["helo"])
		expect(host.known("en_US", "helo")).toBe(false)
		expect(workers).toHaveLength(3)
		third()
		host.dispose()
	})
})
