# macOS Focused-Window AX Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the macOS Taobao helper snapshot and act inside the current focused or main window with explicit node, depth, duration, and encoded-size limits, so a large application-wide accessibility tree cannot trigger uncontrolled `TREE_LIMIT_REACHED` failures.

**Architecture:** Resolve a fresh scoped window root for every snapshot or action, preserving node paths relative to that window. Keep traversal and encoding limits in pure Swift value types with injectable time, return sanitized structured diagnostics on failure, and expose those diagnostics to the TypeScript helper client without retrying a semantic tree-limit response as a transport error.

**Tech Stack:** Swift 6, AppKit/ApplicationServices AX API, XCTest, TypeScript, Node.js test runner.

## Global Constraints

- Prefer `AXFocusedWindow`; fall back to `AXMainWindow`; never serialize the whole application element as a snapshot fallback.
- Resolve a fresh current-window root for every snapshot, `perform`, `setValue`, and clipboard-copy action.
- Snapshot node paths are relative to the returned window root and action resolution uses the same root convention.
- Defaults are exactly 4,000 nodes, depth 28, 6 seconds, and 8 MiB encoded JSON.
- Reaching any limit returns `TREE_LIMIT_REACHED`; never return a partial tree as success.
- Limit diagnostics may contain only scope, limit reason, visited-node count, maximum depth, elapsed milliseconds, and encoded byte count.
- Login and platform challenge behavior remains unchanged; this repair must not bypass either state.
- Do not add AX attributes to the semantic snapshot allowlist merely to resolve a window root.
- Do not access a real Taobao account in automated tests.
- Use test-driven development: observe each new regression test fail before production edits.

---

### Task 1: Resolve Every Operation Against a Fresh Window Root

**Files:**
- Modify: `apps/collector-macos/Sources/TaobaoAX/AXTreeSerializer.swift`
- Modify: `apps/collector-macos/Sources/TaobaoAX/AccessibilityApplication.swift`
- Modify: `apps/collector-macos/Tests/TaobaoAXTests/AXNodeTests.swift`
- Create: `apps/collector-macos/Tests/TaobaoAXTests/AccessibilityApplicationTests.swift`

**Interfaces:**
- Produces: `AXElementReading.referencedElement(for attribute: String) throws -> (any AXElementReading)?`.
- Produces: `AXRootScope` with `.focusedWindow` and `.mainWindow`.
- Produces: `AXScopedRoot { element: any AXElementReading, scope: AXRootScope }`.
- Produces: `AXScopedRootResolver.resolve(applicationRoot:) throws -> AXScopedRoot`.
- Consumes: `AXAttribute.focusedWindow` and `AXAttribute.mainWindow`, which are lookup-only and are not members of `AXAttribute.allowed`.

- [ ] **Step 1: Add failing focused-window resolver tests**

Create `AccessibilityApplicationTests.swift` with these cases:

```swift
import XCTest
@testable import TaobaoAX

final class AccessibilityApplicationTests: XCTestCase {
    func testScopedRootPrefersFocusedWindow() throws {
        let focused = ReferencedTestAXElement(title: "Focused")
        let main = ReferencedTestAXElement(title: "Main")
        let application = ReferencedTestAXElement(references: [
            AXAttribute.focusedWindow: focused,
            AXAttribute.mainWindow: main,
        ])

        let result = try AXScopedRootResolver().resolve(applicationRoot: application)

        XCTAssertTrue(result.element.isSameElement(as: focused))
        XCTAssertEqual(result.scope, .focusedWindow)
    }

    func testScopedRootFallsBackToMainWindow() throws {
        let main = ReferencedTestAXElement(title: "Main")
        let application = ReferencedTestAXElement(references: [AXAttribute.mainWindow: main])

        let result = try AXScopedRootResolver().resolve(applicationRoot: application)

        XCTAssertTrue(result.element.isSameElement(as: main))
        XCTAssertEqual(result.scope, .mainWindow)
    }

    func testScopedRootNeverFallsBackToApplicationTree() {
        let application = ReferencedTestAXElement()

        XCTAssertThrowsError(try AXScopedRootResolver().resolve(applicationRoot: application)) { error in
            XCTAssertEqual((error as? HelperError)?.code, "FRONT_WINDOW_NOT_AVAILABLE")
        }
    }
}
```

Define `ReferencedTestAXElement` in the same test file as a minimal `AXElementReading` fake. Its `referencedElement(for:)` reads the supplied dictionary; all semantic reads return empty values.

