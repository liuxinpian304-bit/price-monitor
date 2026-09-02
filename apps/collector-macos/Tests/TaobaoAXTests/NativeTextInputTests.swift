import XCTest
@testable import TaobaoAX

final class NativeTextInputTests: XCTestCase {
    func testActivationWaitsForTheExactProcess() throws {
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

    func testReplacementSelectsAllUtf16TextAndPostsUnicodeToTaobao() throws {
        let field = TestSearchTextField(
            role: "AXTextField",
            description: "请输入搜索文字",
            enabled: true,
            existingValue: "旧查询"
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
        XCTAssertEqual(field.selectedRanges.count, 1)
        XCTAssertEqual(field.selectedRanges[0].location, 0)
        XCTAssertEqual(field.selectedRanges[0].length, 3)
        XCTAssertEqual(poster.posts, [.init(pid: 321, text: "RME Babyface Pro FS")])
    }

    func testReplacementPreservesChineseUnicode() throws {
        let field = TestSearchTextField()
        let poster = RecordingUnicodeTextPoster()

        try NativeSearchTextInput(poster: poster).replace(
            field: field,
            processIdentifier: 321,
            value: "声卡 直播",
            isFrontmost: { true }
        )

        XCTAssertEqual(poster.posts, [.init(pid: 321, text: "声卡 直播")])
    }

    func testReplacementCountsEmojiAsTwoUtf16CodeUnitsAtTheLimit() throws {
        let value = String(repeating: "a", count: 2_046) + "😀"
        let field = TestSearchTextField()
        let poster = RecordingUnicodeTextPoster()

        try NativeSearchTextInput(poster: poster).replace(
            field: field,
            processIdentifier: 321,
            value: value,
            isFrontmost: { true }
        )

        XCTAssertEqual(poster.posts, [.init(pid: 321, text: value)])
    }

    func testReplacementRejectsInvalidTargetsAndValuesBeforePosting() {
        struct InvalidCase {
            let name: String
            let value: String
            let configure: (TestSearchTextField) -> Void
        }

        let cases = [
            InvalidCase(name: "wrong role", value: "query", configure: { $0.role = "AXButton" }),
            InvalidCase(name: "wrong description", value: "query", configure: { $0.description = "搜索" }),
            InvalidCase(name: "disabled", value: "query", configure: { $0.enabled = false }),
            InvalidCase(name: "value not settable", value: "query", configure: {
                $0.settable["AXValue"] = false
            }),
            InvalidCase(name: "focus not settable", value: "query", configure: {
                $0.settable["AXFocused"] = false
            }),
            InvalidCase(name: "selection not settable", value: "query", configure: {
                $0.settable["AXSelectedTextRange"] = false
            }),
            InvalidCase(name: "empty", value: "", configure: { _ in }),
            InvalidCase(name: "2049 utf16 code units", value: String(repeating: "a", count: 2_047) + "😀", configure: { _ in }),
            InvalidCase(name: "whitespace only", value: " \n\t ", configure: { _ in }),
        ]

        for testCase in cases {
            let field = TestSearchTextField()
            testCase.configure(field)
            let poster = RecordingUnicodeTextPoster()

            XCTAssertThrowsError(
                try NativeSearchTextInput(poster: poster).replace(
                    field: field,
                    processIdentifier: 321,
                    value: testCase.value,
                    isFrontmost: { true }
                ),
                testCase.name
            ) { error in
                XCTAssertEqual((error as? HelperError)?.code, "INVALID_TEXT_TARGET", testCase.name)
            }
            XCTAssertTrue(poster.posts.isEmpty, testCase.name)
        }
    }

    func testReplacementMapsFocusAndSelectionFailuresWithoutPosting() {
        let focusField = TestSearchTextField(focusError: TestError.failed)
        let selectionField = TestSearchTextField(selectionError: TestError.failed)

        for field in [focusField, selectionField] {
            let poster = RecordingUnicodeTextPoster()

            XCTAssertThrowsError(
                try NativeSearchTextInput(poster: poster).replace(
                    field: field,
                    processIdentifier: 321,
                    value: "query",
                    isFrontmost: { true }
                )
            ) { error in
                XCTAssertEqual((error as? HelperError)?.code, "TEXT_SELECTION_FAILED")
            }
            XCTAssertTrue(poster.posts.isEmpty)
        }
    }

    func testReplacementRejectsAFieldThatIsNoLongerFrontmostBeforePosting() {
        let field = TestSearchTextField()
        let poster = RecordingUnicodeTextPoster()

        XCTAssertThrowsError(
            try NativeSearchTextInput(poster: poster).replace(
                field: field,
                processIdentifier: 321,
                value: "query",
                isFrontmost: { false }
            )
        ) { error in
            XCTAssertEqual((error as? HelperError)?.code, "INVALID_TEXT_TARGET")
        }
        XCTAssertTrue(poster.posts.isEmpty)
    }

    func testReplacementMapsUnicodePostingFailureWithoutPostingARecordedEvent() {
        let field = TestSearchTextField()
        let poster = RecordingUnicodeTextPoster(postError: TestError.failed)

        XCTAssertThrowsError(
            try NativeSearchTextInput(poster: poster).replace(
                field: field,
                processIdentifier: 321,
                value: "query",
                isFrontmost: { true }
            )
        ) { error in
            XCTAssertEqual((error as? HelperError)?.code, "TEXT_EVENT_FAILED")
        }
        XCTAssertTrue(poster.posts.isEmpty)
    }
}

private enum TestError: Error {
    case failed
}

private final class TestSearchTextField: SearchTextFieldEditing {
    var role: String
    var description: String
    var enabled: Bool
    var existingValue: String
    var settable: [String: Bool]
    var focusRequests = 0
    var selectedRanges: [CFRange] = []
    let focusError: Error?
    let selectionError: Error?

    init(
        role: String = "AXTextField",
        description: String = "请输入搜索文字",
        enabled: Bool = true,
        existingValue: String = "旧查询",
        settable: [String: Bool] = [
            "AXValue": true,
            "AXFocused": true,
            "AXSelectedTextRange": true,
        ],
        focusError: Error? = nil,
        selectionError: Error? = nil
    ) {
        self.role = role
        self.description = description
        self.enabled = enabled
        self.existingValue = existingValue
        self.settable = settable
        self.focusError = focusError
        self.selectionError = selectionError
    }

    func value(for attribute: String) throws -> Any? {
        switch attribute {
        case "AXRole": return role
        case "AXDescription": return description
        case "AXEnabled": return enabled
        case "AXValue": return existingValue
        default: return nil
        }
    }

    func isAttributeSettable(_ attribute: String) throws -> Bool {
        settable[attribute] ?? false
    }

    func setFocused() throws {
        if let focusError { throw focusError }
        focusRequests += 1
    }

    func selectText(range: CFRange) throws {
        if let selectionError { throw selectionError }
        selectedRanges.append(range)
    }
}

private final class RecordingUnicodeTextPoster: UnicodeTextPosting {
    struct Post: Equatable {
        let pid: pid_t
        let text: String
    }

    private(set) var posts: [Post] = []
    let postError: Error?

    init(postError: Error? = nil) {
        self.postError = postError
    }

    func post(text: String, to processIdentifier: pid_t) throws {
        if let postError { throw postError }
        posts.append(Post(pid: processIdentifier, text: text))
    }
}
