import Foundation
import XCTest
@testable import TaobaoAX

final class AccessibilityApplicationTests: XCTestCase {
    func testMissingRunningBundleRejectsInstalledMetadataBeforeActivationAndReplacement() throws {
        let installedShortVersion = "2.4.5"
        let installedBuild = "15"
        let runningApplication = RunningApplicationInfo.fromRunningBundle(
            processIdentifier: 321,
            bundleURL: nil,
            shortVersion: installedShortVersion,
            build: installedBuild
        )
        var activationRequests: [pid_t] = []
        var resolutionRequests = 0
        let poster = ApplicationTestUnicodePoster()
        let application = try AccessibilityApplication(
            bundleIdentifier: AccessibilityApplication.supportedBundleIdentifier,
            applicationActivator: ApplicationActivator(
                requestActivation: { pid in activationRequests.append(pid); return true },
                frontmostProcessIdentifier: { 321 },
                now: { 0 },
                sleep: { _ in }
            ),
            nativeSearchTextInput: NativeSearchTextInput(poster: poster),
            runningApplicationInfo: { runningApplication },
            searchTextFieldResolver: { _, _ in
                resolutionRequests += 1
                return ApplicationTestTextField()
            },
            isProcessFrontmost: { _ in true }
        )

        XCTAssertThrowsError(try application.activate()) { error in
            XCTAssertEqual((error as? HelperError)?.code, "UNSUPPORTED_TAOBA_BUILD")
        }
        XCTAssertThrowsError(
            try application.replaceText(
                path: [2, 1],
                value: "RME Babyface Pro FS",
                fingerprint: AXNodeFingerprint(role: "AXTextField", title: nil, identifier: "search")
            )
        ) { error in
            XCTAssertEqual((error as? HelperError)?.code, "UNSUPPORTED_TAOBA_BUILD")
        }
        XCTAssertTrue(activationRequests.isEmpty)
        XCTAssertEqual(resolutionRequests, 0)
        XCTAssertTrue(poster.posts.isEmpty)
    }

    func testActivateRejectsIncorrectShortVersionBeforeRequestingActivation() throws {
        var activationRequests: [pid_t] = []
        let application = try AccessibilityApplication(
            bundleIdentifier: AccessibilityApplication.supportedBundleIdentifier,
            applicationActivator: ApplicationActivator(
                requestActivation: { pid in activationRequests.append(pid); return true },
                frontmostProcessIdentifier: { 321 },
                now: { 0 },
                sleep: { _ in }
            ),
            runningApplicationInfo: {
                RunningApplicationInfo(processIdentifier: 321, shortVersion: "2.4.4", build: "15")
            }
        )

        XCTAssertThrowsError(try application.activate()) { error in
            XCTAssertEqual((error as? HelperError)?.code, "UNSUPPORTED_TAOBA_BUILD")
        }
        XCTAssertTrue(activationRequests.isEmpty)
    }

    func testReplaceTextRejectsIncorrectBuildBeforeResolvingField() throws {
        var resolutionRequests = 0
        let poster = ApplicationTestUnicodePoster()
        let application = try AccessibilityApplication(
            bundleIdentifier: AccessibilityApplication.supportedBundleIdentifier,
            nativeSearchTextInput: NativeSearchTextInput(poster: poster),
            runningApplicationInfo: {
                RunningApplicationInfo(processIdentifier: 321, shortVersion: "2.4.5", build: "14")
            },
            searchTextFieldResolver: { _, _ in
                resolutionRequests += 1
                return ApplicationTestTextField()
            },
            isProcessFrontmost: { _ in true }
        )

        XCTAssertThrowsError(
            try application.replaceText(
                path: [2, 1],
                value: "RME Babyface Pro FS",
                fingerprint: AXNodeFingerprint(role: "AXTextField", title: nil, identifier: "search")
            )
        ) { error in
            XCTAssertEqual((error as? HelperError)?.code, "UNSUPPORTED_TAOBA_BUILD")
        }
        XCTAssertEqual(resolutionRequests, 0)
        XCTAssertTrue(poster.posts.isEmpty)
    }