- [ ] **Step 2: Extend the existing serializer fake for the new protocol requirement**

Add this method to the private `TestAXElement` in `AXNodeTests.swift`:

```swift
func referencedElement(for attribute: String) throws -> (any AXElementReading)? {
    nil
}
```

Run the Swift tests before changing production code:

```bash
swift test --package-path apps/collector-macos
```

Expected: compilation fails because `referencedElement`, `AXScopedRootResolver`, and the window constants do not exist.

- [ ] **Step 3: Add lookup-only window constants and the resolver types**

In `AXTreeSerializer.swift`, add constants without adding them to `allowed`:

```swift
enum AXAttribute {
    static let focusedWindow = "AXFocusedWindow"
    static let mainWindow = "AXMainWindow"
    // Existing semantic attributes and allowed list remain unchanged.
}

enum AXRootScope: String, Codable, Equatable {
    case focusedWindow
    case mainWindow
}

struct AXScopedRoot {
    let element: any AXElementReading
    let scope: AXRootScope
}

struct AXScopedRootResolver {
    func resolve(applicationRoot: any AXElementReading) throws -> AXScopedRoot {
        if let focused = try applicationRoot.referencedElement(for: AXAttribute.focusedWindow) {
            return AXScopedRoot(element: focused, scope: .focusedWindow)
        }
        if let main = try applicationRoot.referencedElement(for: AXAttribute.mainWindow) {
            return AXScopedRoot(element: main, scope: .mainWindow)
        }
        throw HelperError(
            code: "FRONT_WINDOW_NOT_AVAILABLE",
            message: "A focused or main application window is required."
        )
    }
}
```

Add the method to `AXElementReading`:

```swift
func referencedElement(for attribute: String) throws -> (any AXElementReading)?
```

- [ ] **Step 4: Implement referenced AX element reads for live elements**

In `LiveAXElement`, copy the requested attribute and only accept an AX element value:

```swift
func referencedElement(for attribute: String) throws -> (any AXElementReading)? {
    var copiedValue: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &copiedValue)
    if result == .noValue || result == .attributeUnsupported { return nil }
    guard result == .success else { throw mappedReadError(result) }
    guard let copiedValue, CFGetTypeID(copiedValue) == AXUIElementGetTypeID() else { return nil }
    return LiveAXElement(element: copiedValue as! AXUIElement)
}
```

Do not route these lookup attributes through `value(for:)`; window references must never enter serialized semantic values.

- [ ] **Step 5: Scope `AccessibilityApplication` snapshots and actions**

Replace the application-wide `freshRoot()` with:

```swift
private func freshRoot() throws -> (element: LiveAXElement, scope: AXRootScope) {
    guard AXIsProcessTrusted() else {
        throw HelperError(
            code: "ACCESSIBILITY_PERMISSION_REQUIRED",
            message: "Accessibility permission is required."
        )
    }
    guard let application = runningApplication() else {
        throw HelperError(code: "APP_NOT_RUNNING", message: "Application is not running.")
    }
    let applicationRoot = LiveAXElement(
        element: AXUIElementCreateApplication(application.processIdentifier)
    )
    let scoped = try AXScopedRootResolver().resolve(applicationRoot: applicationRoot)
    guard let element = scoped.element as? LiveAXElement else {
        throw HelperError(code: "ACCESSIBILITY_READ_FAILED", message: "Window root is invalid.")
    }
    return (element, scoped.scope)
}
```

Use `freshRoot().element` in `resolve`, `keyPress`, and clipboard capture. Use the tuple in `snapshot` so Task 2 can pass the root scope to limit diagnostics. Update `diagnose` to report `frontWindowAvailable` only when the resolver finds a focused or main window.

- [ ] **Step 6: Run the scoped-root tests**

Run:

```bash
swift test --package-path apps/collector-macos
```

Expected: all Swift tests pass, and `Set(root.requestedAttributes)` in the existing allowlist test still equals only `AXAttribute.allowed`.

- [ ] **Step 7: Commit Task 1**

```bash
git add apps/collector-macos/Sources/TaobaoAX/AXTreeSerializer.swift apps/collector-macos/Sources/TaobaoAX/AccessibilityApplication.swift apps/collector-macos/Tests/TaobaoAXTests/AXNodeTests.swift apps/collector-macos/Tests/TaobaoAXTests/AccessibilityApplicationTests.swift
git commit -m "fix: scope macOS AX operations to current window"
```

