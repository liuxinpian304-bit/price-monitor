@preconcurrency import AppKit
@preconcurrency import ApplicationServices
import Foundation

protocol AccessibilityApplicationHandling {
    func diagnose(prompt: Bool) throws -> JSONValue
    func snapshot() throws -> JSONValue
    func perform(path: [Int], action: String, fingerprint: AXNodeFingerprint?) throws -> JSONValue
    func setValue(path: [Int], value: String, fingerprint: AXNodeFingerprint?) throws -> JSONValue
    func activate() throws -> JSONValue
    func replaceText(path: [Int], value: String, fingerprint: AXNodeFingerprint) throws -> JSONValue
    func keyPress(keyCode: Int) throws -> JSONValue
    func captureCopiedText(path: [Int], action: String, fingerprint: AXNodeFingerprint?) throws -> JSONValue
    func runningProcessIdentifier() throws -> pid_t
}

final class AccessibilityApplication: AccessibilityApplicationHandling {
    static let supportedBundleIdentifier = "com.taobao.pcdesktop"

    private let treeSerializer: AXTreeSerializer
    private let applicationActivator: ApplicationActivator
    private let nativeSearchTextInput: NativeSearchTextInput
    private let runningApplicationInfoProvider: () -> RunningApplicationInfo?
    private let searchTextFieldResolver: (([Int], AXNodeFingerprint) throws -> any SearchTextFieldEditing)?
    private let isProcessFrontmost: (pid_t) -> Bool
    private let diagnoseInfoProvider: (Bool) throws -> DiagnoseInfo

