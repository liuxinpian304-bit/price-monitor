import Foundation
import ApplicationServices
import XCTest
@testable import TaobaoAX

final class AccessibilityApplicationTests: XCTestCase {
    func testDiagnoseReturnsInstalledMetadataWhenRunningBundleIsMissingWithoutMutation() throws {
        let installedBundleURL = try makeDiagnosticApplicationBundle(
            bundleIdentifier: AccessibilityApplication.supportedBundleIdentifier,
            shortVersion: "2.4.5",
            build: "15"
        )
        defer { try? FileManager.default.removeItem(at: installedBundleURL) }

        var diagnosticRunningLookups: [String] = []
        var installedApplicationLookups: [String] = []
        var frontWindowPIDs: [pid_t] = []
        let diagnoseInfo = AccessibilityApplication.makeDefaultDiagnoseInfoProvider(
            bundleIdentifier: AccessibilityApplication.supportedBundleIdentifier,
            runningApplication: { bundleIdentifier in
                diagnosticRunningLookups.append(bundleIdentifier)
                return DiagnosticRunningApplication(processIdentifier: 321, bundleURL: nil)
            },
            installedApplicationURL: { bundleIdentifier in
                installedApplicationLookups.append(bundleIdentifier)
                return installedBundleURL
            },
            accessibilityTrusted: { prompt in
                XCTAssertFalse(prompt)
                return true
            },
            screenRecordingTrusted: { false },
            frontWindowAvailable: { processIdentifier in
                frontWindowPIDs.append(processIdentifier)
                return false
            }
        )
        var mutationMetadataRequests = 0
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
            runningApplicationInfo: {
                mutationMetadataRequests += 1
                return RunningApplicationInfo.fromRunningBundle(
                    processIdentifier: 321,
                    bundleURL: nil,
                    shortVersion: "2.4.5",
                    build: "15"
                )
            },
            searchTextFieldResolver: { _, _ in
                resolutionRequests += 1
                return ApplicationTestTextField()
            },
            diagnoseInfo: diagnoseInfo
        )

        let result = try application.diagnose(prompt: false)

