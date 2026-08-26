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

    private func makeProtocol() -> JSONLineProtocol {
        JSONLineProtocol(handler: NotImplementedHandler())
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