    func testActivateReturnsOnlyRedactedAcknowledgementAndUsesInjectedDependencies() throws {
        var activationRequests: [pid_t] = []
        let application = try AccessibilityApplication(
            bundleIdentifier: AccessibilityApplication.supportedBundleIdentifier,
            applicationActivator: ApplicationActivator(
                requestActivation: { pid in activationRequests.append(pid); return true },
                frontmostProcessIdentifier: { 321 },
                now: { 0 },
                sleep: { _ in }
            ),
            runningApplicationInfo: {
                RunningApplicationInfo(processIdentifier: 321, shortVersion: "2.4.5", build: "15")
            }
        )

        let payload = try application.activate()

        XCTAssertEqual(payload, .object(["activated": .boolean(true)]))
        XCTAssertEqual(activationRequests, [321])
    }

    func testReplaceTextReturnsOnlyRedactedAcknowledgementAndUsesInjectedDependencies() throws {
        let field = ApplicationTestTextField(existingValue: "旧查询")
        let poster = ApplicationTestUnicodePoster()
        var resolvedPaths: [[Int]] = []
        let application = try AccessibilityApplication(
            bundleIdentifier: AccessibilityApplication.supportedBundleIdentifier,
            nativeSearchTextInput: NativeSearchTextInput(poster: poster),
            runningApplicationInfo: {
                RunningApplicationInfo(processIdentifier: 321, shortVersion: "2.4.5", build: "15")
            },
            searchTextFieldResolver: { path, _ in
                resolvedPaths.append(path)
                return field
            },
            isProcessFrontmost: { $0 == 321 }
        )

        let payload = try application.replaceText(
            path: [2, 1],
            value: "RME Babyface Pro FS",
            fingerprint: AXNodeFingerprint(role: "AXTextField", title: nil, identifier: "search")
        )

        XCTAssertEqual(payload, .object(["typed": .boolean(true)]))
        XCTAssertEqual(resolvedPaths, [[2, 1]])
        XCTAssertEqual(poster.posts, [.init(pid: 321, text: "RME Babyface Pro FS")])
    }

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

    func testDiagnoseFrontWindowAvailabilityReturnsFalseWhenNoWindowExists() throws {
        let application = ReferencedTestAXElement()

        let result = try AccessibilityApplication.frontWindowAvailable(applicationRoot: application)

        XCTAssertFalse(result)
    }

    func testDiagnoseFrontWindowAvailabilityPropagatesReadError() {
        let readError = HelperError(
            code: "ACCESSIBILITY_READ_FAILED",
            message: "Accessibility data could not be read."
        )
        let application = ReferencedTestAXElement(referenceReadError: readError)

        XCTAssertThrowsError(
            try AccessibilityApplication.frontWindowAvailable(applicationRoot: application)
        ) { error in
            XCTAssertEqual(error as? HelperError, readError)
        }
    }
}

private final class ApplicationTestTextField: SearchTextFieldEditing {
    let existingValue: String

    init(existingValue: String = "旧查询") {
        self.existingValue = existingValue
    }

    func value(for attribute: String) throws -> Any? {
        switch attribute {
        case "AXRole": return "AXTextField"
        case "AXDescription": return "请输入搜索文字"
        case "AXEnabled": return true
        case "AXValue": return existingValue
        default: return nil
        }
    }

    func isAttributeSettable(_ attribute: String) throws -> Bool { true }
    func setFocused() throws {}
    func selectText(range: CFRange) throws {}
}

private final class ApplicationTestUnicodePoster: UnicodeTextPosting {
    struct Post: Equatable {
        let pid: pid_t
        let text: String
    }

    private(set) var posts: [Post] = []

    func post(text: String, to processIdentifier: pid_t) throws {
        posts.append(Post(pid: processIdentifier, text: text))
    }
}

private final class ReferencedTestAXElement: AXElementReading {
    private let title: String?
    private let references: [String: any AXElementReading]
    private let referenceReadError: HelperError?

    init(
        title: String? = nil,
        references: [String: any AXElementReading] = [:],
        referenceReadError: HelperError? = nil
    ) {
        self.title = title
        self.references = references
        self.referenceReadError = referenceReadError
    }

    func value(for attribute: String) throws -> Any? {
        nil
    }

    func referencedElement(for attribute: String) throws -> (any AXElementReading)? {
        if let referenceReadError {
            throw referenceReadError
        }
        references[attribute]
    }

    func actionNames() throws -> [String] {
        []
    }

    func childElements() throws -> [any AXElementReading] {
        []
    }

    func isSameElement(as other: any AXElementReading) -> Bool {
        self === (other as? ReferencedTestAXElement)
    }
}
