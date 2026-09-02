# Taobao Native Search Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Taobao Desktop live searches replace the real web-input value through native Unicode events and submit reliably without clipboard access or an ineffective search-button accessibility action.

**Architecture:** Add a testable Swift native-input unit that activates only the supported Taobao process, validates and selects the exact live search field, and posts Unicode text events. Expose that behavior through two narrow JSON-line helper commands, then make the TypeScript live driver call `activate`, `replaceText`, verify a fresh snapshot, and send Return while preserving the synthetic `setValue` plus `AXConfirm` path and all existing stability gates.

**Tech Stack:** Swift 5.7, macOS Accessibility API, CoreGraphics keyboard events, TypeScript, Node.js 22 test runner, pnpm workspace, Taobao Desktop 2.4.5 build 15.

## Global Constraints

- Support only bundle ID `com.taobao.pcdesktop`, Taobao Desktop version `2.4.5`, build `15`.
- `activate` must confirm that the exact supported Taobao process becomes frontmost within two seconds.
- `replaceText` must target one enabled, editable `AXTextField` whose `AXDescription` is exactly `请输入搜索文字`.
- Treat the field as editable only when `AXValue`, `AXFocused`, and `AXSelectedTextRange` are all reported settable; this check must happen before focus, selection, or text events.
- Accept replacement text only when it remains non-empty after whitespace normalization and is at most 2,048 UTF-16 code units.
- Do not read, write, archive, or restore the system clipboard.
- Do not fall back to coordinate typing, URL injection, browser automation, or an unverified button action.
- Do not send text events unless Taobao is confirmed frontmost immediately before posting.
- Verify the replacement value from a fresh snapshot before sending Return key code `36`.
- Require the existing three stable result observations after submission.
- Live search must not call `setValue` or perform `AXPress` on the `搜索` button.
- Synthetic fixtures retain `setValue` followed by semantic `AXConfirm`.
- Preserve every existing login, challenge, rank, duplicate, sponsored-result, item-identity, SKU, screenshot, and transition-timeout safeguard.
- Do not change APIs, database schema, scheduling, report shape, Enterprise WeChat behavior, or repricing behavior.
- Do not print query values, URLs, `.env` data, tokens, cookies, clipboard contents, or other secrets in helper diagnostics.
- Do not create or retry a collection run during this plan. A new supervised pilot requires separate user authorization after all verification passes.

---

## File Map

- Create `apps/collector-macos/Sources/TaobaoAX/NativeTextInput.swift`: bounded Taobao activation, exact field validation, full-text selection, and native Unicode event posting behind injectable interfaces.
- Create `apps/collector-macos/Tests/TaobaoAXTests/NativeTextInputTests.swift`: deterministic activation and text replacement tests with no real UI events.
- Modify `apps/collector-macos/Sources/TaobaoAX/AccessibilityApplication.swift`: inject the native units and expose `activate()` and `replaceText(path:value:fingerprint:)` application operations.
- Modify `apps/collector-macos/Sources/TaobaoAX/Protocol.swift`: add the two command names.
- Modify `apps/collector-macos/Tests/TaobaoAXTests/ProtocolTests.swift`: prove valid decoding, required fields, sanitized output, and handler routing.
- Modify `apps/collector/src/drivers/macos/ax-helper-client.ts`: add TypeScript command names.
- Modify `apps/collector/src/drivers/macos/ax-helper-client.spec.ts`: prove command serialization and safe non-frontmost error mapping.
- Modify `apps/collector/src/drivers/macos/taobao-mac-driver.ts`: branch live and synthetic write/submit flows while preserving result stability.
- Modify `apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts`: require activation, native replacement, verification, and Return for live search.
- Modify `apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts`: retain synthetic `setValue` plus `AXConfirm` after activation.
- Modify `apps/collector/src/drivers/macos/taobao-live-selectors.ts` and its spec: remove the invalid live submit-button selector and only its dedicated tests.
- Modify `apps/collector/src/drivers/macos/taobao-selectors.ts` and its spec: expose an explicitly synthetic `findSyntheticSearchConfirmAction` contract.