        XCTAssertEqual(result, .object([
            "appInstalled": .boolean(true),
            "trusted": .boolean(true),
            "screenRecordingTrusted": .boolean(false),
            "appRunning": .boolean(true),
            "pid": .number(321),
            "bundleId": .string(AccessibilityApplication.supportedBundleIdentifier),
            "shortVersion": .string("2.4.5"),
            "build": .string("15"),
            "frontWindowAvailable": .boolean(false),
        ]))
        XCTAssertEqual(diagnosticRunningLookups, [AccessibilityApplication.supportedBundleIdentifier])
        XCTAssertEqual(installedApplicationLookups, [AccessibilityApplication.supportedBundleIdentifier])
        XCTAssertEqual(frontWindowPIDs, [321])
        XCTAssertEqual(mutationMetadataRequests, 0)
        XCTAssertTrue(activationRequests.isEmpty)
        XCTAssertEqual(resolutionRequests, 0)
        XCTAssertTrue(poster.posts.isEmpty)
    }

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

    func testPressSkuOptionRejectsEmptyExpectedLabelBeforeNativeAction() throws {
        let fixture = makeSkuApplication()

        XCTAssertThrowsError(
            try fixture.application.pressSkuOption(
                path: [4, 2],
                expectedLabel: " \n\t ",
                fingerprint: skuFingerprint()
            )
        ) { error in
            XCTAssertEqual((error as? HelperError)?.code, "INVALID_REQUEST")
        }
        XCTAssertTrue(fixture.actions.isEmpty)
    }

    func testPressSkuOptionRejectsMismatchedRoleClassAndLabel() throws {
        let cases: [(String, ApplicationTestAXElement, String)] = [
            (
                "role",
                skuOption(role: "AXButton"),
                "Fixture Blue"
            ),
            (
                "class",
                skuOption(domClassList: ["otherItem--fixture"]),
                "Fixture Blue"
            ),
            (
                "label",
                skuOption(label: "Fixture Red"),
                "Fixture Blue"
            ),
        ]

        for (name, option, expectedLabel) in cases {
            let fixture = makeSkuApplication(option: option)
            let fingerprint = AXNodeFingerprint(
                role: option.attributes[AXAttribute.role] as? String,
                title: nil,
                identifier: nil,
                domClassList: option.attributes[AXAttribute.domClassList] as? [String]
            )

            XCTAssertThrowsError(
                try fixture.application.pressSkuOption(
                    path: [4, 2],
                    expectedLabel: expectedLabel,
                    fingerprint: fingerprint
                ),
                name
            ) { error in
                XCTAssertEqual((error as? HelperError)?.code, "SKU_OPTION_GUARD_FAILED", name)
            }
            XCTAssertTrue(fixture.actions.isEmpty, name)
        }
    }

    func testPressSkuOptionRejectsDisabledClasses() throws {
        for disabledClass in ["disabled--fixture", "soldOut--fixture", "sold-out--fixture", "UNAVAILABLE--fixture"] {
            let classes = ["valueItem--fixture", disabledClass]
            let fixture = makeSkuApplication(option: skuOption(domClassList: classes))

            XCTAssertThrowsError(
                try fixture.application.pressSkuOption(
                    path: [4, 2],
                    expectedLabel: "Fixture Blue",
                    fingerprint: AXNodeFingerprint(
                        role: "AXGroup",
                        title: nil,
                        identifier: nil,
                        domClassList: classes
                    )
                ),
                disabledClass
            ) { error in
                XCTAssertEqual((error as? HelperError)?.code, "SKU_OPTION_GUARD_FAILED", disabledClass)
            }
            XCTAssertTrue(fixture.actions.isEmpty, disabledClass)
        }
    }

    func testPressSkuOptionRequiresExactlyOneMatchingDescendantLabel() throws {
        let duplicate = ApplicationTestAXElement(attributes: [
            AXAttribute.role: "AXGroup",
            AXAttribute.domClassList: ["valueItem--fixture"],
        ], children: [
            ApplicationTestAXElement(attributes: [AXAttribute.value: "Fixture Blue"]),
            ApplicationTestAXElement(attributes: [AXAttribute.title: " Fixture   Blue "]),
        ])

        for option in [skuOption(label: "Fixture Red"), duplicate] {
            let fixture = makeSkuApplication(option: option)

            XCTAssertThrowsError(
                try fixture.application.pressSkuOption(
                    path: [4, 2],
                    expectedLabel: "Fixture Blue",
                    fingerprint: skuFingerprint()
                )
            ) { error in
                XCTAssertEqual((error as? HelperError)?.code, "SKU_OPTION_GUARD_FAILED")
            }
            XCTAssertTrue(fixture.actions.isEmpty)
        }
    }

    func testPressSkuOptionRejectsWeakFingerprintBeforeResolvingOrActing() throws {
        let fingerprints = [
            AXNodeFingerprint(role: nil, title: nil, identifier: nil, domClassList: nil),
            AXNodeFingerprint(role: "AXGroup", title: nil, identifier: nil, domClassList: nil),
            AXNodeFingerprint(role: "AXGroup", title: nil, identifier: nil, domClassList: []),
            AXNodeFingerprint(role: nil, title: nil, identifier: nil, domClassList: ["valueItem--fixture"]),
            AXNodeFingerprint(
                role: "AXGroup",
                title: nil,
                identifier: nil,
                domClassList: ["valueItem--fixture", "valueItem--fixture"]
            ),
            AXNodeFingerprint(
                role: "AXGroup",
                title: nil,
                identifier: nil,
                domClassList: ["valueItem--fixture", "isSelected--fixture", "isSelected--fixture"]
            ),
        ]

        for fingerprint in fingerprints {
            let fixture = makeSkuApplication()

            XCTAssertThrowsError(
                try fixture.application.pressSkuOption(
                    path: [4, 2],
                    expectedLabel: "Fixture Blue",
                    fingerprint: fingerprint
                )
            ) { error in
                XCTAssertEqual((error as? HelperError)?.code, "SKU_OPTION_GUARD_FAILED")
            }
            XCTAssertEqual(fixture.resolutionCount, 0)
            XCTAssertTrue(fixture.actions.isEmpty)
        }
    }

    func testPressSkuOptionRequiresExactlyOneValueItemClass() throws {
        let classLists = [
            ["valueItem--fixture", "valueItem--fixture"],
            ["valueItem--fixture", "valueItem--alternate"],
        ]

        for classes in classLists {
            let fixture = makeSkuApplication(option: skuOption(domClassList: classes))

            XCTAssertThrowsError(
                try fixture.application.pressSkuOption(
                    path: [4, 2],
                    expectedLabel: "Fixture Blue",
                    fingerprint: skuFingerprint()
                )
            ) { error in
                XCTAssertEqual((error as? HelperError)?.code, "SKU_OPTION_GUARD_FAILED")
            }
            XCTAssertTrue(fixture.actions.isEmpty)
        }
    }

    func testPressSkuOptionRejectsDuplicateNonValueLiveClassBeforeNativePress() throws {
        let fixture = makeSkuApplication(option: skuOption(domClassList: [
            "valueItem--fixture",
            "isSelected--fixture",
            "isSelected--fixture",
        ]))

        XCTAssertThrowsError(
            try fixture.application.pressSkuOption(
                path: [4, 2],
                expectedLabel: "Fixture Blue",
                fingerprint: skuFingerprint()
            )
        ) { error in
            XCTAssertEqual((error as? HelperError)?.code, "SKU_OPTION_GUARD_FAILED")
        }
        XCTAssertEqual(fixture.resolutionCount, 1)
        XCTAssertTrue(fixture.actions.isEmpty)
    }

    func testPressSkuOptionRejectsStaleDomClassFingerprint() throws {
        let fixture = makeSkuApplication(option: skuOption(domClassList: ["valueItem--changed"]))

        XCTAssertThrowsError(
            try fixture.application.pressSkuOption(
                path: [4, 2],
                expectedLabel: "Fixture Blue",
                fingerprint: skuFingerprint()
            )
        ) { error in
            XCTAssertEqual((error as? HelperError)?.code, "NODE_FINGERPRINT_MISMATCH")
        }
        XCTAssertTrue(fixture.actions.isEmpty)
    }

    func testPressSkuOptionRejectsNonFrontmostState() throws {
        let fixture = makeSkuApplication(isFrontmost: false)

        XCTAssertThrowsError(
            try fixture.application.pressSkuOption(
                path: [4, 2],
                expectedLabel: "Fixture Blue",
                fingerprint: skuFingerprint()
            )
        ) { error in
            XCTAssertEqual((error as? HelperError)?.code, "APP_NOT_FRONTMOST")
        }
        XCTAssertTrue(fixture.actions.isEmpty)
    }

    func testPressSkuOptionPropagatesMappedNativeActionError() throws {
        let fixture = makeSkuApplication(actionResult: .cannotComplete)

        XCTAssertThrowsError(
            try fixture.application.pressSkuOption(
                path: [4, 2],
                expectedLabel: "Fixture Blue",
                fingerprint: skuFingerprint()
            )
        ) { error in
            XCTAssertEqual((error as? HelperError)?.code, "ACTION_FAILED")
        }
        XCTAssertEqual(fixture.actions, ["AXPress"])
    }

    func testPressSkuOptionAttemptsNativePressAfterAllGuardsWithoutAdvertisedPressAction() throws {
        let fixture = makeSkuApplication(option: skuOption(actions: ["AXShowMenu", "AXScrollToVisible"]))

        let payload = try fixture.application.pressSkuOption(
            path: [4, 2],
            expectedLabel: " Fixture   Blue ",
            fingerprint: skuFingerprint()
        )

        XCTAssertEqual(payload, .object(["performed": .boolean(true)]))
        XCTAssertEqual(fixture.actions, ["AXPress"])
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

private final class SkuApplicationFixture {
    let application: AccessibilityApplication
    private let recorder: SkuActionRecorder
    var actions: [String] { recorder.actions }
    var resolutionCount: Int { recorder.resolutionCount }

    init(
        option: ApplicationTestAXElement,
        isFrontmost: Bool,
        actionResult: AXError
    ) throws {
        let recorder = SkuActionRecorder()
        self.recorder = recorder
        application = try AccessibilityApplication(
            bundleIdentifier: AccessibilityApplication.supportedBundleIdentifier,
            runningApplicationInfo: {
                RunningApplicationInfo(processIdentifier: 321, shortVersion: "2.4.5", build: "15")
            },
            skuOptionResolver: { [recorder] path, _ in
                XCTAssertEqual(path, [4, 2])
                recorder.resolutionCount += 1
                return option
            },
            nativeActionPerformer: { [recorder] _, action in
                recorder.actions.append(action)
                return actionResult
            },
            isProcessFrontmost: { processIdentifier in
                XCTAssertEqual(processIdentifier, 321)
                return isFrontmost
            }
        )
    }
}

private final class SkuActionRecorder {
    var actions: [String] = []
    var resolutionCount = 0
}

private func makeSkuApplication(
    option: ApplicationTestAXElement = skuOption(),
    isFrontmost: Bool = true,
    actionResult: AXError = .success
) -> SkuApplicationFixture {
    try! SkuApplicationFixture(option: option, isFrontmost: isFrontmost, actionResult: actionResult)
}

private func skuFingerprint() -> AXNodeFingerprint {
    AXNodeFingerprint(
        role: "AXGroup",
        title: nil,
        identifier: nil,
        domClassList: ["valueItem--fixture"]
    )
}

private func skuOption(
    role: String = "AXGroup",
    domClassList: [String] = ["valueItem--fixture"],
    label: String = "Fixture Blue",
    actions: [String] = ["AXShowMenu", "AXScrollToVisible"]
) -> ApplicationTestAXElement {
    ApplicationTestAXElement(
        attributes: [
            AXAttribute.role: role,
            AXAttribute.domClassList: domClassList,
        ],
        actions: actions,
        children: [ApplicationTestAXElement(attributes: [AXAttribute.value: label])]
    )
}

private func makeDiagnosticApplicationBundle(
    bundleIdentifier: String,
    shortVersion: String,
    build: String
) throws -> URL {
    let bundleURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("TaobaoAXTests-\(UUID().uuidString)")
        .appendingPathExtension("app")
    let contentsURL = bundleURL.appendingPathComponent("Contents", isDirectory: true)
    try FileManager.default.createDirectory(at: contentsURL, withIntermediateDirectories: true)
    let propertyList: [String: Any] = [
        "CFBundleIdentifier": bundleIdentifier,
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": shortVersion,
        "CFBundleVersion": build,
    ]
    let data = try PropertyListSerialization.data(
        fromPropertyList: propertyList,
        format: .xml,
        options: 0
    )
    try data.write(to: contentsURL.appendingPathComponent("Info.plist"), options: .atomic)
    return bundleURL
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

private final class ApplicationTestAXElement: AXElementReading {
    let attributes: [String: Any]
    let actions: [String]
    let children: [any AXElementReading]

    init(
        attributes: [String: Any] = [:],
        actions: [String] = [],
        children: [any AXElementReading] = []
    ) {
        self.attributes = attributes
        self.actions = actions
        self.children = children
    }

    func value(for attribute: String) throws -> Any? { attributes[attribute] }
    func referencedElement(for attribute: String) throws -> (any AXElementReading)? { nil }
    func actionNames() throws -> [String] { actions }
    func childElements() throws -> [any AXElementReading] { children }
    func isSameElement(as other: any AXElementReading) -> Bool { self === (other as? ApplicationTestAXElement) }
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