---

### Task 2: Enforce Node, Depth, Duration, and Encoded-Size Limits

**Files:**
- Modify: `apps/collector-macos/Sources/TaobaoAX/Protocol.swift`
- Modify: `apps/collector-macos/Sources/TaobaoAX/AXTreeSerializer.swift`
- Modify: `apps/collector-macos/Sources/TaobaoAX/AccessibilityApplication.swift`
- Modify: `apps/collector-macos/Tests/TaobaoAXTests/ProtocolTests.swift`
- Modify: `apps/collector-macos/Tests/TaobaoAXTests/AXNodeTests.swift`

**Interfaces:**
- Produces: `AXTreeLimits.standard` with `maxNodeCount=4_000`, `maxDepth=28`, `maxDurationNanoseconds=6_000_000_000`, and `maxEncodedBytes=8 * 1_024 * 1_024`.
- Produces: `AXTreeSerialization { node, visitedNodeCount, maximumDepth, elapsedMilliseconds }`.
- Produces: `AXTreeSerializer.serialize(root:scope:) throws -> AXTreeSerialization`.
- Produces: `AXSnapshotEncoder.encode(_ serialization:scope:limits:) throws -> JSONValue`.
- Extends: `HelperError.details: JSONValue?`, defaulting to `nil` for every existing call site.

- [ ] **Step 1: Add failing protocol tests for optional error diagnostics**

In `ProtocolTests.swift`, add:

```swift
func testHelperErrorEncodesSanitizedTreeLimitDetails() throws {
    let error = HelperError(
        code: "TREE_LIMIT_REACHED",
        message: "Accessibility tree limit reached.",
        details: .object([
            "reason": .string("nodeCount"),
            "scope": .string("focusedWindow"),
            "visitedNodeCount": .number(4_001),
        ])
    )

    let decoded = try JSONDecoder().decode(
        HelperError.self,
        from: JSONEncoder().encode(error)
    )

    XCTAssertEqual(decoded, error)
}
```

Also assert an ordinary `HelperError(code:message:)` round-trips with `details == nil`.

- [ ] **Step 2: Add failing serializer tests for every limit**

Update existing tests to read `.node`, then add deterministic duration and byte tests:

```swift
func testDurationLimitFailsWithoutReturningAPartialTree() {
    var clockReads = 0
    let serializer = AXTreeSerializer(
        limits: AXTreeLimits(
            maxNodeCount: 10,
            maxDepth: 5,
            maxDurationNanoseconds: 6_000_000_000,
            maxEncodedBytes: 8 * 1_024 * 1_024
        ),
        nowNanoseconds: {
            defer { clockReads += 1 }
            return clockReads < 2 ? 0 : 7_000_000_000
        }
    )

    assertTreeLimit(
        try serializer.serialize(
            root: TestAXElement(children: [TestAXElement()]),
            scope: .focusedWindow
        ),
        reason: "duration"
    )
}

func testEncodedSizeLimitFailsWithoutReturningPayload() throws {
    let serialization = AXTreeSerialization(
        node: AXNode(
            path: [],
            role: "AXWindow",
            subrole: nil,
            identifier: nil,
            title: String(repeating: "x", count: 500),
            description: nil,
            value: nil,
            url: nil,
            enabled: true,
            selected: nil,
            position: nil,
            size: nil,
            actions: [],
            children: []
        ),
        visitedNodeCount: 1,
        maximumDepth: 0,
        elapsedMilliseconds: 1
    )
    let limits = AXTreeLimits(
        maxNodeCount: 10,
        maxDepth: 5,
        maxDurationNanoseconds: 6_000_000_000,
        maxEncodedBytes: 32
    )

    assertTreeLimit(
        try AXSnapshotEncoder().encode(serialization, scope: .mainWindow, limits: limits),
        reason: "encodedBytes"
    )
}
```

Change `assertTreeLimit` to inspect `HelperError.details["reason"]` in addition to the code.

- [ ] **Step 3: Run Swift tests and verify the new contracts fail**

Run:

```bash
swift test --package-path apps/collector-macos
```

Expected: compilation fails because the new limits, serialization result, encoder, and error details do not exist.

- [ ] **Step 4: Add backward-compatible optional `HelperError.details`**

Replace the synthesized memberwise-only shape with an explicit initializer:

```swift
struct HelperError: Codable, Equatable, Error {
    let code: String
    let message: String
    let details: JSONValue?

    init(code: String, message: String, details: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.details = details
    }
}
```

