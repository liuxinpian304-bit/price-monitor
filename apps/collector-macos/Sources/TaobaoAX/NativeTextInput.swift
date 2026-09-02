@preconcurrency import AppKit
@preconcurrency import ApplicationServices
import Foundation

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

    init(
        requestActivation: @escaping (pid_t) -> Bool = { processIdentifier in
            NSRunningApplication(processIdentifier: processIdentifier)?.activate(
                options: [.activateIgnoringOtherApps]
            ) ?? false
        },
        frontmostProcessIdentifier: @escaping () -> pid_t? = {
            NSWorkspace.shared.frontmostApplication?.processIdentifier
        },
        now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        sleep: @escaping (TimeInterval) -> Void = Thread.sleep(forTimeInterval:)
    ) {
        self.requestActivation = requestActivation
        self.frontmostProcessIdentifier = frontmostProcessIdentifier
        self.now = now
        self.sleep = sleep
    }

    func activate(processIdentifier: pid_t, timeout: TimeInterval = 2) throws {
        guard requestActivation(processIdentifier) else { throw activationFailed() }

        let deadline = now() + timeout
        while now() < deadline {
            if frontmostProcessIdentifier() == processIdentifier {
                return
            }
            sleep(0.05)
        }
        throw activationFailed()
    }

    private func activationFailed() -> HelperError {
        HelperError(code: "APP_ACTIVATION_FAILED", message: "Application activation failed.")
    }
}

struct NativeSearchTextInput {
    let poster: any UnicodeTextPosting

    func replace(
        field: any SearchTextFieldEditing,
        processIdentifier: pid_t,
        value: String,
        isFrontmost: () -> Bool
    ) throws {
        let existingValue: String
        do {
            guard try field.value(for: "AXRole") as? String == "AXTextField",
                  try field.value(for: "AXDescription") as? String == "请输入搜索文字",
                  try field.value(for: "AXEnabled") as? Bool == true,
                  let currentValue = try field.value(for: "AXValue") as? String,
                  try field.isAttributeSettable("AXValue"),
                  try field.isAttributeSettable("AXFocused"),
                  try field.isAttributeSettable("AXSelectedTextRange") else {
                throw invalidTextTarget()
            }
            existingValue = currentValue
        } catch let error as HelperError where error.code == "INVALID_TEXT_TARGET" {
            throw error
        } catch {
            throw invalidTextTarget()
        }

        guard (1...2_048).contains(value.utf16.count),
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw invalidTextTarget()
        }

        do {
            try field.setFocused()
            try field.selectText(range: CFRange(location: 0, length: existingValue.utf16.count))
        } catch {
            throw textSelectionFailed()
        }

        guard isFrontmost() else { throw invalidTextTarget() }

        do {
            try poster.post(text: value, to: processIdentifier)
        } catch {
            throw textEventFailed()
        }
    }

    private func invalidTextTarget() -> HelperError {
        HelperError(code: "INVALID_TEXT_TARGET", message: "Search text target is invalid.")
    }

    private func textSelectionFailed() -> HelperError {
        HelperError(code: "TEXT_SELECTION_FAILED", message: "Search text selection failed.")
    }

    private func textEventFailed() -> HelperError {
        HelperError(code: "TEXT_EVENT_FAILED", message: "Search text event failed.")
    }
}

struct CGUnicodeTextPoster: UnicodeTextPosting {
    func post(text: String, to processIdentifier: pid_t) throws {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            throw HelperError(code: "TEXT_EVENT_FAILED", message: "Search text event failed.")
        }

        let utf16 = Array(text.utf16)
        utf16.withUnsafeBufferPointer { buffer in
            keyDown.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: buffer.baseAddress)
            keyUp.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: buffer.baseAddress)
        }
        keyDown.postToPid(processIdentifier)
        keyUp.postToPid(processIdentifier)
    }
}
