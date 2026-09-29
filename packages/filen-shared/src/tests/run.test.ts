import { describe, it, expect, vi } from "vitest"
import { run, runEffect, runTimeout, TimeoutError } from "@filen/shared"

describe("run", () => {
	describe("basic functionality", () => {
		it("should return success result when function succeeds", async () => {
			const result = await run(async () => {
				return "success"
			})

			expect(result).toEqual({
				success: true,
				data: "success",
				error: null
			})
		})

		it("should return failure result when function throws", async () => {
			const result = await run(async () => {
				throw new Error("failed")
			})

			expect(result).toEqual({
				success: false,
				data: null,
				error: expect.any(Error)
			})
			expect(result.success === false && (result.error as Error).message).toBe("failed")
		})

		it("should work with synchronous functions", async () => {
			const result = await run(() => {
				return 42
			})

			expect(result.success).toBe(true)
			expect(result.success && result.data).toBe(42)
		})
	})

	describe("defer functionality", () => {
		it("should execute deferred functions in LIFO order", async () => {
			const order: number[] = []

			await run(async defer => {
				defer(() => order.push(1))
				defer(() => order.push(2))
				defer(() => order.push(3))

				return "done"
			})

			expect(order).toEqual([3, 2, 1])
		})

		it("should execute deferred functions even when main function throws", async () => {
			const cleanup = vi.fn()

			await run(async defer => {
				defer(cleanup)

				throw new Error("failed")
			})

			expect(cleanup).toHaveBeenCalledOnce()
		})

		it("should handle async deferred functions", async () => {
			const order: number[] = []

			await run(async defer => {
				defer(async () => {
					await new Promise(resolve => setTimeout(resolve, 10))

					order.push(1)
				})

				defer(async () => {
					await new Promise(resolve => setTimeout(resolve, 5))

					order.push(2)
				})

				return "done"
			})

			expect(order).toEqual([2, 1])
		})

		it("should catch errors in deferred functions", async () => {
			const onError = vi.fn()

			await run(
				async defer => {
					defer(() => {
						throw new Error("cleanup failed")
					})

					return "done"
				},
				{
					onError
				}
			)

			expect(onError).toHaveBeenCalledWith(expect.any(Error))
		})

		it("should continue executing other deferred functions if one fails", async () => {
			const cleanup1 = vi.fn()
			const cleanup2 = vi.fn()

			await run(async defer => {
				defer(() => cleanup1())

				defer(() => {
					throw new Error("middle cleanup failed")
				})

				defer(() => cleanup2())

				return "done"
			})

			expect(cleanup1).toHaveBeenCalled()
			expect(cleanup2).toHaveBeenCalled()
		})
	})

	describe("options", () => {
		it("should call onError when function throws", async () => {
			const onError = vi.fn()
			const error = new Error("test error")

			await run(
				async () => {
					throw error
				},
				{
					onError
				}
			)

			expect(onError).toHaveBeenCalledWith(error)
		})

		it("should throw error when throw option is true", async () => {
			await expect(
				run(
					async () => {
						throw new Error("test error")
					},
					{
						throw: true
					}
				)
			).rejects.toThrow("test error")
		})

		it("should still execute cleanup before throwing", async () => {
			const cleanup = vi.fn()

			await expect(
				run(
					async defer => {
						defer(() => cleanup())

						throw new Error("test error")
					},
					{
						throw: true
					}
				)
			).rejects.toThrow()

			expect(cleanup).toHaveBeenCalled()
		})
	})

	describe("real-world scenarios", () => {
		it("should handle file operations", async () => {
			const file = {
				close: vi.fn()
			}

			const openFile = vi.fn().mockResolvedValue(file)
			const readFile = vi.fn().mockResolvedValue("content")

			const result = await run(async defer => {
				const f = await openFile("test.txt")

				defer(() => f.close())

				const content = await readFile(f)

				return content
			})

			expect(result.success).toBe(true)
			expect(result.success && result.data).toBe("content")
			expect(file.close).toHaveBeenCalled()
		})

		it("should handle database transactions", async () => {
			const connection = {
				close: vi.fn(),
				beginTransaction: vi.fn(),
				commit: vi.fn(),
				rollback: vi.fn()
			}

			const db = {
				connect: vi.fn().mockResolvedValue(connection)
			}

			await run(async defer => {
				const conn = await db.connect()

				defer(() => conn.close())

				await conn.beginTransaction()

				defer(() => conn.rollback())

				await conn.commit()
			})

			expect(connection.rollback).toHaveBeenCalled()
			expect(connection.close).toHaveBeenCalled()
		})
	})
})

