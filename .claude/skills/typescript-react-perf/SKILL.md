---
name: typescript-react-performance
description: CRITICAL: Always use this skill, no matter what task you are working on!
---

# High-Performance TypeScript / React / React Native / Node.js / Bun

Performance is a hard requirement, not a nice-to-have. Every line of code either costs or saves CPU cycles and memory. Write code as if TypeScript is a compiled systems language. No waste. No shortcuts that trade performance for convenience.

---

## Core Philosophy

- **Measure before guessing** — but when writing new code, make choices that are provably faster by default
- **Allocations are expensive** — every object, array, closure, and string you create costs GC time later
- **Hot paths are sacred** — code that runs thousands of times per second must be zero-waste
- **Readable + fast is always achievable** — performance code doesn't have to be ugly

---

## 1. TypeScript Compiler & Runtime Settings

### tsconfig.json

Check the tsconfig.json of the package first, then merge this tsconfig.json with it - tsconfig.json keys/props of the package have higher priority then the provided one below.

```json
{
	"compilerOptions": {
		"target": "ES2022", // or ESNext — never ES5/ES6, wastes transpilation
		"module": "NodeNext", // or Bundler for frontend
		"moduleResolution": "NodeNext",
		"strict": true, // catches bugs at compile time, not runtime
		"noUncheckedIndexedAccess": true,
		"exactOptionalPropertyTypes": true,
		"useDefineForClassFields": true,
		"skipLibCheck": true
	}
}
```

### Bun-specific

- Use `bun` as the runtime — it's significantly faster than Node for I/O-heavy workloads
- Prefer Bun native APIs (`Bun.file()`, `Bun.serve()`, `Bun.password`) over Node compat layer
- Use `bun build` with `--minify` and `--target=bun` for production
- Bun uses JavaScriptCore (JSC), not V8 — some micro-optimizations differ (JSC is faster at property access, V8 at array iteration in some cases)

### Node.js-specific

- Always use `--max-old-space-size` appropriately for the workload
- Use `node --experimental-vm-modules` only when necessary (overhead)
- Prefer native `node:*` imports over npm equivalents: `node:fs`, `node:crypto`, `node:stream`
- Use `node:worker_threads` for CPU-bound work, never block the event loop

---

## 2. V8 / JSC Engine Optimization

The JS engine compiles hot functions to native machine code (JIT). Write code the JIT loves:

### Keep object shapes monomorphic

```typescript
// ❌ Polymorphic — JIT deoptimizes, checks type on every call
function process(obj: { x: number } | { x: string }) {
	return obj.x
}

// ✅ Monomorphic — JIT compiles to direct property access
function processNum(obj: { x: number }) {
	return obj.x
}
function processStr(obj: { x: string }) {
	return obj.x
}
```

### Never change object shapes after creation

```typescript
// ❌ Hidden class changes — destroys JIT optimization
const obj: any = {}
obj.x = 1
obj.y = 2 // new hidden class created

// ✅ Define all properties upfront
const obj = { x: 1, y: 2 }
```

### Avoid `arguments` object and `try/catch` in hot paths

```typescript
// ❌ arguments kills optimization in many engines
function sum() {
	let total = 0
	for (let i = 0; i < arguments.length; i++) total += arguments[i]
	return total
}

// ✅ Explicit params or rest (rest is slightly heavier but typed)
function sum(a: number, b: number, c: number) {
	return a + b + c
}
```

### Use typed arrays for numeric data — always

```typescript
// ❌ Regular arrays for numbers — stores boxed values
const points: number[] = new Array(10000)

// ✅ TypedArrays — no boxing, cache-friendly, SIMD-friendly
const points = new Float64Array(10000)
const ints = new Int32Array(10000)
const bytes = new Uint8Array(10000)
```

### Integer vs float matters

```typescript
// ❌ Mixing floats and ints confuses the JIT
let counter = 0.0
counter++

// ✅ Keep integers as integers — JIT uses Smi (small integer) optimization
let counter = 0
counter++
```

---

## 3. Memory & Allocation

### Pre-allocate, don't grow

```typescript
// ❌ Array grows repeatedly — O(n) reallocations
const results: string[] = []
for (const item of items) results.push(transform(item))

// ✅ Pre-allocate exact size
const results = new Array<string>(items.length)
for (let i = 0; i < items.length; i++) results[i] = transform(items[i])
```