    init(
        bundleIdentifier: String,
        treeSerializer: AXTreeSerializer = AXTreeSerializer(),
        applicationActivator: ApplicationActivator = ApplicationActivator(),
        nativeSearchTextInput: NativeSearchTextInput = NativeSearchTextInput(poster: CGUnicodeTextPoster()),
        runningApplicationInfo: (() -> RunningApplicationInfo?)? = nil,
        searchTextFieldResolver: (([Int], AXNodeFingerprint) throws -> any SearchTextFieldEditing)? = nil,
        isProcessFrontmost: @escaping (pid_t) -> Bool = {
            NSWorkspace.shared.frontmostApplication?.processIdentifier == $0
        },
        diagnoseInfo: ((Bool) throws -> DiagnoseInfo)? = nil
    ) throws {
        guard bundleIdentifier == Self.supportedBundleIdentifier else {
            throw HelperError(code: "UNSUPPORTED_BUNDLE_ID", message: "Unsupported application.")
        }
        let expectedBundleIdentifier = bundleIdentifier
        self.treeSerializer = treeSerializer
        self.applicationActivator = applicationActivator
        self.nativeSearchTextInput = nativeSearchTextInput
        self.runningApplicationInfoProvider = runningApplicationInfo ?? {
            guard let application = Self.runningApplication(bundleIdentifier: expectedBundleIdentifier) else {
                return nil
            }
            let metadata = application.bundleURL.flatMap(Self.runningBundleMetadata)
            return RunningApplicationInfo.fromRunningBundle(
                processIdentifier: application.processIdentifier,
                bundleURL: application.bundleURL,
                shortVersion: metadata?.shortVersion,
                build: metadata?.build
            )
        }
        self.searchTextFieldResolver = searchTextFieldResolver
        self.isProcessFrontmost = isProcessFrontmost
        self.diagnoseInfoProvider = diagnoseInfo ?? Self.makeDefaultDiagnoseInfoProvider(
            bundleIdentifier: expectedBundleIdentifier,
            runningApplication: { bundleIdentifier in
                Self.runningApplication(bundleIdentifier: bundleIdentifier).map {
                    DiagnosticRunningApplication(
                        processIdentifier: $0.processIdentifier,
                        bundleURL: $0.bundleURL
                    )
                }
            },
            installedApplicationURL: {
                NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0)
            },
            accessibilityTrusted: { prompt in
                let options = [
                    kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt,
                ] as CFDictionary
                return AXIsProcessTrustedWithOptions(options)
            },
            screenRecordingTrusted: { ScreenCapture().preflightAccess() },
            frontWindowAvailable: { processIdentifier in
                let root = LiveAXElement(
                    element: AXUIElementCreateApplication(processIdentifier)
                )
                return try Self.frontWindowAvailable(applicationRoot: root)
            }
        )
    }

    static func makeDefaultDiagnoseInfoProvider(
        bundleIdentifier: String,
        runningApplication: @escaping (String) -> DiagnosticRunningApplication?,
        installedApplicationURL: @escaping (String) -> URL?,
        accessibilityTrusted: @escaping (Bool) -> Bool,
        screenRecordingTrusted: @escaping () -> Bool,
        frontWindowAvailable: @escaping (pid_t) throws -> Bool
    ) -> (Bool) throws -> DiagnoseInfo {
        { prompt in
            let trusted = accessibilityTrusted(prompt)
            let runningApplication = runningApplication(bundleIdentifier)
            let installedURL = runningApplication?.bundleURL == nil
                ? installedApplicationURL(bundleIdentifier)
                : nil
            let metadataURL = runningApplication?.bundleURL ?? installedURL
            let metadata = metadataURL.flatMap(Self.runningBundleMetadata)
                ?? BundleMetadata(bundleIdentifier: nil, shortVersion: nil, build: nil)
            let isFrontWindowAvailable: Bool
            if trusted, let runningApplication {
                isFrontWindowAvailable = try frontWindowAvailable(runningApplication.processIdentifier)
            } else {
                isFrontWindowAvailable = false
            }
            return DiagnoseInfo(
                appInstalled: runningApplication?.bundleURL != nil || installedURL != nil,
                trusted: trusted,
                screenRecordingTrusted: screenRecordingTrusted(),
                processIdentifier: runningApplication?.processIdentifier,
                bundleIdentifier: metadata.bundleIdentifier,
                shortVersion: metadata.shortVersion,
                build: metadata.build,
                frontWindowAvailable: isFrontWindowAvailable
            )
        }
    }

    func diagnose(prompt: Bool) throws -> JSONValue {
        let info = try diagnoseInfoProvider(prompt)

        return .object([
            "appInstalled": .boolean(info.appInstalled),
            "trusted": .boolean(info.trusted),
            "screenRecordingTrusted": .boolean(info.screenRecordingTrusted),
            "appRunning": .boolean(info.processIdentifier != nil),
            "pid": info.processIdentifier.map { .number(Double($0)) } ?? .null,
            "bundleId": info.bundleIdentifier.map(JSONValue.string) ?? .null,
            "shortVersion": info.shortVersion.map(JSONValue.string) ?? .null,
            "build": info.build.map(JSONValue.string) ?? .null,
            "frontWindowAvailable": .boolean(info.frontWindowAvailable),
        ])
    }

    static func frontWindowAvailable(applicationRoot: any AXElementReading) throws -> Bool {
        do {
            _ = try AXScopedRootResolver().resolve(applicationRoot: applicationRoot)
            return true
        } catch let error as HelperError where error.code == "FRONT_WINDOW_NOT_AVAILABLE" {
            return false
        } catch {
            throw error
        }
    }

    func snapshot() throws -> JSONValue {
        let root = try freshRoot()
        let serialization = try treeSerializer.serialize(root: root.element, scope: root.scope)
        return try AXSnapshotEncoder().encode(
            serialization,
            scope: root.scope,
            limits: treeSerializer.limits
        )
    }

    func perform(path: [Int], action: String, fingerprint: AXNodeFingerprint?) throws -> JSONValue {
        guard !action.isEmpty else { throw invalidRequest() }
        let element = try resolve(path: path, fingerprint: fingerprint)
        let actions = try element.actionNames()
        guard actions.contains(action) else {
            throw HelperError(code: "ACTION_NOT_SUPPORTED", message: "Accessibility action is not supported.")
        }

        let result = AXUIElementPerformAction(element.element, action as CFString)
        guard result == .success else { throw mappedActionError(result) }
        return .object(["performed": .boolean(true)])
    }

    func setValue(path: [Int], value: String, fingerprint: AXNodeFingerprint?) throws -> JSONValue {
        let element = try resolve(path: path, fingerprint: fingerprint)
        let result = AXUIElementSetAttributeValue(
            element.element,
            kAXValueAttribute as CFString,
            value as CFTypeRef
        )
        guard result == .success else { throw mappedActionError(result) }
        return .object(["valueSet": .boolean(true)])
    }

    func activate() throws -> JSONValue {
        let pid = try runningProcessIdentifier()
        try applicationActivator.activate(processIdentifier: pid, timeout: 2)
        return .object(["activated": .boolean(true)])
    }

    func replaceText(path: [Int], value: String, fingerprint: AXNodeFingerprint) throws -> JSONValue {
        let pid = try runningProcessIdentifier()
        let field = try resolveSearchTextField(path: path, fingerprint: fingerprint)
        try nativeSearchTextInput.replace(
            field: field,
            processIdentifier: pid,
            value: value,
            isFrontmost: { isProcessFrontmost(pid) }
        )
        return .object(["typed": .boolean(true)])
    }

    func keyPress(keyCode: Int) throws -> JSONValue {
        let allowedKeyCodes: Set<Int> = [36, 121, 115]
        guard allowedKeyCodes.contains(keyCode), let virtualKey = CGKeyCode(exactly: keyCode) else {
            throw HelperError(code: "KEY_NOT_ALLOWED", message: "Keyboard action is not allowed.")
        }

        let processIdentifier = try runningProcessIdentifier()
        _ = try freshRoot().element
        guard isProcessFrontmost(processIdentifier) else {
            throw HelperError(code: "APP_NOT_FRONTMOST", message: "Application is not frontmost.")
        }
        guard let source = CGEventSource(stateID: .hidSystemState),
              let keyDown = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: false) else {
            throw HelperError(code: "KEY_EVENT_FAILED", message: "Keyboard action failed.")
        }

        keyDown.postToPid(processIdentifier)
        keyUp.postToPid(processIdentifier)
        return .object(["performed": .boolean(true)])
    }

    func captureCopiedText(
        path: [Int],
        action: String,
        fingerprint: AXNodeFingerprint?
    ) throws -> JSONValue {
        guard !action.isEmpty else { throw invalidRequest() }
        let pasteboard = SystemPasteboard(pasteboard: .general)
        let text = try ClipboardCapture().capture(using: pasteboard) {
            let element = try resolve(path: path, fingerprint: fingerprint)
            let actions = try element.actionNames()
            guard actions.contains(action) else {
                throw HelperError(
                    code: "ACTION_NOT_SUPPORTED",
                    message: "Accessibility action is not supported."
                )
            }
            let result = AXUIElementPerformAction(element.element, action as CFString)
            guard result == .success else { throw mappedActionError(result) }
        }
        return .object(["text": .string(text)])
    }

    func runningProcessIdentifier() throws -> pid_t {
        try supportedRunningApplicationInfo().processIdentifier
    }

    private func freshRoot() throws -> (element: LiveAXElement, scope: AXRootScope) {
        guard AXIsProcessTrusted() else {
            throw HelperError(
                code: "ACCESSIBILITY_PERMISSION_REQUIRED",
                message: "Accessibility permission is required."
            )
        }
        let application = try supportedRunningApplicationInfo()
        let applicationRoot = LiveAXElement(
            element: AXUIElementCreateApplication(application.processIdentifier)
        )
        let scoped = try AXScopedRootResolver().resolve(applicationRoot: applicationRoot)
        guard let element = scoped.element as? LiveAXElement else {
            throw HelperError(code: "ACCESSIBILITY_READ_FAILED", message: "Window root is invalid.")
        }
        return (element, scoped.scope)
    }

    private func resolve(path: [Int], fingerprint: AXNodeFingerprint?) throws -> LiveAXElement {
        guard path.allSatisfy({ $0 >= 0 }) else {
            throw HelperError(code: "INVALID_NODE_PATH", message: "Invalid accessibility node path.")
        }

        var current = try freshRoot().element
        for index in path {
            let children = try current.liveChildren()
            guard children.indices.contains(index) else {
                throw HelperError(code: "NODE_NOT_FOUND", message: "Accessibility node was not found.")
            }
            current = children[index]
        }

        if let fingerprint {
            let role = try current.value(for: AXAttribute.role) as? String
            let title = try current.value(for: AXAttribute.title) as? String
            let identifier = try current.value(for: AXAttribute.identifier) as? String
            let matches = (fingerprint.role == nil || fingerprint.role == role)
                && (fingerprint.title == nil || fingerprint.title == title)
                && (fingerprint.identifier == nil || fingerprint.identifier == identifier)
            guard matches else {
                throw HelperError(
                    code: "NODE_FINGERPRINT_MISMATCH",
                    message: "Accessibility node fingerprint changed."
                )
            }
        }
        return current
    }

    private func resolveSearchTextField(
        path: [Int],
        fingerprint: AXNodeFingerprint
    ) throws -> any SearchTextFieldEditing {
        if let searchTextFieldResolver {
            return try searchTextFieldResolver(path, fingerprint)
        }
        return try resolve(path: path, fingerprint: fingerprint)
    }

    private func supportedRunningApplicationInfo() throws -> RunningApplicationInfo {
        guard let application = runningApplicationInfoProvider() else {
            throw HelperError(code: "APP_NOT_RUNNING", message: "Application is not running.")
        }
        guard application.shortVersion == "2.4.5", application.build == "15" else {
            throw HelperError(code: "UNSUPPORTED_TAOBA_BUILD", message: "Unsupported Taobao application build.")
        }
        return application
    }

    private static func runningApplication(bundleIdentifier: String) -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
            .sorted { $0.processIdentifier < $1.processIdentifier }
            .first
    }

    private static func runningBundleMetadata(bundleURL: URL) -> BundleMetadata? {
        guard let bundle = Bundle(url: bundleURL) else { return nil }
        return BundleMetadata(
            bundleIdentifier: bundle.bundleIdentifier,
            shortVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            build: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        )
    }

    private func mappedActionError(_ error: AXError) -> HelperError {
        if error == .actionUnsupported || error == .attributeUnsupported {
            return HelperError(code: "ACTION_NOT_SUPPORTED", message: "Accessibility action is not supported.")
        }
        if error == .invalidUIElement {
            return HelperError(code: "NODE_NOT_FOUND", message: "Accessibility node was not found.")
        }
        if error == .apiDisabled {
            return HelperError(
                code: "ACCESSIBILITY_PERMISSION_REQUIRED",
                message: "Accessibility permission is required."
            )
        }
        return HelperError(code: "ACTION_FAILED", message: "Accessibility action failed.")
    }

    private func invalidRequest() -> HelperError {
        HelperError(code: "INVALID_REQUEST", message: "Invalid request.")
    }
}