Existing call sites remain source-compatible and encode `details` only as an optional field.

- [ ] **Step 5: Implement the central limit values and traversal result**

Add these value types in `AXTreeSerializer.swift`:

```swift
struct AXTreeLimits: Equatable {
    static let standard = AXTreeLimits(
        maxNodeCount: 4_000,
        maxDepth: 28,
        maxDurationNanoseconds: 6_000_000_000,
        maxEncodedBytes: 8 * 1_024 * 1_024
    )

    let maxNodeCount: Int
    let maxDepth: Int
    let maxDurationNanoseconds: UInt64
    let maxEncodedBytes: Int
}

struct AXTreeSerialization: Equatable {
    let node: AXNode
    let visitedNodeCount: Int
    let maximumDepth: Int
    let elapsedMilliseconds: Int
}
```

Give `AXTreeSerializer` a `limits` value and injectable monotonic `nowNanoseconds`, defaulting to `DispatchTime.now().uptimeNanoseconds`. Check duration before reading each node, track maximum depth, and return `AXTreeSerialization` only after a complete traversal.

- [ ] **Step 6: Return structured limit errors**

Use one helper for node, depth, duration, and encoded-size failures:

```swift
func axTreeLimitError(
    reason: String,
    scope: AXRootScope,
    visitedNodeCount: Int,
    maximumDepth: Int,
    elapsedMilliseconds: Int,
    encodedBytes: Int? = nil
) -> HelperError {
    var details: [String: JSONValue] = [
        "reason": .string(reason),
        "scope": .string(scope.rawValue),
        "visitedNodeCount": .number(Double(visitedNodeCount)),
        "maximumDepth": .number(Double(maximumDepth)),
        "elapsedMilliseconds": .number(Double(elapsedMilliseconds)),
    ]
    if let encodedBytes { details["encodedBytes"] = .number(Double(encodedBytes)) }
    return HelperError(
        code: "TREE_LIMIT_REACHED",
        message: "Accessibility tree limit reached.",
        details: .object(details)
    )
}
```

Use the exact reason strings `nodeCount`, `depth`, `duration`, and `encodedBytes`. Invalid non-positive limits fail with the relevant reason before traversal.

- [ ] **Step 7: Enforce the encoded-size limit before decoding to `JSONValue`**

Implement:

```swift
struct AXSnapshotEncoder {
    func encode(
        _ serialization: AXTreeSerialization,
        scope: AXRootScope,
        limits: AXTreeLimits
    ) throws -> JSONValue {
        let data = try JSONEncoder().encode(serialization.node)
        guard data.count <= limits.maxEncodedBytes else {
            throw axTreeLimitError(
                reason: "encodedBytes",
                scope: scope,
                visitedNodeCount: serialization.visitedNodeCount,
                maximumDepth: serialization.maximumDepth,
                elapsedMilliseconds: serialization.elapsedMilliseconds,
                encodedBytes: data.count
            )
        }
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }
}
```

Wire `AccessibilityApplication.snapshot()` to serialize and encode the fresh scoped root. Remove the old generic private encoder if it has no remaining caller.

- [ ] **Step 8: Run Swift tests and verify all four limits**

Run:

```bash
swift test --package-path apps/collector-macos
```

Expected: all tests pass, including node count, depth, duration, encoded size, cycle handling, and semantic allowlist coverage.

- [ ] **Step 9: Commit Task 2**

```bash
git add apps/collector-macos/Sources/TaobaoAX/Protocol.swift apps/collector-macos/Sources/TaobaoAX/AXTreeSerializer.swift apps/collector-macos/Sources/TaobaoAX/AccessibilityApplication.swift apps/collector-macos/Tests/TaobaoAXTests/ProtocolTests.swift apps/collector-macos/Tests/TaobaoAXTests/AXNodeTests.swift
git commit -m "fix: bound macOS AX window snapshots"
```

---

### Task 3: Preserve Tree-Limit Diagnostics in the TypeScript Client

**Files:**
- Modify: `apps/collector/src/drivers/macos/ax-helper-client.ts`
- Modify: `apps/collector/src/drivers/macos/ax-helper-client.spec.ts`
- Modify: `docs/operations/macos-collector.md`

**Interfaces:**
- Produces: `AxHelperErrorDetails` with the six allowlisted diagnostic fields.
- Extends: `AxHelperResponseError.details: AxHelperErrorDetails | null`.
- Guarantees: helper semantic errors, including `TREE_LIMIT_REACHED`, do not restart the helper process.

