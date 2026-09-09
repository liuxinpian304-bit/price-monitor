import XCTest
@testable import TaobaoAX

final class ProtocolTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    func testCommandRoundTripsAllFields() throws {
        let input = """
        {"id":"command-1","command":"perform","bundleId":"com.taobao.pcdesktop","nodePath":[1,3],"action":"AXPress","value":"selected","keyCode":36,"destination":"evidence/window.png","fingerprint":{"role":"AXButton","title":"Share","identifier":"share"}}
        """

        let command = try decoder.decode(HelperCommand.self, from: Data(input.utf8))

        XCTAssertEqual(
            command,
            HelperCommand(
                id: "command-1",
                command: .perform,
                bundleId: "com.taobao.pcdesktop",
                nodePath: [1, 3],
                action: "AXPress",
                value: "selected",
                keyCode: 36,
                destination: "evidence/window.png",
                fingerprint: AXNodeFingerprint(role: "AXButton", title: "Share", identifier: "share")
            )
        )
        XCTAssertEqual(try decoder.decode(HelperCommand.self, from: encoder.encode(command)), command)
    }

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

    func testPressSkuOptionCommandDecodesRequiredTargetFields() throws {
        let command = try decoder.decode(HelperCommand.self, from: Data(
            #"{"id":"sku-press-1","command":"pressSkuOption","bundleId":"com.taobao.pcdesktop","nodePath":[4,2],"value":"Fixture Blue","fingerprint":{"role":"AXGroup","domClassList":["valueItem--fixture"]}}"#.utf8
        ))

        XCTAssertEqual(command.command, .pressSkuOption)
        XCTAssertEqual(command.nodePath, [4, 2])
        XCTAssertEqual(command.value, "Fixture Blue")
        XCTAssertEqual(
            command.fingerprint,
            AXNodeFingerprint(
                role: "AXGroup",
                title: nil,
                identifier: nil,
                domClassList: ["valueItem--fixture"]
            )
        )
    }

    func testResponseRoundTripsEveryJSONValueShape() throws {
        let response = HelperResponse(
            id: "response-1",
            ok: true,
            payload: .object([
                "text": .string("ready"),
                "number": .number(2.5),
                "boolean": .boolean(true),
                "array": .array([.null]),
            ]),
            error: nil
        )

        XCTAssertEqual(try decoder.decode(HelperResponse.self, from: encoder.encode(response)), response)
    }

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

        let decoded = try decoder.decode(HelperError.self, from: encoder.encode(error))

        XCTAssertEqual(decoded, error)
    }

    func testHelperErrorWithoutDetailsRoundTripsWithNilDetails() throws {
        let error = HelperError(code: "INVALID_REQUEST", message: "Invalid request.")

        let decoded = try decoder.decode(HelperError.self, from: encoder.encode(error))

        XCTAssertEqual(decoded, error)
        XCTAssertNil(decoded.details)
    }

    func testUnknownCommandReturnsUnsupportedCommandWithPreservedID() {
        let response = makeProtocol().response(for: """
        {"id":"unknown-7","command":"archive","bundleId":"com.taobao.pcdesktop"}
        """)

        XCTAssertEqual(response.id, "unknown-7")
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.error?.code, "UNSUPPORTED_COMMAND")
        XCTAssertNil(response.payload)
    }

    func testMissingRequiredFieldReturnsInvalidRequestWithPreservedID() {
        let response = makeProtocol().response(for: """
        {"id":"missing-4","command":"diagnose"}
        """)

        XCTAssertEqual(response.id, "missing-4")
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.error?.code, "INVALID_REQUEST")
    }

    func testMalformedJSONUsesDeterministicSafeID() {
        let response = makeProtocol().response(for: "{\"id\":\"not-trustworthy\"")

        XCTAssertEqual(response.id, "invalid-request")
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.error?.code, "INVALID_REQUEST")
    }

    func testMalformedRequiredFieldPreservesRecoveredID() {
        let response = makeProtocol().response(for: """
        {"id":"recovered-5","command":"perform","bundleId":"com.taobao.pcdesktop","nodePath":"not-an-array"}
        """)

        XCTAssertEqual(response.id, "recovered-5")
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.error?.code, "INVALID_REQUEST")
    }

    func testProtocolOutputIsOneJSONResponseLineWithoutLogging() throws {
        let line = makeProtocol().responseLine(for: """
        {"id":"line-8","command":"snapshot","bundleId":"com.taobao.pcdesktop"}
        """)

        XCTAssertEqual(line.filter(\.isNewline).count, 1)
        XCTAssertEqual(line.last, "\n")

        let response = try decoder.decode(HelperResponse.self, from: Data(line.utf8))
        XCTAssertEqual(response.id, "line-8")
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.error?.code, "NOT_IMPLEMENTED")
    }

    func testUnexpectedHandlerFailureReturnsSanitizedInternalError() {
        let response = JSONLineProtocol(handler: FailingHandler()).response(for: """
        {"id":"failure-9","command":"diagnose","bundleId":"com.taobao.pcdesktop"}
        """)

        XCTAssertEqual(response.id, "failure-9")
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.error?.code, "INTERNAL_ERROR")
        XCTAssertEqual(response.error?.message, "Internal error.")
    }

    func testOnlyExactPromptValueCanRequestAccessibilityPrompt() {
        XCTAssertTrue(MacOSCommandHandler.shouldPrompt(for: "prompt"))
        XCTAssertFalse(MacOSCommandHandler.shouldPrompt(for: nil))
        XCTAssertFalse(MacOSCommandHandler.shouldPrompt(for: "Prompt"))
        XCTAssertFalse(MacOSCommandHandler.shouldPrompt(for: "true"))
        XCTAssertFalse(MacOSCommandHandler.shouldPrompt(for: " prompt "))
    }

    func testActivateRejectsEveryMutationFieldWithoutConstructingApplication() {
        let cases = [
            ("nodePath", #"{"nodePath":[0]}"#),
            ("value", #"{"value":"声卡 直播"}"#),
            ("fingerprint", #"{"fingerprint":{"role":"AXTextField"}}"#),
            ("action", #"{"action":"AXPress"}"#),
            ("keyCode", #"{"keyCode":36}"#),
            ("destination", #"{"destination":"evidence.png"}"#),
        ]

        for (field, mutation) in cases {
            var factoryCalls = 0
            var activationCalls = 0
            let protocolHandler = JSONLineProtocol(handler: MacOSCommandHandler(applicationFactory: { _ in
                factoryCalls += 1
                return ProtocolApplicationSpy(onActivate: { activationCalls += 1 })
            }))
            let response = protocolHandler.response(for: """
            {"id":"activate-\(field)","command":"activate","bundleId":"com.taobao.pcdesktop",\(mutation.dropFirst().dropLast())}
            """)

            XCTAssertFalse(response.ok, field)
            XCTAssertEqual(response.error?.code, "INVALID_REQUEST", field)
            XCTAssertEqual(factoryCalls, 0, field)
            XCTAssertEqual(activationCalls, 0, field)
        }
    }

    func testActivateRejectsExplicitNullMutationFieldsWithoutConstructingApplication() {
        let fields = ["nodePath", "value", "fingerprint", "action", "keyCode", "destination"]

        for field in fields {
            var factoryCalls = 0
            var activationCalls = 0
            let protocolHandler = JSONLineProtocol(handler: MacOSCommandHandler(applicationFactory: { _ in
                factoryCalls += 1
                return ProtocolApplicationSpy(onActivate: { activationCalls += 1 })
            }))
            let response = protocolHandler.response(for: """
            {"id":"activate-null-\(field)","command":"activate","bundleId":"com.taobao.pcdesktop","\(field)":null}
            """)

            XCTAssertFalse(response.ok, field)
            XCTAssertEqual(response.error?.code, "INVALID_REQUEST", field)
            XCTAssertEqual(factoryCalls, 0, field)
            XCTAssertEqual(activationCalls, 0, field)
        }
    }

    func testActivateWithoutMutationFieldsStillCallsApplication() {
        var factoryCalls = 0
        var activationCalls = 0
        let protocolHandler = JSONLineProtocol(handler: MacOSCommandHandler(applicationFactory: { _ in
            factoryCalls += 1
            return ProtocolApplicationSpy(onActivate: { activationCalls += 1 })
        }))

        let response = protocolHandler.response(for: #"{"id":"activate-ordinary","command":"activate","bundleId":"com.taobao.pcdesktop"}"#)

        XCTAssertTrue(response.ok)
        XCTAssertEqual(factoryCalls, 1)
        XCTAssertEqual(activationCalls, 1)
    }

    func testReplaceTextRejectsMissingRequiredFields() {
        let inputs = [
            #"{"id":"missing-path","command":"replaceText","bundleId":"com.taobao.pcdesktop","value":"声卡 直播","fingerprint":{"role":"AXTextField"}}"#,
            #"{"id":"missing-value","command":"replaceText","bundleId":"com.taobao.pcdesktop","nodePath":[0,1],"fingerprint":{"role":"AXTextField"}}"#,
            #"{"id":"missing-fingerprint","command":"replaceText","bundleId":"com.taobao.pcdesktop","nodePath":[0,1],"value":"声卡 直播"}"#,
            #"{"id":"empty-fingerprint","command":"replaceText","bundleId":"com.taobao.pcdesktop","nodePath":[0,1],"value":"声卡 直播","fingerprint":{}}"#,
        ]
        let protocolHandler = JSONLineProtocol(handler: MacOSCommandHandler(applicationFactory: { _ in
            ProtocolApplicationSpy()
        }))

        for input in inputs {
            let response = protocolHandler.response(for: input)
            XCTAssertFalse(response.ok)
            XCTAssertEqual(response.error?.code, "INVALID_REQUEST")
        }
    }

    func testReplaceTextReturnsOnlyTypedAcknowledgement() {
        let query = "声卡 直播"
        let response = JSONLineProtocol(handler: MacOSCommandHandler(applicationFactory: { _ in
            ProtocolApplicationSpy()
        })).response(for: #"{"id":"replace-success","command":"replaceText","bundleId":"com.taobao.pcdesktop","nodePath":[0,1],"value":"声卡 直播","fingerprint":{"role":"AXTextField"}}"#)

        XCTAssertTrue(response.ok)
        XCTAssertEqual(response.payload, .object(["typed": .boolean(true)]))
        XCTAssertNotEqual(response.payload, .object(["typed": .string(query)]))
    }

    func testPressSkuOptionRejectsMissingRequiredFields() {
        let inputs = [
            #"{"id":"missing-path","command":"pressSkuOption","bundleId":"com.taobao.pcdesktop","value":"Fixture Blue","fingerprint":{"role":"AXGroup","domClassList":["valueItem--fixture"]}}"#,
            #"{"id":"missing-value","command":"pressSkuOption","bundleId":"com.taobao.pcdesktop","nodePath":[4,2],"fingerprint":{"role":"AXGroup","domClassList":["valueItem--fixture"]}}"#,
            #"{"id":"missing-fingerprint","command":"pressSkuOption","bundleId":"com.taobao.pcdesktop","nodePath":[4,2],"value":"Fixture Blue"}"#,
        ]
        let protocolHandler = JSONLineProtocol(handler: MacOSCommandHandler(applicationFactory: { _ in
            ProtocolApplicationSpy()
        }))

        for input in inputs {
            let response = protocolHandler.response(for: input)
            XCTAssertFalse(response.ok, input)
            XCTAssertEqual(response.error?.code, "INVALID_REQUEST", input)
        }
    }

    func testPressSkuOptionRejectsWeakFingerprintsBeforeConstructingApplication() {
        let fingerprints = [
            #"{}"#,
            #"{"role":"AXGroup"}"#,
            #"{"role":"AXGroup","domClassList":[]}"#,
            #"{"domClassList":["valueItem--fixture"]}"#,
            #"{"role":"AXGroup","domClassList":["valueItem--fixture","valueItem--fixture"]}"#,
            #"{"role":"AXGroup","domClassList":["valueItem--fixture","isSelected--fixture","isSelected--fixture"]}"#,
        ]

        for fingerprint in fingerprints {
            var factoryCalls = 0
            let protocolHandler = JSONLineProtocol(handler: MacOSCommandHandler(applicationFactory: { _ in
                factoryCalls += 1
                return ProtocolApplicationSpy()
            }))

            let response = protocolHandler.response(for: """
            {"id":"weak-fingerprint","command":"pressSkuOption","bundleId":"com.taobao.pcdesktop","nodePath":[4,2],"value":"Fixture Blue","fingerprint":\(fingerprint)}
            """)

            XCTAssertFalse(response.ok, fingerprint)
            XCTAssertEqual(response.error?.code, "SKU_OPTION_GUARD_FAILED", fingerprint)
            XCTAssertEqual(factoryCalls, 0, fingerprint)
        }
    }

    func testPressSkuOptionRejectsAnyExtraFieldsBeforeConstructingApplication() {
        let extras = [
            #""action":"AXPress""#,
            #""keyCode":36"#,
            #""destination":"evidence.png""#,
            #""unknown":true"#,
            #""action":null"#,
            #""unknown":null"#,
        ]

        for extra in extras {
            var factoryCalls = 0
            let protocolHandler = JSONLineProtocol(handler: MacOSCommandHandler(applicationFactory: { _ in
                factoryCalls += 1
                return ProtocolApplicationSpy()
            }))

            let response = protocolHandler.response(for: """
            {"id":"extra-field","command":"pressSkuOption","bundleId":"com.taobao.pcdesktop","nodePath":[4,2],"value":"Fixture Blue","fingerprint":{"role":"AXGroup","domClassList":["valueItem--fixture"]},\(extra)}
            """)

            XCTAssertFalse(response.ok, extra)
            XCTAssertEqual(response.error?.code, "INVALID_REQUEST", extra)
            XCTAssertEqual(factoryCalls, 0, extra)
        }
    }

    private func makeProtocol() -> JSONLineProtocol {
        JSONLineProtocol(handler: NotImplementedHandler())
    }
}

private final class ProtocolApplicationSpy: AccessibilityApplicationHandling {
    private let onActivate: () -> Void

    init(onActivate: @escaping () -> Void = {}) {
        self.onActivate = onActivate
    }

    func diagnose(prompt: Bool) throws -> JSONValue { try unexpected() }
    func snapshot() throws -> JSONValue { try unexpected() }
    func perform(path: [Int], action: String, fingerprint: AXNodeFingerprint?) throws -> JSONValue { try unexpected() }
    func setValue(path: [Int], value: String, fingerprint: AXNodeFingerprint?) throws -> JSONValue { try unexpected() }
    func activate() throws -> JSONValue {
        onActivate()
        return .object(["activated": .boolean(true)])
    }
    func replaceText(path: [Int], value: String, fingerprint: AXNodeFingerprint) throws -> JSONValue {
        .object(["typed": .boolean(true)])
    }
    func pressSkuOption(path: [Int], expectedLabel: String, fingerprint: AXNodeFingerprint) throws -> JSONValue {
        .object(["performed": .boolean(true)])
    }
    func keyPress(keyCode: Int) throws -> JSONValue { try unexpected() }
    func captureCopiedText(path: [Int], action: String, fingerprint: AXNodeFingerprint?) throws -> JSONValue {
        try unexpected()
    }
    func runningProcessIdentifier() throws -> pid_t { try unexpected() }

    private func unexpected<T>() throws -> T {
        throw HelperError(code: "UNEXPECTED_COMMAND", message: "Unexpected command.")
    }
}

private struct NotImplementedHandler: CommandHandling {
    func handle(_ command: HelperCommand) throws -> JSONValue? {
        throw HelperError(code: "NOT_IMPLEMENTED", message: "Command is not implemented.")
    }
}

private struct FailingHandler: CommandHandling {
    func handle(_ command: HelperCommand) throws -> JSONValue? {
        throw TestFailure.unexpected
    }
}

private enum TestFailure: Error {
    case unexpected
}