struct MacOSCommandHandler: CommandHandling {
    private let applicationFactory: (String) throws -> any AccessibilityApplicationHandling

    init(
        applicationFactory: @escaping (String) throws -> any AccessibilityApplicationHandling = { bundleIdentifier in
            try AccessibilityApplication(bundleIdentifier: bundleIdentifier)
        }
    ) {
        self.applicationFactory = applicationFactory
    }

    static func shouldPrompt(for value: String?) -> Bool {
        value == "prompt"
    }

    func handle(_ command: HelperCommand) throws -> JSONValue? {
        if command.command == .activate {
            guard command.nodePath == nil,
                  command.value == nil,
                  command.fingerprint == nil,
                  command.action == nil,
                  command.keyCode == nil,
                  command.destination == nil else {
                throw invalidRequest()
            }
        }
        let application = try applicationFactory(command.bundleId)

        switch command.command {
        case .diagnose:
            return try application.diagnose(prompt: Self.shouldPrompt(for: command.value))
        case .snapshot:
            return try application.snapshot()
        case .activate:
            return try application.activate()
        case .perform:
            guard let path = command.nodePath, let action = command.action else {
                throw invalidRequest()
            }
            return try application.perform(
                path: path,
                action: action,
                fingerprint: command.fingerprint
            )
        case .setValue:
            guard let path = command.nodePath, let value = command.value else {
                throw invalidRequest()
            }
            return try application.setValue(
                path: path,
                value: value,
                fingerprint: command.fingerprint
            )
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
        case .keyPress:
            guard let keyCode = command.keyCode else { throw invalidRequest() }
            return try application.keyPress(keyCode: keyCode)
        case .captureCopiedText:
            guard let path = command.nodePath, let action = command.action else {
                throw invalidRequest()
            }
            return try application.captureCopiedText(
                path: path,
                action: action,
                fingerprint: command.fingerprint
            )
        case .screenshot:
            guard let destination = command.destination else { throw invalidRequest() }
            let processIdentifier = try application.runningProcessIdentifier()
            return try ScreenCapture().captureWindow(
                processIdentifier: processIdentifier,
                destination: destination
            )
        }
    }