- [ ] **Step 1: Add a failing helper response test**

In `ax-helper-client.spec.ts`, make the fake helper return:

```ts
process.stdout.write(`${JSON.stringify({
  id: request.id,
  ok: false,
  error: {
    code: "TREE_LIMIT_REACHED",
    message: "Accessibility tree limit reached.",
    details: {
      reason: "nodeCount",
      scope: "focusedWindow",
      visitedNodeCount: 4001,
      maximumDepth: 18,
      elapsedMilliseconds: 420,
      encodedBytes: 0,
      unexpected: "must-not-propagate"
    }
  }
})}\n`);
```

Assert:

```ts
await assert.rejects(client.snapshot(), (error: unknown) => {
  assert.equal(error instanceof AxHelperResponseError, true);
  const response = error as AxHelperResponseError;
  assert.equal(response.code, "TREE_LIMIT_REACHED");
  assert.deepEqual(response.details, {
    reason: "nodeCount",
    scope: "focusedWindow",
    visitedNodeCount: 4001,
    maximumDepth: 18,
    elapsedMilliseconds: 420,
    encodedBytes: 0
  });
  return true;
});
assert.equal(spawns, 1);
```

- [ ] **Step 2: Run the focused test and verify details are lost**

Run:

```bash
node --test apps/collector/src/drivers/macos/ax-helper-client.spec.ts
```

Expected: the new assertion fails because `AxHelperResponseError` has no `details` property.

- [ ] **Step 3: Parse only allowlisted diagnostics**

Add:

```ts
export interface AxHelperErrorDetails {
  reason?: string;
  scope?: string;
  visitedNodeCount?: number;
  maximumDepth?: number;
  elapsedMilliseconds?: number;
  encodedBytes?: number;
}
```

Implement `sanitizeErrorDetails(value: unknown): AxHelperErrorDetails | null` that copies only those keys, accepts finite non-negative numbers, truncates `reason` and `scope` to 80 safe alphanumeric characters, and ignores all other fields. Pass the sanitized value into the `AxHelperResponseError` constructor.

- [ ] **Step 4: Document the scoped snapshot recovery rule**

In `docs/operations/macos-collector.md`, document:

```text
TREE_LIMIT_REACHED now identifies one of nodeCount, depth, duration, or encodedBytes.
The helper reads only AXFocusedWindow or AXMainWindow. Operators should bring the intended
Taobao window to the front and retry once; repeated failures indicate a UI contract change
and must not be worked around by removing limits.
```

Also state that snapshot paths are window-relative and stale paths are rejected by fingerprint validation.

- [ ] **Step 5: Run portable and Swift verification**

Run:

```bash
node --test apps/collector/src/drivers/macos/ax-helper-client.spec.ts
pnpm test:collector
pnpm typecheck
swift test --package-path apps/collector-macos
git diff --check
```

Expected: all commands pass and the TypeScript client reports sanitized details without a helper restart.

- [ ] **Step 6: Commit Task 3**

```bash
git add apps/collector/src/drivers/macos/ax-helper-client.ts apps/collector/src/drivers/macos/ax-helper-client.spec.ts docs/operations/macos-collector.md
git commit -m "feat: expose bounded AX snapshot diagnostics"
```

---

## Live Acceptance Gate

Run this only with the user present, Taobao Desktop already logged in, and no real WeCom sender enabled.

- [ ] Build the helper:

```bash
swift build --package-path apps/collector-macos
```

- [ ] Bring the intended Taobao search window to the front and send one `diagnose` command through the helper JSON-line protocol. Confirm `frontWindowAvailable=true`.

- [ ] Send one `snapshot` command. Confirm the response has `ok=true`, the root role is `AXWindow`, root path is `[]`, and no sensitive credential text appears.

- [ ] Repeat after switching between search results and one product detail. Confirm each snapshot succeeds and paths remain relative to the current window.

- [ ] Run the collector diagnostic without starting a collection:

```bash
pnpm collector:diagnose
```

Expected: Taobao Desktop version and permissions are healthy, and no `TREE_LIMIT_REACHED` response is produced for the focused search or detail window.

- [ ] If a limit still triggers, record only the sanitized `reason`, `scope`, node count, depth, elapsed milliseconds, and encoded bytes. Do not raise or remove the limits during acceptance.