---

### Task 1: Add Testable Native Activation And Text Replacement

**Files:**
- Create: `apps/collector-macos/Sources/TaobaoAX/NativeTextInput.swift`
- Create: `apps/collector-macos/Tests/TaobaoAXTests/NativeTextInputTests.swift`
- Modify: `apps/collector-macos/Sources/TaobaoAX/AccessibilityApplication.swift`

**Interfaces:**
- Produces: `ApplicationActivator.activate(processIdentifier:timeout:) throws`.
- Produces: `SearchTextFieldEditing`, implemented by `LiveAXElement`.
- Produces: `UnicodeTextPosting.post(text:to:) throws`, implemented by `CGUnicodeTextPoster`.
- Produces: `NativeSearchTextInput.replace(field:processIdentifier:value:isFrontmost:) throws`.
- Produces: `AccessibilityApplication.activate() throws -> JSONValue`.
- Produces: `AccessibilityApplication.replaceText(path:value:fingerprint:) throws -> JSONValue`.

- [ ] **Step 1: Write deterministic failing tests for bounded activation**

Add tests using injected closures rather than a real application:

```swift
func testActivationWaitsForTheExactProcessAndReturnsNoSensitivePayload() throws {
    var frontmost: pid_t? = nil
    var activationRequests: [pid_t] = []
    var ticks = 0
    let activator = ApplicationActivator(
        requestActivation: { pid in activationRequests.append(pid); return true },
        frontmostProcessIdentifier: { frontmost },
        now: { TimeInterval(ticks) * 0.05 },
        sleep: { _ in ticks += 1; if ticks == 2 { frontmost = 321 } }
    )

    try activator.activate(processIdentifier: 321, timeout: 2)

    XCTAssertEqual(activationRequests, [321])
}

func testActivationFailsClosedAfterTwoSeconds() {
    var now: TimeInterval = 0
    let activator = ApplicationActivator(
        requestActivation: { _ in true },
        frontmostProcessIdentifier: { 999 },
        now: { now },
        sleep: { interval in now += interval }
    )

    XCTAssertThrowsError(try activator.activate(processIdentifier: 321, timeout: 2)) { error in
        XCTAssertEqual((error as? HelperError)?.code, "APP_ACTIVATION_FAILED")
    }
}
```

- [ ] **Step 2: Write failing tests for exact field validation and Unicode posting**

Use `TestSearchTextField` and `RecordingUnicodeTextPoster` test doubles:

```swift
func testReplacementSelectsAllUtf16TextAndPostsUnicodeToTaobao() throws {
    let field = TestSearchTextField(
        role: "AXTextField",
        description: "请输入搜索文字",
        enabled: true,
        value: "旧查询"
    )
    let poster = RecordingUnicodeTextPoster()
    let input = NativeSearchTextInput(poster: poster)

    try input.replace(
        field: field,
        processIdentifier: 321,
        value: "RME Babyface Pro FS",
        isFrontmost: { true }
    )

    XCTAssertEqual(field.focusRequests, 1)
    XCTAssertEqual(field.selectedRanges, [CFRange(location: 0, length: 3)])
    XCTAssertEqual(poster.posts, [.init(pid: 321, text: "RME Babyface Pro FS")])
}
```

Add table-driven failures for wrong role, wrong description, disabled field,
non-editable field (each of `AXValue`, `AXFocused`, and
`AXSelectedTextRange` not settable), empty value, 2,049 UTF-16 code units,
whitespace-only value, focus failure, selection failure, and
`isFrontmost == false`. Add a throwing poster case and require
`TEXT_EVENT_FAILED`. Assert no poster call in every pre-post failure case.
Include a Chinese value such as `声卡 直播` to prove Unicode preservation and
an emoji boundary case to prove the limit counts UTF-16 code units rather than
Swift graphemes.

- [ ] **Step 3: Run the focused Swift tests and verify RED**

Run:

```bash
swift test --package-path apps/collector-macos --filter NativeTextInputTests
```