    private func invalidRequest() -> HelperError {
        HelperError(code: "INVALID_REQUEST", message: "Invalid request.")
    }
}

private struct BundleMetadata {
    let bundleIdentifier: String?
    let shortVersion: String?
    let build: String?
}

struct RunningApplicationInfo {
    let processIdentifier: pid_t
    let shortVersion: String?
    let build: String?

    static func fromRunningBundle(
        processIdentifier: pid_t,
        bundleURL: URL?,
        shortVersion: String?,
        build: String?
    ) -> RunningApplicationInfo {
        guard bundleURL != nil else {
            return RunningApplicationInfo(
                processIdentifier: processIdentifier,
                shortVersion: nil,
                build: nil
            )
        }
        return RunningApplicationInfo(
            processIdentifier: processIdentifier,
            shortVersion: shortVersion,
            build: build
        )
    }
}

struct DiagnoseInfo {
    let appInstalled: Bool
    let trusted: Bool
    let screenRecordingTrusted: Bool
    let processIdentifier: pid_t?
    let bundleIdentifier: String?
    let shortVersion: String?
    let build: String?
    let frontWindowAvailable: Bool
}

struct DiagnosticRunningApplication {
    let processIdentifier: pid_t
    let bundleURL: URL?
}

final class LiveAXElement: AXElementReading, SearchTextFieldEditing {
    let element: AXUIElement