### Object pooling for high-frequency allocations

```typescript
// For objects created/destroyed thousands of times per second
class VectorPool {
	private pool: { x: number; y: number }[] = []

	acquire(): { x: number; y: number } {
		return this.pool.pop() ?? { x: 0, y: 0 }
	}

	release(v: { x: number; y: number }): void {
		v.x = 0
		v.y = 0
		this.pool.push(v)
	}
}
```

### Avoid closures in hot loops — they allocate

```typescript
// ❌ Closure allocated on every iteration
items.forEach((item, i) => {
	results[i] = process(item, context)
})

// ✅ No closure — function reference is stable
function processItem(item: Item, i: number) {
	results[i] = process(item, context)
}
for (let i = 0; i < items.length; i++) processItem(items[i], i)
```

### String concatenation — use arrays + join for loops

```typescript
// ❌ O(n²) — new string allocated every iteration
let html = ""
for (const row of rows) html += `<tr>${row}</tr>`

// ✅ O(n) — single allocation at end
const parts = new Array<string>(rows.length)
for (let i = 0; i < rows.length; i++) parts[i] = `<tr>${rows[i]}</tr>`
const html = parts.join("")
```

### Use `Buffer` / `Uint8Array` for binary, never string

```typescript
// ❌ String for binary data — double memory, encoding overhead
const data: string = fs.readFileSync("file.bin", "utf8")

// ✅ Binary stays binary
const data: Buffer = fs.readFileSync("file.bin")
// or in Bun:
const data = await Bun.file("file.bin").arrayBuffer()
```

---

## 4. Data Structures — Choose Correctly

| Use case                   | Use                           | Never use                     |
| -------------------------- | ----------------------------- | ----------------------------- |
| Key-value, frequent lookup | `Map<K,V>`                    | Plain object for dynamic keys |
| Membership test            | `Set<T>`                      | `Array.includes()`            |
| Ordered unique values      | `Set<T>`                      | sorted array with dedup       |
| Numeric keys, dense        | `Array`                       | `Map<number, V>`              |
| Numeric data, typed        | `Float64Array` / `Int32Array` | `number[]`                    |
| FIFO queue                 | Circular buffer / deque       | `Array.shift()` — O(n)        |
| Priority queue             | Binary heap                   | sorted array                  |
| String → value, static     | `Object.freeze({})` or `Map`  | switch/if chains              |
| LRU cache                  | Map (insertion-ordered)       | custom linked list            |

```typescript
// ❌ Array.includes is O(n)
const valid = ['admin', 'editor', 'viewer']
if (valid.includes(role)) { ... }

// ✅ Set.has is O(1)
const VALID_ROLES = new Set(['admin', 'editor', 'viewer'] as const)
if (VALID_ROLES.has(role)) { ... }
```

---

## 5. Async & Concurrency

### Never serialize work that can be parallel

```typescript
// ❌ Sequential — each waits for previous
const a = await fetchA()
const b = await fetchB()
const c = await fetchC()

// ✅ Parallel — all fire simultaneously
const [a, b, c] = await Promise.all([fetchA(), fetchB(), fetchC()])
```

### Use `Promise.allSettled` when partial failure is acceptable

```typescript
const results = await Promise.allSettled(items.map(fetchItem))
const succeeded = results.filter((r): r is PromiseFulfilledResult<Item> => r.status === "fulfilled").map(r => r.value)
```

### Batch micro-tasks — avoid thousands of individual awaits

```typescript
// ❌ Thousands of round-trips
for (const id of ids) {
	await db.query("SELECT * FROM users WHERE id = ?", [id])
}

// ✅ Single query
await db.query("SELECT * FROM users WHERE id = ANY(?)", [ids])
```

### Use `AsyncGenerator` for streaming large datasets — don't buffer everything

```typescript
async function* streamRows(query: string): AsyncGenerator<Row> {
	const cursor = db.cursor(query)
	for await (const row of cursor) yield row
}

// Consume without loading all rows into memory
for await (const row of streamRows("SELECT * FROM events")) {
	process(row)
}
```

### Worker threads for CPU-bound work

```typescript
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads"

// Never block the event loop with CPU work
if (isMainThread) {
	const worker = new Worker(__filename, { workerData: { input } })
	worker.on("message", result => handleResult(result))
} else {
	const result = heavyComputation(workerData.input)
	parentPort!.postMessage(result)
}
```