Expected: compilation fails because `ApplicationActivator`,
`NativeSearchTextInput`, and their protocols do not exist. A toolchain or
permission failure is not an acceptable RED result.

- [ ] **Step 4: Implement the native units without clipboard access**

Create these boundaries in `NativeTextInput.swift`:

```swift
protocol SearchTextFieldEditing: AnyObject {
    func value(for attribute: String) throws -> Any?
    func isAttributeSettable(_ attribute: String) throws -> Bool
    func setFocused() throws
    func selectText(range: CFRange) throws
}

protocol UnicodeTextPosting {
    func post(text: String, to processIdentifier: pid_t) throws
}

struct ApplicationActivator {
    let requestActivation: (pid_t) -> Bool
    let frontmostProcessIdentifier: () -> pid_t?
    let now: () -> TimeInterval
    let sleep: (TimeInterval) -> Void

    func activate(processIdentifier: pid_t, timeout: TimeInterval = 2) throws
}

struct NativeSearchTextInput {
    let poster: any UnicodeTextPosting

    func replace(
        field: any SearchTextFieldEditing,
        processIdentifier: pid_t,
        value: String,
        isFrontmost: () -> Bool
    ) throws
}
```

`ApplicationActivator` must request activation once, poll at 50 milliseconds,
and throw `APP_ACTIVATION_FAILED` unless the exact PID becomes frontmost before
the deadline. Its live defaults must call
`NSRunningApplication(processIdentifier:)?.activate(options:
[.activateIgnoringOtherApps])` and read
`NSWorkspace.shared.frontmostApplication?.processIdentifier`; they must never
activate a process discovered by name, title, or coordinates.

`NativeSearchTextInput` must read and validate `AXRole`, `AXDescription`,
`AXEnabled`, and the existing string `AXValue`; require `AXValue`, `AXFocused`,
and `AXSelectedTextRange` to be settable; validate `1...2_048` UTF-16 code
units and reject a value whose whitespace-normalized form is empty; call
`setFocused()`; select `CFRange(location: 0,
length: existing.utf16.count)`; recheck `isFrontmost`; and call the poster. Map
wrong, disabled, non-editable, or stale targets to `INVALID_TEXT_TARGET`; map
selection/focus errors to `TEXT_SELECTION_FAILED`, and event creation/posting
errors to `TEXT_EVENT_FAILED`.

`CGUnicodeTextPoster` must create a HID event source, create key-down and key-up
events, apply the complete UTF-16 buffer with
`CGEventKeyboardSetUnicodeString`, and use `postToPid`. It must not import or
call `NSPasteboard`.

Extend `LiveAXElement` to set `kAXFocusedAttribute` and
`kAXSelectedTextRangeAttribute`, and expose
`AXUIElementIsAttributeSettable` through `isAttributeSettable`. Map
unsupported/stale elements to the safe errors above.

- [ ] **Step 5: Expose application methods with redacted payloads**

Inject default `ApplicationActivator` and `NativeSearchTextInput` instances
through `AccessibilityApplication.init`. Add:

```swift
func activate() throws -> JSONValue {
    let pid = try runningProcessIdentifier()
    try applicationActivator.activate(processIdentifier: pid, timeout: 2)
    return .object(["activated": .boolean(true)])
}

func replaceText(path: [Int], value: String, fingerprint: AXNodeFingerprint) throws -> JSONValue {
    let pid = try runningProcessIdentifier()
    let field = try resolve(path: path, fingerprint: fingerprint)
    try nativeSearchTextInput.replace(
        field: field,
        processIdentifier: pid,
        value: value,
        isFrontmost: { NSWorkspace.shared.frontmostApplication?.processIdentifier == pid }
    )
    return .object(["typed": .boolean(true)])
}
```

Neither payload may contain the PID, path, old value, or replacement value.

- [ ] **Step 6: Run the complete Swift suite and verify GREEN**

Run:

```bash
swift test --package-path apps/collector-macos
```

Expected: every Swift test passes and no test touches the real clipboard or
posts a real event.