    init(element: AXUIElement) {
        self.element = element
    }

    func value(for attribute: String) throws -> Any? {
        var copiedValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &copiedValue)
        if result == .noValue || result == .attributeUnsupported {
            return nil
        }
        guard result == .success else { throw mappedReadError(result) }
        guard let copiedValue else { return nil }

        if attribute == AXAttribute.position,
           CFGetTypeID(copiedValue) == AXValueGetTypeID() {
            var point = CGPoint.zero
            guard AXValueGetValue(copiedValue as! AXValue, .cgPoint, &point) else { return nil }
            return AXPoint(x: point.x, y: point.y)
        }
        if attribute == AXAttribute.size,
           CFGetTypeID(copiedValue) == AXValueGetTypeID() {
            var size = CGSize.zero
            guard AXValueGetValue(copiedValue as! AXValue, .cgSize, &size) else { return nil }
            return AXSize(width: size.width, height: size.height)
        }
        return copiedValue
    }

    func referencedElement(for attribute: String) throws -> (any AXElementReading)? {
        var copiedValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &copiedValue)
        if result == .noValue || result == .attributeUnsupported {
            return nil
        }
        guard result == .success else { throw mappedReadError(result) }
        guard let copiedValue, CFGetTypeID(copiedValue) == AXUIElementGetTypeID() else {
            return nil
        }
        return LiveAXElement(element: copiedValue as! AXUIElement)
    }

    func actionNames() throws -> [String] {
        var copiedNames: CFArray?
        let result = AXUIElementCopyActionNames(element, &copiedNames)
        if result == .actionUnsupported || result == .attributeUnsupported {
            return []
        }
        guard result == .success else { throw mappedReadError(result) }
        return copiedNames as? [String] ?? []
    }

    func childElements() throws -> [any AXElementReading] {
        try liveChildren()
    }

    func liveChildren() throws -> [LiveAXElement] {
        var copiedChildren: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(
            element,
            kAXChildrenAttribute as CFString,
            &copiedChildren
        )
        if result == .noValue || result == .attributeUnsupported {
            return []
        }
        guard result == .success else { throw mappedReadError(result) }
        guard let children = copiedChildren as? [AXUIElement] else { return [] }
        return children.map(LiveAXElement.init)
    }

    func hasValue(for attribute: String) throws -> Bool {
        var copiedValue: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &copiedValue)
        if result == .noValue || result == .attributeUnsupported {
            return false
        }
        guard result == .success else { throw mappedReadError(result) }
        return copiedValue != nil
    }

    func isAttributeSettable(_ attribute: String) throws -> Bool {
        var settable = DarwinBoolean(false)
        let result = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
        if result == .success {
            return settable.boolValue
        }
        if result == .attributeUnsupported || result == .noValue {
            return false
        }
        throw mappedReadError(result)
    }

    func setFocused() throws {
        let result = AXUIElementSetAttributeValue(
            element,
            kAXFocusedAttribute as CFString,
            kCFBooleanTrue
        )
        guard result == .success else { throw mappedReadError(result) }
    }

    func selectText(range: CFRange) throws {
        var selection = range
        guard let value = AXValueCreate(.cfRange, &selection) else {
            throw HelperError(code: "ACCESSIBILITY_READ_FAILED", message: "Accessibility data could not be read.")
        }
        let result = AXUIElementSetAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            value
        )
        guard result == .success else { throw mappedReadError(result) }
    }

    func isSameElement(as other: any AXElementReading) -> Bool {
        guard let other = other as? LiveAXElement else { return false }
        return CFEqual(element, other.element)
    }

    private func mappedReadError(_ error: AXError) -> HelperError {
        if error == .apiDisabled {
            return HelperError(
                code: "ACCESSIBILITY_PERMISSION_REQUIRED",
                message: "Accessibility permission is required."
            )
        }
        if error == .invalidUIElement {
            return HelperError(code: "NODE_NOT_FOUND", message: "Accessibility node was not found.")
        }
        return HelperError(
            code: "ACCESSIBILITY_READ_FAILED",
            message: "Accessibility data could not be read."
        )
    }
}