describe("runEffect", () => {
	describe("basic functionality", () => {
		it("should return result with cleanup function", () => {
			const result = runEffect(() => {
				return "success"
			})

			expect(result.success).toBe(true)
			expect(result.success && result.data).toBe("success")
			expect(result.cleanup).toBeInstanceOf(Function)
		})

		it("should execute cleanup when called manually", () => {
			const cleanup1 = vi.fn()
			const cleanup2 = vi.fn()

			const result = runEffect(defer => {
				defer(() => cleanup1())
				defer(() => cleanup2())

				return "done"
			})

			expect(cleanup1).not.toHaveBeenCalled()
			expect(cleanup2).not.toHaveBeenCalled()

			result.cleanup()

			expect(cleanup1).toHaveBeenCalled()
			expect(cleanup2).toHaveBeenCalled()
		})

		it("should execute deferred functions in LIFO order", () => {
			const order: number[] = []

			const result = runEffect(defer => {
				defer(() => order.push(1))
				defer(() => order.push(2))
				defer(() => order.push(3))

				return "done"
			})

			result.cleanup()

			expect(order).toEqual([3, 2, 1])
		})
	})

	describe("automatic cleanup", () => {
		it("should automatically cleanup when automaticCleanup is true", () => {
			const cleanup = vi.fn()

			runEffect(
				defer => {
					defer(() => cleanup())

					return "done"
				},
				{
					automaticCleanup: true
				}
			)

			expect(cleanup).toHaveBeenCalled()
		})

		it("should not automatically cleanup when automaticCleanup is false", () => {
			const cleanup = vi.fn()

			runEffect(
				defer => {
					defer(() => cleanup())
					return "done"
				},
				{
					automaticCleanup: false
				}
			)

			expect(cleanup).not.toHaveBeenCalled()
		})
	})

	describe("error handling", () => {
		it("should return error result when function throws", () => {
			const result = runEffect(() => {
				throw new Error("failed")
			})

			expect(result.success).toBe(false)
			expect(result.success === false && (result.error as Error).message).toBe("failed")
		})

		it("should still provide cleanup function on error", () => {
			const cleanup = vi.fn()

			const result = runEffect(defer => {
				defer(() => cleanup())

				throw new Error("failed")
			})

			expect(result.cleanup).toBeInstanceOf(Function)

			result.cleanup()

			expect(cleanup).toHaveBeenCalled()
		})
	})
})

describe("runTimeout", () => {
	describe("basic functionality", () => {
		it("should succeed when function completes before timeout", async () => {
			const result = await runTimeout(async () => {
				await new Promise(resolve => setTimeout(resolve, 10))

				return "success"
			}, 100)

			expect(result.success).toBe(true)
			expect(result.success && result.data).toBe("success")
		})

		it("should timeout when function takes too long", async () => {
			const result = await runTimeout(async () => {
				await new Promise(resolve => setTimeout(resolve, 100))

				return "should not complete"
			}, 20)

			expect(result.success).toBe(false)
			expect(result.success === false && result.error).toBeInstanceOf(TimeoutError)
			expect(result.success === false && (result.error as Error).message).toContain("20ms")
		})

		it("should throw when throw option is true", async () => {
			await expect(
				runTimeout(
					async () => {
						await new Promise(resolve => setTimeout(resolve, 100))

						return "done"
					},
					20,
					{
						throw: true
					}
				)
			).rejects.toThrow(TimeoutError)
		})
	})

	describe("cleanup", () => {
		it("should execute deferred cleanup even on timeout", async () => {
			const cleanup = vi.fn()

			await runTimeout(async defer => {
				defer(() => cleanup())

				await new Promise(resolve => setTimeout(resolve, 100))

				return "done"
			}, 20)

			await new Promise(resolve => setTimeout(resolve, 100))

			expect(cleanup).toHaveBeenCalled()
		})
	})

	describe("error handling", () => {
		it("should call onError on timeout", async () => {
			const onError = vi.fn()

			await runTimeout(
				async () => {
					await new Promise(resolve => setTimeout(resolve, 100))

					return "done"
				},
				20,
				{
					onError
				}
			)

			expect(onError).toHaveBeenCalledWith(expect.any(TimeoutError))
		})

		it("should handle errors from function itself", async () => {
			const result = await runTimeout(async () => {
				throw new Error("function error")
			}, 100)

			expect(result.success).toBe(false)
			expect(result.success === false && (result.error as Error).message).toBe("function error")
		})
	})
})

describe("integration tests", () => {
	it("should nest multiple defer levels", async () => {
		const order: string[] = []

		await run(async defer1 => {
			defer1(() => order.push("outer-1"))

			await run(async defer2 => {
				defer2(() => order.push("inner-1"))
				defer2(() => order.push("inner-2"))
			})

			defer1(() => order.push("outer-2"))
		})

		expect(order).toEqual(["inner-2", "inner-1", "outer-2", "outer-1"])
	})
})

function sleep(ms: number): Promise<void> {
	return new Promise(res => setTimeout(res, ms))
}

describe("run", () => {
	it("returns Success result when fn succeeds", async () => {
		const result = await run(() => 42)

		expect(result.success).toBe(true)
		expect(result.data).toBe(42)
		expect(result.error).toBeNull()
	})

	it("returns Failure result when fn throws", async () => {
		const result = await run(() => {
			throw new Error("oops")
		})

		expect(result.success).toBe(false)
		expect(result.error).toBeInstanceOf(Error)
		expect((result.error as Error).message).toBe("oops")
		expect(result.data).toBeNull()
	})

	it("rethrows when throw option is true", async () => {
		await expect(
			run(
				() => {
					throw new Error("rethrown")
				},
				{ throw: true }
			)
		).rejects.toThrow("rethrown")
	})

	it("calls onError callback when fn throws", async () => {
		const onError = vi.fn()
		await run(
			() => {
				throw new Error("err")
			},
			{ onError }
		)
		expect(onError).toHaveBeenCalledOnce()
	})

	it("runs deferred functions after success", async () => {
		const order: string[] = []

		await run(defer => {
			defer(() => {
				order.push("cleanup")
			})
			order.push("work")
		})

		expect(order).toEqual(["work", "cleanup"])
	})

	it("runs deferred functions after failure", async () => {
		const order: string[] = []

		await run(defer => {
			defer(() => {
				order.push("cleanup")
			})
			throw new Error("fail")
		})

		expect(order).toContain("cleanup")
	})

	it("handles async step functions", async () => {
		const result = await run(async () => {
			await sleep(10)
			return "async result"
		})

		expect(result.success).toBe(true)
		expect(result.data).toBe("async result")
	})
})