- [ ] **Step 7: Commit the native unit**

```bash
git add apps/collector-macos/Sources/TaobaoAX/NativeTextInput.swift apps/collector-macos/Sources/TaobaoAX/AccessibilityApplication.swift apps/collector-macos/Tests/TaobaoAXTests/NativeTextInputTests.swift
git commit -m "feat: add native Taobao text input"
```

---

### Task 2: Expose The Native Commands Through Both Helper Clients

**Files:**
- Modify: `apps/collector-macos/Sources/TaobaoAX/Protocol.swift`
- Modify: `apps/collector-macos/Sources/TaobaoAX/AccessibilityApplication.swift`
- Modify: `apps/collector-macos/Tests/TaobaoAXTests/ProtocolTests.swift`
- Modify: `apps/collector/src/drivers/macos/ax-helper-client.ts`
- Modify: `apps/collector/src/drivers/macos/ax-helper-client.spec.ts`

**Interfaces:**
- Consumes: `AccessibilityApplication.activate()` and
  `AccessibilityApplication.replaceText(path:value:fingerprint:)` from Task 1.
- Produces: Swift `CommandName.activate` and `CommandName.replaceText`.
- Produces: TypeScript `AxHelperCommandName` members `"activate"` and
  `"replaceText"`.
- Preserves: the existing `AxHelperCommandFields` shape; `replaceText` uses
  `nodePath`, `fingerprint`, and `value`.

- [ ] **Step 1: Write failing Swift protocol tests**

Add decoding tests:

```swift
func testActivateCommandDecodesWithoutMutationFields() throws {
    let command = try decoder.decode(HelperCommand.self, from: Data(
        #"{"id":"activate-1","command":"activate","bundleId":"com.taobao.pcdesktop"}"#.utf8
    ))
    XCTAssertEqual(command.command, .activate)
    XCTAssertNil(command.nodePath)
    XCTAssertNil(command.value)
}

func testReplaceTextCommandPreservesUnicodeInput() throws {
    let command = try decoder.decode(HelperCommand.self, from: Data(
        #"{"id":"replace-1","command":"replaceText","bundleId":"com.taobao.pcdesktop","nodePath":[0,1],"value":"声卡 直播","fingerprint":{"role":"AXTextField"}}"#.utf8
    ))
    XCTAssertEqual(command.command, .replaceText)
    XCTAssertEqual(command.value, "声卡 直播")
}
```

Add handler tests proving `replaceText` without any one of `nodePath`, `value`,
or `fingerprint`, or with an empty fingerprint object, returns
`INVALID_REQUEST`. Also prove that a success response contains `typed` but not
the submitted query. Route those handler tests through an injected
`CommandHandling`/application spy that returns only `{ "typed": true }`; they
must not resolve a real Taobao process or post real keyboard events.

- [ ] **Step 2: Write failing TypeScript client tests**

Send each new command through `AxHelperClient` and inspect the JSON line written
to `FakeProcess.stdin`:

```typescript
const activation = client.command("activate");
const replacement = client.command("replaceText", {
  nodePath: [0, 1],
  value: "声卡 直播",
  fingerprint: { role: "AXTextField" }
});
```

Respond with `{ activated: true }` and `{ typed: true }`, then assert both
promises resolve. Add `APP_ACTIVATION_FAILED` for `activate` and
`APP_NOT_FRONTMOST` for `replaceText`; assert both map to terminal driver code
`TAOBAO_NOT_FRONTMOST` without exposing the rejected value.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
swift test --package-path apps/collector-macos --filter ProtocolTests
node --test --test-concurrency=1 apps/collector/src/drivers/macos/ax-helper-client.spec.ts
```

Expected: Swift rejects the unknown command cases and TypeScript rejects the
new command string literals.

- [ ] **Step 4: Add command cases and route them**

Extend Swift:

```swift
enum CommandName: String, Codable, Equatable {
    case diagnose, snapshot, activate, perform, setValue, replaceText,
         keyPress, captureCopiedText, screenshot
}
```

Add `MacOSCommandHandler` switch branches:

```swift
case .activate:
    return try application.activate()