---

## 6. React Performance

### Step 0 — Inspect the project before writing any React code

Before applying any React performance pattern, read the project to understand what's actually in use. Never assume or introduce new libraries.

```bash
# Check what state management, data fetching, and UI libraries are installed
cat package.json | grep -E '"dependencies"|"devDependencies"' -A 200 | head -100

# Check for virtualization libraries
grep -r "react-virtual\|react-window\|react-virtualized\|virtua\|tanstack" package.json

# Check for state management
grep -r "zustand\|jotai\|recoil\|redux\|mobx\|valtio\|nanostores" package.json

# Check for data fetching
grep -r "react-query\|tanstack/query\|swr\|apollo\|urql\|trpc" package.json

# See how existing components handle state and memoization
find src -name "*.tsx" | head -5 | xargs grep -l "useState\|useReducer\|memo\|useCallback"
```

**Use what the project already has.** If it uses Zustand, use Zustand. If it has TanStack Query, use it for server state. Don't introduce a second state library. Don't add `@tanstack/react-virtual` if `react-window` is already installed. Match the existing patterns.

---

### Every component re-render is a cost — eliminate unnecessary ones

```typescript
// ✅ Memoize components that receive stable props
const ExpensiveList = memo(({ items }: { items: Item[] }) => {
  return <ul>{items.map(item => <ListItem key={item.id} item={item} />)}</ul>
})

// ✅ Memoize callbacks passed as props — prevents child re-renders
const handleClick = useCallback((id: string) => {
  dispatch({ type: 'SELECT', id })
}, [dispatch])  // dispatch from useReducer is stable

// ✅ Memoize expensive derived values
const sorted = useMemo(
  () => [...items].sort((a, b) => a.name.localeCompare(b.name)),
  [items]
)
```

### Keys must be stable and unique — never use index for dynamic lists

```typescript
// ❌ Index keys cause full re-renders on reorder/insert
items.map((item, i) => <Item key={i} {...item} />)

// ✅ Stable ID
items.map(item => <Item key={item.id} {...item} />)
```

### Virtualize large lists — never render 1000+ DOM nodes

First check which virtualization library the project uses:

```bash
grep -E "react-window|react-virtual|virtua|react-virtualized" package.json
```

Use whichever is already installed. If none exists and you need to add one, prefer `@tanstack/react-virtual` (most actively maintained) — but confirm with the developer first. Never add two virtualization libraries.

```typescript
// Example with @tanstack/react-virtual (adapt to whatever the project uses)
const virtualizer = useVirtualizer({
	count: items.length,
	getScrollElement: () => parentRef.current,
	estimateSize: () => 48,
	overscan: 5
})
```

### Avoid inline object/array creation in JSX — creates new reference every render

```typescript
// ❌ New object every render — breaks memo
<Component style={{ margin: 0 }} options={['a', 'b']} />

// ✅ Stable references
const STYLE = { margin: 0 } as const
const OPTIONS = ['a', 'b'] as const
<Component style={STYLE} options={OPTIONS} />
```

### State — use what the project already uses

```bash
# Always check first
grep -E "zustand|jotai|recoil|redux|mobx|valtio|useState|useReducer" src/**/*.tsx | head -20
```

- **If the project uses Zustand/Jotai/etc.** — use it. Don't mix with local `useState` for shared state.
- **If using plain React state** — prefer `useReducer` over `useState` for complex state (stable dispatch reference, no stale closures)
- **Never** introduce a global state library just for local component state
- **Always** split state by update frequency — one fast-changing value should never cause re-renders in components that only care about slow-changing values

### Server state — use what the project already uses

```bash
grep -E "react-query|@tanstack/query|swr|apollo|urql|trpc" package.json
```

If TanStack Query / SWR / Apollo is already there, **all** server state goes through it — never `useEffect` + `fetch` + `useState` for data fetching in a project that already has a data fetching library. These libraries give you caching, deduplication, background refetch, and loading states for free.

### Lazy-load heavy components

```typescript
const HeavyChart = lazy(() => import('./HeavyChart'))

function Dashboard() {
  return (
    <Suspense fallback={<Spinner />}>
      <HeavyChart />
    </Suspense>
  )
}
```

### Context — never put high-frequency data in a single context

