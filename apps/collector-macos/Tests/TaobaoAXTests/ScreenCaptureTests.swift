import XCTest
@testable import TaobaoAX

final class ScreenCaptureTests: XCTestCase {
    func testPreflightDoesNotRequireAnEvidenceDestinationOrWriteConfiguration() {
        var calls = 0
        let capture = ScreenCapture(environment: [:]) {
            calls += 1
            return false
        }

        XCTAssertFalse(capture.preflightAccess())
        XCTAssertEqual(calls, 1)
    }
}