case .replaceText:
    guard let path = command.nodePath,
          let value = command.value,
          let fingerprint = command.fingerprint,
          fingerprint.role != nil || fingerprint.title != nil || fingerprint.identifier != nil else {
        throw invalidRequest()
    }
    return try application.replaceText(
        path: path,
        value: value,
        fingerprint: fingerprint
    )
```

Add the exact TypeScript union members to `AxHelperCommandName`. Do not add a
new free-form diagnostic field or log the request body. Extend the existing
frontmost error branch so either `APP_ACTIVATION_FAILED` or
`APP_NOT_FRONTMOST` becomes `DriverIssueError("TAOBAO_NOT_FRONTMOST", ...)`;
leave all other helper errors on the existing sanitized
`AxHelperResponseError` path.

- [ ] **Step 5: Run focused and complete helper tests**

Run:

```bash
swift test --package-path apps/collector-macos
node --test --test-concurrency=1 apps/collector/src/drivers/macos/ax-helper-client.spec.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit the protocol bridge**

```bash
git add apps/collector-macos/Sources/TaobaoAX/Protocol.swift apps/collector-macos/Sources/TaobaoAX/AccessibilityApplication.swift apps/collector-macos/Tests/TaobaoAXTests/ProtocolTests.swift apps/collector/src/drivers/macos/ax-helper-client.ts apps/collector/src/drivers/macos/ax-helper-client.spec.ts
git commit -m "feat: expose native Taobao search commands"
```

---

### Task 3: Switch The Live Driver And Remove The Invalid Button Contract

**Files:**
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-selectors.ts`
- Modify: `apps/collector/src/drivers/macos/taobao-selectors.spec.ts`

**Interfaces:**
- Consumes: TypeScript commands `"activate"` and `"replaceText"` from Task 2.
- Produces: `findSyntheticSearchConfirmAction(root: AxNode): { node: AxNode; action: "AXConfirm" }`.
- Preserves: `TaobaoMacDriver.search(query: string, limit: number)` and every
  downstream result, item, and SKU interface.

- [ ] **Step 1: Change live-driver expectations before implementation**

Update `LiveFakeClient.assertRawTarget` so `replaceText` requires the current
raw path and complete fingerprint. Change the primary live search expectation
to:

```typescript
assert.deepEqual(client.commands.map(({ command, fields }) => [
  command,
  fields.action ?? fields.keyCode ?? fields.value
]), [
  ["activate", undefined],
  ["replaceText", QUERY],
  ["keyPress", 36],
  ["keyPress", 121]
]);

assert.deepEqual(client.commands[1], {
  command: "replaceText",
  fields: {
    nodePath: [0, 0, 0, 0],
    value: QUERY,
    fingerprint: { role: "AXTextField" }
  }
});
assert.equal(client.commands.some(({ command }) => command === "setValue"), false);
assert.equal(client.commands.some(({ command, fields }) =>
  command === "perform" && fields.action === "AXPress" && fields.nodePath?.join(",") === "0,0,0,1"), false);
```

Change the fresh-value mismatch test to expect only `activate` and
`replaceText`; assert Return is never sent after the mismatch.

- [ ] **Step 2: Preserve synthetic expectations explicitly**

Update the synthetic driver test to include activation while retaining its
semantic path:

```typescript
assert.deepEqual(client.commands.map((entry) => [
  entry.command,
  entry.fields.action ?? entry.fields.value
]), [
  ["activate", undefined],
  ["setValue", "索尼 7506"],
  ["perform", "AXConfirm"]
]);
```

Keep the exact synthetic path and fingerprint assertion for `[0, 0, 0]` and
`search-input`.

- [ ] **Step 3: Replace generic submit-selector tests with a synthetic-only contract**

Rename the public selector to:

```typescript
export interface SyntheticSearchConfirmAction {
  node: AxNode;
  action: "AXConfirm";
}