```typescript
// ❌ Every consumer re-renders on ANY context value change
const AppContext = createContext({ user, theme, cart, notifications })

// ✅ Split by update frequency — or use a purpose-built library if the project has one
const UserContext = createContext<User | null>(null) // stable
const CartContext = createContext<CartState>(emptyCart) // changes on add/remove
```

---

## 7. I/O & Network (Node.js / Bun)

### Streaming over buffering — always for large payloads

```typescript
// ❌ Loads entire file into memory
const content = await fs.promises.readFile("huge.json", "utf8")
const data = JSON.parse(content)

// ✅ Stream it
import { createReadStream } from "node:fs"
import { chain } from "stream-chain"
import { parser } from "stream-json"

const pipeline = chain([createReadStream("huge.json"), parser()])
```

### HTTP — use keep-alive, connection pooling

```typescript
import { Agent } from "node:https"

const agent = new Agent({
	keepAlive: true,
	maxSockets: 50,
	maxFreeSockets: 10,
	timeout: 30000
})

// Reuse agent across all requests to same host
fetch(url, { agent } as RequestInit)
```

### Bun.serve — fastest HTTP in the ecosystem

```typescript
Bun.serve({
	port: 3000,
	// Handler must return Response — no framework overhead
	fetch(req: Request): Response | Promise<Response> {
		const url = new URL(req.url)
		if (url.pathname === "/health") return new Response("ok")
		return handleRequest(req, url)
	},
	// Enable for production
	reusePort: true
})
```

### Avoid JSON.parse/stringify on hot paths — use binary protocols

```typescript
// For internal service communication, prefer:
// - MessagePack (msgpack): ~30% smaller, faster than JSON
// - CBOR: binary JSON superset
// - Protobuf: typed, smallest, fastest
import { encode, decode } from "msgpackr"
const packed = encode(data) // Buffer
const unpacked = decode(packed)
```

---

## 8. Patterns to Avoid Universally

```typescript
// ❌ delete operator — changes hidden class, deoptimizes
delete obj.key
// ✅ Set to undefined if needed, or use Map
obj.key = undefined

// ❌ eval, new Function — prevents JIT optimization
eval(code)
// ✅ Never. Find another way.

// ❌ with statement — doesn't exist in strict mode, never use
with (obj) { ... }

// ❌ Array.from on hot path — always allocates new array
Array.from(set).filter(...)
// ✅ Iterate directly
for (const item of set) { if (predicate(item)) results.push(item) }

// ❌ Regex compilation in hot path
function isValid(s: string) { return /^\d+$/.test(s) }  // compiled every call
// ✅ Pre-compile
const DIGITS_RE = /^\d+$/
function isValid(s: string) { return DIGITS_RE.test(s) }

// ❌ try/catch in tight loops — prevents optimization
for (const item of items) {
  try { process(item) } catch { skip(item) }
}
// ✅ Validate before, or extract try/catch to wrapper
function tryProcess(item: Item): boolean {
  try { process(item); return true } catch { return false }
}
for (const item of items) tryProcess(item)

// ❌ Optional chaining in hot paths — adds null checks every call
const x = a?.b?.c?.d
// ✅ Validate shape once at boundary, use confidently inside
```

---

## 9. React Native — Hermes Engine & Expo

React Native runs on **Hermes**, a bytecode-compiled JS engine purpose-built for mobile. It is not V8. It is not JSC. It has different performance characteristics, different limits, and different optimization strategies. Never assume V8 tricks apply 1:1.

### Step 0 — Inspect the project before writing any React Native code

```bash
# Full dependency picture
cat package.json | grep -A 200 '"dependencies"' | head -80

# What animation library is in use?
grep -E "reanimated|react-native-animatable|react-native/Animated|moti|lottie" package.json

# What gesture library?
grep -E "gesture-handler|react-native-gesture" package.json

# What list component pattern is dominant?
grep -rn "FlatList\|FlashList\|SectionList\|VirtualizedList\|ScrollView" src --include="*.tsx" | wc -l

# Is FlashList already used anywhere?
grep -rn "FlashList\|@shopify/flash-list" src --include="*.tsx" | head -5

# What image component?
grep -E "expo-image\|react-native-fast-image\|Image.*react-native" package.json

# What navigation library?
grep -E "expo-router\|react-navigation\|react-native-navigation" package.json

# Is New Architecture enabled?
grep -E "newArchEnabled|fabric|newarch" app.json app.config.ts app.config.js 2>/dev/null

# Current Expo SDK version
grep '"expo"' package.json

# Styling approach?
grep -E "nativewind\|tamagui\|styled-components\|restyle\|gluestack\|unistyles" package.json
```

