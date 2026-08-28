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