export function findSyntheticSearchConfirmAction(root: AxNode): SyntheticSearchConfirmAction;
```

Its implementation must fail when the profile is not `SYNTHETIC`, when the
field is disabled, or when `AXConfirm` is absent. Remove
`liveFindSearchSubmitButton`, its import, and the two dedicated live button
tests. Keep the runtime-shaped button node in `live-search-results.json`
because it is legitimate snapshot evidence used by other selectors.

- [ ] **Step 4: Audit every affected command-order and selector expectation**

Run:

```bash
rg -n "client\\.commands|setValue|findSearchSubmitAction|liveFindSearchSubmitButton" apps/collector/src/drivers/macos --glob '*.spec.ts' --glob '*.ts'
```

Update every search-path expectation affected by the new universal `activate`
command, while leaving unrelated mutation tests unchanged. The audit must show
that `liveFindSearchSubmitButton` has no remaining import or call site and that
production live search contains neither `setValue` nor search-button
`AXPress`.

- [ ] **Step 5: Run focused driver and selector tests and verify RED**

Run:

```bash
node --test --test-concurrency=1 apps/collector/src/drivers/macos/taobao-selectors.spec.ts apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts
```

Expected: command-order tests fail because the driver still sends `setValue`
and live button `AXPress`.

- [ ] **Step 6: Implement the profile-aware write and submit flow**

At the start of every search, activate before the initial snapshot. Determine
the profile from that snapshot and require the fresh post-write snapshot to
retain the same profile:

```typescript
await this.client.command("activate");
const initial = await this.client.snapshot();
assertNoStopState(initial);
const profile = taobaoSelectorProfile(initial);
const field = findSearchField(initial);
const preSubmitSignature = optionalSearchContext(initial)?.signature ?? null;

if (profile === "LIVE") {
  await this.client.command("replaceText", {
    nodePath: field.path,
    value: query,
    fingerprint: fingerprintFor(field)
  });
} else {
  await this.client.command("setValue", {
    nodePath: field.path,
    value: query,
    fingerprint: fingerprintFor(field)
  });
}

const postWrite = await this.client.snapshot();
assertNoStopState(postWrite);
if (taobaoSelectorProfile(postWrite) !== profile) {
  throw new UiContractChangedError("Taobao search profile changed after replacing the query.");
}
const postWriteField = findSearchField(postWrite);
if (normalizedSearchValue(postWriteField.value) !== requestedValue) {
  throw new UiContractChangedError("Taobao search field did not retain the requested query.");
}