**Adapt to what exists.** If the project uses `react-native-fast-image`, don't introduce `expo-image`. If animations are done with `moti`, use `moti`. If `FlashList` is not installed and only `FlatList` is used project-wide, optimize the `FlatList` — don't add a new dependency without confirming with the developer. Match the patterns already established in the codebase.

---

### Hermes fundamentals

- Hermes **pre-compiles JS to bytecode** at build time — startup is fast, runtime JIT is limited
- Hermes has **no JIT compiler for most code** (unlike V8/JSC) — it interprets bytecode. Hot path speed comes from writing less code, not JIT warmup
- Hermes **does not optimize polymorphic call sites** the way V8 does — monomorphism matters even more
- Hermes has a **conservative GC** — minimize allocations, especially on the JS thread

### The two threads — never confuse them

```
JS Thread      — all React state, business logic, event handlers
UI Thread      — native rendering, gestures, animations
```

**The JS thread is a bottleneck.** Anything that blocks it drops frames on the UI thread. The goal is to keep the JS thread idle as much as possible during animations and gestures.

### Animations — use what the project uses, but worklets are always better

```bash
# Check what's installed
grep -E "reanimated|moti|lottie|animatable" package.json
```

**If `react-native-reanimated` is installed** (the majority of RN projects):

```typescript
import Animated, {
  useSharedValue, useAnimatedStyle, useAnimatedScrollHandler,
  withSpring, withTiming, interpolate, runOnJS,
} from 'react-native-reanimated'

// ✅ Worklets run on UI thread — zero JS thread cost during animation
const translateX = useSharedValue(0)
const animatedStyle = useAnimatedStyle(() => {
  'worklet'
  return { transform: [{ translateX: translateX.value }] }
})
translateX.value = withSpring(100, { damping: 15, stiffness: 150 })

// ❌ JS-driven Animated.Value — always drops frames during heavy interactions
const bad = new Animated.Value(0)

// ❌ setState inside scroll/gesture handlers — forces JS thread work every frame
onScroll={e => setOffset(e.nativeEvent.contentOffset.y)}
```

**If only `Animated` from react-native core is used** (no reanimated installed): use `useNativeDriver: true` on every animation — this is non-negotiable. Without it, animations run on the JS thread.

```typescript
Animated.timing(value, {
	toValue: 1,
	duration: 300,
	useNativeDriver: true // REQUIRED — moves animation to UI thread
}).start()
```

**If `moti` is installed** — it wraps Reanimated. Use it for simple declarative animations, use raw Reanimated for complex gesture-driven ones.

### Gestures — use what the project uses

```bash
grep -E "gesture-handler|@react-native-community/gesture" package.json
```

**If `react-native-gesture-handler` is installed**, always use it for any interactive element that must respond during scroll or animation. The old `TouchableOpacity` from core runs on the JS thread and causes frame drops during gestures.

**If the project only uses core Touchables**, don't add gesture-handler for a single use case without developer buy-in — but flag it as a performance concern if it's causing drops.

### Lists — match and optimize what the project already uses

```bash
# Understand the existing list patterns first
grep -rn "FlatList\|FlashList\|SectionList\|ScrollView" src --include="*.tsx" | head -20
grep "@shopify/flash-list" package.json
```

**Regardless of which list component is used**, these optimizations apply universally:

```typescript
// ✅ Always: stable keyExtractor returning strings, never index
keyExtractor={item => item.id}

// ✅ Always: memoized renderItem — a new function reference causes every cell to re-render
const renderItem = useCallback(
  ({ item }: { item: Item }) => <ItemRow item={item} />,
  []
)
const ItemRow = memo(({ item }: { item: Item }) => <View>...</View>)

// ❌ Always wrong: ScrollView wrapping many items
// ❌ Always wrong: .map() inside ScrollView for more than ~20 items
```