struct PasteboardArchive: Equatable {
    struct Item: Equatable {
        let valuesByType: [String: Data]
    }

    let items: [Item]
}

protocol PasteboardAccessing: AnyObject {
    var changeCount: Int { get }
    var utf8String: String? { get }
    func archive() throws -> PasteboardArchive
    func restore(_ archive: PasteboardArchive) throws
}

struct ClipboardCapture {
    let timeout: TimeInterval
    let pollInterval: TimeInterval
    let now: () -> Date
    let sleep: (TimeInterval) -> Void

    init(
        timeout: TimeInterval = 2,
        pollInterval: TimeInterval = 0.05,
        now: @escaping () -> Date = Date.init,
        sleep: @escaping (TimeInterval) -> Void = Thread.sleep(forTimeInterval:)
    ) {
        self.timeout = timeout
        self.pollInterval = pollInterval
        self.now = now
        self.sleep = sleep
    }

    func capture(using pasteboard: any PasteboardAccessing, action: () throws -> Void) throws -> String {
        let original = try pasteboard.archive()
        let originalChangeCount = pasteboard.changeCount
        let originalString = pasteboard.utf8String
        let outcome: Result<String, Error>

        do {
            try action()
            outcome = .success(try waitForCopiedText(
                pasteboard: pasteboard,
                originalChangeCount: originalChangeCount,
                originalString: originalString
            ))
        } catch {
            outcome = .failure(error)
        }

        try restore(original, to: pasteboard)
        return try outcome.get()
    }

    private func waitForCopiedText(
        pasteboard: any PasteboardAccessing,
        originalChangeCount: Int,
        originalString: String?
    ) throws -> String {
        let deadline = now().addingTimeInterval(timeout)
        while now() < deadline {
            if pasteboard.changeCount != originalChangeCount,
               let copied = pasteboard.utf8String,
               copied != originalString {
                return copied
            }
            sleep(pollInterval)
        }
        throw HelperError(code: "CLIPBOARD_COPY_FAILED", message: "Copied text was not available.")
    }

    private func restore(_ archive: PasteboardArchive, to pasteboard: any PasteboardAccessing) throws {
        do {
            try pasteboard.restore(archive)
        } catch {
            throw HelperError(code: "CLIPBOARD_RESTORE_FAILED", message: "Clipboard could not be restored.")
        }
    }
}

final class SystemPasteboard: PasteboardAccessing {
    private let pasteboard: NSPasteboard

    init(pasteboard: NSPasteboard) {
        self.pasteboard = pasteboard
    }

    var changeCount: Int { pasteboard.changeCount }
    var utf8String: String? { pasteboard.string(forType: .string) }

    func archive() throws -> PasteboardArchive {
        let items = try (pasteboard.pasteboardItems ?? []).map { item in
            var valuesByType: [String: Data] = [:]
            for type in item.types {
                guard let data = item.data(forType: type) else {
                    throw HelperError(
                        code: "CLIPBOARD_SNAPSHOT_FAILED",
                        message: "Clipboard could not be preserved."
                    )
                }
                valuesByType[type.rawValue] = data
            }
            return PasteboardArchive.Item(valuesByType: valuesByType)
        }
        return PasteboardArchive(items: items)
    }

    func restore(_ archive: PasteboardArchive) throws {
        pasteboard.clearContents()
        guard !archive.items.isEmpty else { return }

        let items = try archive.items.map { archivedItem -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (rawType, data) in archivedItem.valuesByType {
                guard item.setData(data, forType: NSPasteboard.PasteboardType(rawType)) else {
                    throw HelperError(
                        code: "CLIPBOARD_RESTORE_FAILED",
                        message: "Clipboard could not be restored."
                    )
                }
            }
            return item
        }
        guard pasteboard.writeObjects(items) else {
            throw HelperError(code: "CLIPBOARD_RESTORE_FAILED", message: "Clipboard could not be restored.")
        }
    }
}