if (profile === "LIVE") {
  await this.client.command("keyPress", { keyCode: 36 });
} else {
  const submit = findSyntheticSearchConfirmAction(postWrite);
  await this.client.command("perform", {
    nodePath: submit.node.path,
    action: submit.action,
    fingerprint: fingerprintFor(submit.node)
  });
}
```

Do not alter `waitForStableSearch`, its timeout, or the three-observation gate.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the Step 5 command again.

Expected: every selector and driver test passes, live tests contain Return key
code `36`, and no live test submits via the search button.

- [ ] **Step 8: Run the full collector suite and type check**

Run:

```bash
pnpm test:collector
pnpm --filter @stau-price-monitor/collector typecheck
```

Expected: the complete collector suite and TypeScript type check pass.

- [ ] **Step 9: Commit the driver switch**

```bash
git add apps/collector/src/drivers/macos/taobao-mac-driver.ts apps/collector/src/drivers/macos/taobao-mac-driver-live.spec.ts apps/collector/src/drivers/macos/taobao-mac-driver.spec.ts apps/collector/src/drivers/macos/taobao-live-selectors.ts apps/collector/src/drivers/macos/taobao-live-selectors.spec.ts apps/collector/src/drivers/macos/taobao-selectors.ts apps/collector/src/drivers/macos/taobao-selectors.spec.ts
git commit -m "fix: submit Taobao search with native input"
```

---

### Task 4: Verify The Complete Change And Run Non-Persistent Live Probes

**Files:**
- Create, run, then delete without committing: `.superpowers/sdd/2026-08-31-taobao-semantic-search-submit/native-search-probe.mts`
- Modify, untracked execution evidence only: `.superpowers/sdd/2026-08-31-taobao-semantic-search-submit/task-4-report.md`
- Modify, untracked execution ledger only: `.superpowers/sdd/2026-08-31-taobao-semantic-search-submit/progress.md`

**Interfaces:**
- Consumes: the built helper and driver from Tasks 1-3.
- Produces: automated verification evidence and two non-persistent live search
  probe summaries.
- Produces no API row, queue job, alert, notification, or price action.

- [ ] **Step 1: Rebuild and run all local verification commands**

Run separately:

```bash
swift test --package-path apps/collector-macos
swift build --package-path apps/collector-macos
pnpm test:collector
pnpm --filter @stau-price-monitor/collector typecheck
git diff --check
git status --short --branch
```

Expected: every test and build passes; only the intended implementation files
and ignored SDD evidence are present.

- [ ] **Step 2: Review the complete branch diff against both designs**

Run:

```bash
git diff 1f01fbd3^..HEAD --stat
git diff 1f01fbd3^..HEAD -- apps/collector-macos apps/collector/src/drivers/macos docs/superpowers
```

Verify that no API, database, scheduling, Enterprise WeChat, notification, or
repricing files changed. Verify no production live path still calls the search
button selector.

- [ ] **Step 3: Run collector diagnosis three times**

Run these as three separate invocations:

```bash
pnpm collector:diagnose
pnpm collector:diagnose
pnpm collector:diagnose
```

Expected each time: terminal state `diagnose_complete`, supported version
`2.4.5` build `15`, accessibility and screen-recording permissions available,
front window available, logged-in state, and no challenge.

- [ ] **Step 4: Run two non-persistent live search probes**

With Taobao Desktop available, use `apply_patch` to create the ignored temporary
probe file named above with exactly this program:

```typescript
import { AxHelperClient } from "../../../apps/collector/src/drivers/macos/ax-helper-client.ts";
import { TaobaoMacDriver } from "../../../apps/collector/src/drivers/macos/taobao-mac-driver.ts";

const client = new AxHelperClient();
const driver = new TaobaoMacDriver({ client });

try {
  const own = await driver.search(
    "https://detail.tmall.com/item.htm?id=example-item-id",
    1
  );
  const model = await driver.search("RME Babyface Pro FS", 1);

  console.log(JSON.stringify({
    ownPositions: own.positions.length,
    ownTerminationReason: own.terminationReason,
    modelPositions: model.positions.length,
    modelTerminationReason: model.terminationReason
  }));
} finally {
  client.close();
}
```

Run it from the repository root:

```bash
pnpm exec tsx .superpowers/sdd/2026-08-31-taobao-semantic-search-submit/native-search-probe.mts
```

Do not print titles, shops, URLs, prices, query strings, raw accessibility
trees, or environment values. Do not call the API, queue, persistence,
notification, or repricing layers.

Expected: each search transitions, stabilizes, and returns one position.
After recording only the four sanitized fields in the report, delete the
temporary probe with `apply_patch` and confirm it is absent with
`test ! -e .superpowers/sdd/2026-08-31-taobao-semantic-search-submit/native-search-probe.mts`.

- [ ] **Step 5: Capture a final read-only snapshot summary**

Confirm that the active search web-area URL query and field value both represent
`RME Babyface Pro FS`, at least one supported item link is visible, and no login
or challenge state is present. Record only booleans and counts in the report.

- [ ] **Step 6: Update the ignored SDD evidence and stop before a pilot**

Append the root cause, automated command results, live probe summaries, and
explicit confirmations of zero API runs, zero WeCom sends, and zero price
actions to the Task 4 report and ledger. Do not commit ignored SDD evidence.

Present the evidence to the user and request separate authorization before
creating any replacement three-position collection run.

---

## Completion Gate

Implementation is complete only when Tasks 1-4 pass review, all automated
commands are green, both live search probes return one stable position, the
final snapshot agrees with the model query, the branch diff stays within scope,
and no collection run, Enterprise WeChat message, or price action has occurred.