**If `FlatList`** (check what's already set before adding props):

```typescript
<FlatList
  data={items}
  keyExtractor={item => item.id}
  renderItem={renderItem}
  getItemLayout={(_, index) => ({      // eliminates layout measurement — add if items are fixed height
    length: ITEM_HEIGHT,
    offset: ITEM_HEIGHT * index,
    index,
  })}
  maxToRenderPerBatch={10}
  windowSize={5}
  removeClippedSubviews            // Android — unmounts off-screen views
  initialNumToRender={10}
/>
```

**If `FlashList`** is installed or you're adding it (confirm first):

```typescript
// FlashList recycles cells like RecyclerView — fewer mounts, less memory
<FlashList
  data={items}
  renderItem={renderItem}
  estimatedItemSize={72}       // measure a real item, don't guess
  keyExtractor={item => item.id}
/>
```

### Images — use what the project uses

```bash
grep -E "expo-image|react-native-fast-image|@d11/react-native-fast-image" package.json
```

- **`expo-image`** — prefer if the project is Expo-managed. Has memory+disk cache, blurhash placeholder, priority hints.
- **`react-native-fast-image`** — common in bare RN projects. SDWebImage (iOS) + Glide (Android) under the hood. Very fast.
- **Stock `<Image>` from react-native** — acceptable only if neither of the above is installed and the developer doesn't want to add dependencies. Never load large images through it without explicit size constraints.

Whatever is used: always set explicit `width` and `height`. An image without dimensions causes a layout recalculation on load.

### Styling — check the project approach first

```bash
grep -E "nativewind\|tamagui\|styled-components\|restyle\|gluestack\|unistyles\|StyleSheet" package.json
grep -rn "StyleSheet.create\|style={{" src --include="*.tsx" | wc -l
```

- **`NativeWind`** (Tailwind for RN) — write className strings, NativeWind compiles them. Don't mix with `StyleSheet.create` inline styles.
- **`Tamagui` / `Gluestack` / `Restyle`** — use the library's own styled primitives, not `StyleSheet`.
- **Plain `StyleSheet.create`** — if the project uses it, use it everywhere. Never use raw inline style objects: `style={{ flex: 1 }}` creates a new object every render.

```typescript
// ✅ StyleSheet.create — styles registered natively, referenced by integer ID
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', padding: 16 },
})

// ✅ Dynamic part separated from static
const dynamicStyle = useMemo(() => ({ opacity: isActive ? 1 : 0.5 }), [isActive])
<View style={[styles.container, dynamicStyle]} />

// ❌ Inline objects — new allocation every render, bypasses native style registration
<View style={{ flex: 1, backgroundColor: '#fff', padding: 16 }} />
```

### Hermes-specific patterns — apply in all RN projects regardless of other choices

```typescript
// ❌ Generators — slow bytecode on Hermes
function* generateIds() { yield 1; yield 2 }
// ✅ Plain array or callback
function getIds() { return [1, 2] }

// ❌ Proxy — very slow on Hermes
const tracked = new Proxy(obj, handler)
// ✅ Explicit methods
class Tracked { get(key: string) { ... } set(key: string, val: unknown) { ... } }

// ❌ Spread in hot paths on Hermes — allocates
const merged = { ...defaults, ...overrides }
// ✅ Object.assign for hot paths
const result = Object.assign({} as Config, defaults, overrides)
```

**Hermes bytecode via Expo:**

```json
// app.json — always verify this is set
{ "expo": { "jsEngine": "hermes" } }
```

### Expo-specific — check SDK version and architecture first

```bash
grep '"expo"' package.json          # SDK version
grep "newArchEnabled" app.json app.config.* 2>/dev/null  # New Architecture status
grep -E "expo-router|react-navigation" package.json      # Navigation
```

**New Architecture (Expo SDK 50+):** If not yet enabled and the project is on SDK 50+, suggest enabling `newArchEnabled: true` in `app.json`. This replaces the JS bridge with JSI (synchronous, zero-overhead native calls) and Fabric (concurrent renderer). It's a significant performance improvement but requires all native modules to support it — check compatibility first.

**Navigation lazy loading:** Expo Router (file-based) lazy-loads routes automatically. React Navigation with `@react-navigation/native` requires explicit lazy config per navigator — check if it's configured.

**Prefer native Expo modules over JS polyfills:**

```bash
# What's already installed?
grep -E "expo-crypto|expo-file-system|expo-sqlite|expo-secure-store" package.json
```

When native Expo modules exist for a task (crypto, file I/O, SQLite, secure storage), always use them — they run off the JS thread. Never use a pure-JS implementation when a native one is installed.

**Startup — defer non-critical work:**

```typescript
useEffect(() => {
	// After first paint — not blocking startup
	void initAnalytics()
	void prefetchSecondaryData()
}, [])
```

### Bridge calls — minimize JS↔Native crossing

Every call across the JS/Native bridge has overhead. With New Architecture (JSI) this is largely eliminated, but on Old Architecture it's a real cost:

```typescript
// ❌ Bridge call per item in loop
for (const item of items) {
	NativeModules.Storage.setItem(item.key, item.value)
}
// ✅ Batch into single call
NativeModules.Storage.setItems(items.map(i => [i.key, i.value]))
```

### Memory on mobile — clean up everything

```typescript
// ✅ Always remove event listeners
useEffect(() => {
	const sub = AppState.addEventListener("change", handleAppState)
	return () => sub.remove()
}, [])

// ✅ Cancel async ops on unmount
useEffect(() => {
	let cancelled = false
	fetchData().then(data => {
		if (!cancelled) setData(data)
	})
	return () => {
		cancelled = true
	}
}, [])
```

### Profiling

```typescript
// 1. Performance monitor (dev menu, Shake) — JS FPS + UI FPS in real time
//    UI FPS = 60 (or 120 ProMotion). JS FPS drop = JS thread overloaded.
//    UI FPS drop = render/layout too slow.

// 2. React DevTools Profiler — same as web, attach via Metro

// 3. Why Did You Render — find unnecessary re-renders in dev
//    Check if it's already set up: grep -r "whyDidYouRender" src/

// 4. Flipper (if installed in project) — JS + native profiling, network inspector

// 5. Systrace — Android native profiling
//    adb shell atrace --async_start -a com.yourapp
```

---

## 10. Profiling — Node.js, Bun & React (Web)

Always use actual measurements. Never guess.

### Node.js

```typescript
// Built-in high-res timer
const start = performance.now()
doWork()
console.log(`${performance.now() - start}ms`)

// V8 profiler
node --prof server.js
node --prof-process isolate-*.log > profile.txt

// Heap snapshot
import v8 from 'node:v8'
v8.writeHeapSnapshot()
```

### Bun

```bash
bun --smol script.ts          # reduced memory mode
bun build --analyze bundle.ts # bundle analysis
```

### React

```typescript
// React DevTools Profiler — always check before optimizing
// Enable in development:
import { Profiler } from 'react'

<Profiler id="ExpensiveTree" onRender={(id, phase, duration) => {
  if (duration > 16) console.warn(`${id} took ${duration}ms — over 1 frame budget`)
}}>
  <ExpensiveTree />
</Profiler>
```

---

## 11. Checklist Before Committing Code

- [ ] No unnecessary allocations in hot paths (loops, request handlers, render functions)
- [ ] Typed arrays used for numeric data
- [ ] Correct data structure chosen for the access pattern (Map/Set vs Array)
- [ ] Async work is parallelized where possible
- [ ] No `Array.shift()`, no `Array.includes()` on large arrays
- [ ] Regex pre-compiled at module level
- [ ] React: `memo`, `useCallback`, `useMemo` applied where renders are expensive
- [ ] React: no inline object/array literals passed as stable props
- [ ] Large lists virtualized
- [ ] Streaming used for large I/O
- [ ] No hidden class mutations (no `delete`, no adding properties after creation)
- [ ] CPU-bound work in worker threads, not the event loop
- [ ] RN: animations use Reanimated worklets (`'worklet'`) — not JS-driven `Animated`
- [ ] RN: gestures use `react-native-gesture-handler` — not `TouchableOpacity` for interactive targets
- [ ] RN: lists use `FlashList` or `FlatList` with `getItemLayout` + memoized `renderItem`
- [ ] RN: `StyleSheet.create` used everywhere — no inline style objects
- [ ] RN: images use `expo-image` with `cachePolicy`
- [ ] RN: no generators, no Proxy objects (Hermes penalty)
- [ ] RN: heavy modules lazy-imported, not in main bundle
- [ ] RN: new architecture (`newArchEnabled`) enabled if on Expo SDK 50+
- [ ] RN: all subscriptions and async ops cleaned up on unmount

---

## Golden Rule

> If you wouldn't write it in Rust or Go, question whether you should write it this way in TypeScript.

TypeScript running on a modern JIT is fast — the bottleneck is almost always unnecessary allocation, wrong data structures, or serialized async work. Fix those first, and the code will be fast by default.
