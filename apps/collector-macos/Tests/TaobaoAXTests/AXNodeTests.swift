import Foundation
import XCTest
@testable import TaobaoAX

final class AXNodeTests: XCTestCase {
    func testNodeEncodesOnlyTheSemanticAllowlist() throws {
        let node = AXNode(
            path: [0, 2],
            role: "AXButton",
            subrole: "AXCloseButton",
            identifier: "share",
            title: "Copy link",
            description: "Copies the item link",
            value: .string("ready"),
            url: "https://example.invalid/item?id=1",
            enabled: true,
            selected: false,
            position: AXPoint(x: 12, y: 24),
            size: AXSize(width: 120, height: 40),
            actions: ["AXPress"],
            children: []
        )

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(node)) as? [String: Any]
        )

        XCTAssertEqual(Set(object.keys), Set([
            "path", "role", "subrole", "identifier", "title", "description", "value", "url",
            "enabled", "selected", "position", "size", "actions", "children",
        ]))
    }

    func testSerializerReadsOnlyAllowedAttributesAndPreservesChildOrder() throws {
        let first = TestAXElement(attributes: [AXAttribute.role: "AXButton", AXAttribute.title: "First"])
        let second = TestAXElement(attributes: [AXAttribute.role: "AXButton", AXAttribute.title: "Second"])
        let root = TestAXElement(
            attributes: [AXAttribute.role: "AXWindow", AXAttribute.title: "Results"],
            actions: ["AXRaise", "AXPress"],
            children: [first, second]
        )

        let serializer = AXTreeSerializer(maxNodeCount: 10, maxDepth: 4)
        let firstResult = try serializer.serialize(root: root)
        let secondResult = try serializer.serialize(root: root)

        XCTAssertEqual(firstResult, secondResult)
        XCTAssertEqual(firstResult.children.map(\.title), ["First", "Second"])
        XCTAssertEqual(firstResult.children.map(\.path), [[0], [1]])
        XCTAssertEqual(firstResult.actions, ["AXPress", "AXRaise"])
        XCTAssertEqual(Set(root.requestedAttributes), Set(AXAttribute.allowed))
        XCTAssertFalse(root.requestedAttributes.contains("AXCookies"))
    }

    func testSensitiveAttributeNamesAndValuesAreRedacted() throws {
        XCTAssertNil(AXAttributeSanitizer.text(attribute: "AXAuthorization", value: "Basic secret"))
        XCTAssertNil(AXAttributeSanitizer.text(attribute: AXAttribute.title, value: "webhook secret"))

        let root = TestAXElement(attributes: [
            AXAttribute.role: "AXStaticText",
            AXAttribute.title: "token=private",
            AXAttribute.description: "Cookie: private",
            AXAttribute.value: "authorization bearer private",
            AXAttribute.url: "https://example.invalid/?webhook=private",
        ])

        let node = try AXTreeSerializer().serialize(root: root)
        let encoded = String(decoding: try JSONEncoder().encode(node), as: UTF8.self).lowercased()

        for sensitiveText in ["token", "cookie", "authorization", "webhook", "private"] {
            XCTAssertFalse(encoded.contains(sensitiveText))
        }
        XCTAssertNil(node.title)
        XCTAssertNil(node.description)
        XCTAssertEqual(node.value, .null)
        XCTAssertNil(node.url)
    }

    func testUnsupportedAXValueIsRepresentedAsNull() throws {
        let root = TestAXElement(attributes: [AXAttribute.value: Date(timeIntervalSince1970: 0)])

        XCTAssertEqual(try AXTreeSerializer().serialize(root: root).value, .null)
    }

    func testCycleIsSkippedWithoutChangingStableSiblingPaths() throws {
        let root = TestAXElement(attributes: [AXAttribute.role: "AXWindow"])
        let cyclicChild = TestAXElement(attributes: [AXAttribute.title: "Cycle"])
        let sibling = TestAXElement(attributes: [AXAttribute.title: "Sibling"])
        root.children = [cyclicChild, sibling]
        cyclicChild.children = [root]

        let node = try AXTreeSerializer().serialize(root: root)

        XCTAssertEqual(node.children.count, 2)
        XCTAssertEqual(node.children[0].path, [0])
        XCTAssertTrue(node.children[0].children.isEmpty)
        XCTAssertEqual(node.children[1].path, [1])
    }

    func testNodeLimitFailsInsteadOfReturningAPartialTree() {
        let root = TestAXElement(children: [TestAXElement(), TestAXElement()])

        assertTreeLimit(try AXTreeSerializer(maxNodeCount: 2, maxDepth: 5).serialize(root: root))
    }

    func testDepthLimitFailsInsteadOfReturningAPartialTree() {
        let grandchild = TestAXElement(attributes: [AXAttribute.title: "Too deep"])
        let child = TestAXElement(children: [grandchild])
        let root = TestAXElement(children: [child])

        assertTreeLimit(try AXTreeSerializer(maxNodeCount: 10, maxDepth: 1).serialize(root: root))
    }

    func testClipboardCaptureRestoresEveryItemAndTypeAfterSuccess() throws {
        let original = PasteboardArchive(items: [
            .init(valuesByType: [
                "public.utf8-plain-text": Data("original".utf8),
                "public.html": Data("<b>original</b>".utf8),
            ]),
            .init(valuesByType: ["public.png": Data([0, 1, 2, 3])]),
        ])
        let pasteboard = TestPasteboard(archive: original)
        let capture = ClipboardCapture(timeout: 0.1, pollInterval: 0, now: Date.init, sleep: { _ in })

        let copied = try capture.capture(using: pasteboard) {
            pasteboard.setCopiedString("https://item.taobao.com/item.htm?id=1")
        }

        XCTAssertEqual(copied, "https://item.taobao.com/item.htm?id=1")
        XCTAssertEqual(pasteboard.archive(), original)
    }

    func testClipboardCaptureRestoresEveryItemAndTypeAfterActionFailure() {
        let original = PasteboardArchive(items: [
            .init(valuesByType: ["com.example.custom": Data([9, 8, 7])]),
        ])
        let pasteboard = TestPasteboard(archive: original)
        let capture = ClipboardCapture(timeout: 0.1, pollInterval: 0, now: Date.init, sleep: { _ in })

        XCTAssertThrowsError(try capture.capture(using: pasteboard) {
            pasteboard.setCopiedString("must-not-escape")
            throw HelperError(code: "ACTION_FAILED", message: "Action failed.")
        })
        XCTAssertEqual(pasteboard.archive(), original)
    }

    func testDescriptorWriterRejectsNestedDestinationBeforeOpeningRoot() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let root = base.appendingPathComponent("root", isDirectory: true)
        let outside = base.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("safe"),
            withIntermediateDirectories: true
        )
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }

        var rootWasOpened = false
        let writer = EvidenceFileWriter(afterRootOpened: {
            rootWasOpened = true
            try FileManager.default.moveItem(
                at: root.appendingPathComponent("safe"),
                to: outside.appendingPathComponent("anchored")
            )
        })
        XCTAssertThrowsError(
            try writer.write(Data("blocked".utf8), root: root.path, destination: "safe/evidence.png")
        ) { error in
            XCTAssertEqual((error as? HelperError)?.code, "INVALID_DESTINATION")
            XCTAssertEqual((error as? HelperError)?.message, "Invalid evidence destination.")
        }
        XCTAssertFalse(rootWasOpened)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("safe").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("anchored").path))
    }

    func testDescriptorWriterUsesOnlyRootCapabilityDuringChildDirectoryRace() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let root = base.appendingPathComponent("root", isDirectory: true)
        let safe = root.appendingPathComponent("safe", isDirectory: true)
        let outside = base.appendingPathComponent("outside", isDirectory: true)
        let anchored = outside.appendingPathComponent("anchored", isDirectory: true)
        try FileManager.default.createDirectory(at: safe, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: base) }

        let writer = EvidenceFileWriter(afterRootOpened: {
            try FileManager.default.moveItem(at: safe, to: anchored)
            try FileManager.default.createSymbolicLink(at: safe, withDestinationURL: outside)
        })
        let expected = Data("root-capability".utf8)

        try writer.write(expected, root: root.path, destination: "evidence.png")

        XCTAssertEqual(
            try Data(contentsOf: root.appendingPathComponent("evidence.png")),
            expected
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: anchored.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("evidence.png").path))
    }

    func testDescriptorWriterRejectsFinalSymlink() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let root = base.appendingPathComponent("root", isDirectory: true)
        let outside = base.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("final.png"),
            withDestinationURL: outside.appendingPathComponent("escaped.png")
        )
        defer { try? FileManager.default.removeItem(at: base) }

        XCTAssertThrowsError(
            try EvidenceFileWriter().write(
                Data("blocked".utf8),
                root: root.path,
                destination: "final.png"
            )
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("escaped.png").path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["final.png"])
    }

    func testDescriptorWriterRejectsUnsafeComponentsAndSafelyReplacesRegularFile() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let writer = EvidenceFileWriter()
        let unsafeDestinations = [
            "", ".", "..", "/tmp/escape.png", "evidence.jpg", "bad\0.png",
            "a/evidence.png", "a\\evidence.png", "a//evidence.png",
            "a/./evidence.png", "a/../evidence.png",
        ]
        for destination in unsafeDestinations {
            XCTAssertThrowsError(try writer.write(Data(), root: root.path, destination: destination))
        }
        XCTAssertThrowsError(try writer.write(Data(), root: "", destination: "evidence.png"))

        let destination = root.appendingPathComponent("evidence.png")
        try Data("old".utf8).write(to: destination)
        try writer.write(Data("new".utf8), root: root.path, destination: "evidence.png")

        XCTAssertEqual(try Data(contentsOf: destination), Data("new".utf8))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["evidence.png"])
    }

    func testScreenshotCaptureRoutingSupportsEveryMacOS12And13Version() {
        XCTAssertEqual(
            ScreenshotCaptureRouting.backend(for: OperatingSystemVersion(majorVersion: 12, minorVersion: 0, patchVersion: 0)),
            .coreGraphics
        )
        XCTAssertEqual(
            ScreenshotCaptureRouting.backend(for: OperatingSystemVersion(majorVersion: 12, minorVersion: 2, patchVersion: 9)),
            .coreGraphics
        )
        XCTAssertEqual(
            ScreenshotCaptureRouting.backend(for: OperatingSystemVersion(majorVersion: 12, minorVersion: 3, patchVersion: 0)),
            .screenCaptureKitStream
        )
        XCTAssertEqual(
            ScreenshotCaptureRouting.backend(for: OperatingSystemVersion(majorVersion: 13, minorVersion: 6, patchVersion: 0)),
            .screenCaptureKitStream
        )
        XCTAssertEqual(
            ScreenshotCaptureRouting.backend(for: OperatingSystemVersion(majorVersion: 14, minorVersion: 0, patchVersion: 0)),
            .screenshotManager
        )
    }

    private func assertTreeLimit<T>(_ expression: @autoclosure () throws -> T) {
        XCTAssertThrowsError(try expression()) { error in
            XCTAssertEqual((error as? HelperError)?.code, "TREE_LIMIT_REACHED")
            XCTAssertEqual((error as? HelperError)?.message, "Accessibility tree limit reached.")
        }
    }
}

private final class TestAXElement: AXElementReading {
    let attributes: [String: Any]
    let actions: [String]
    var children: [any AXElementReading]
    private(set) var requestedAttributes: [String] = []

    init(
        attributes: [String: Any] = [:],
        actions: [String] = [],
        children: [any AXElementReading] = []
    ) {
        self.attributes = attributes
        self.actions = actions
        self.children = children
    }

    func value(for attribute: String) throws -> Any? {
        requestedAttributes.append(attribute)
        return attributes[attribute]
    }

    func actionNames() throws -> [String] {
        actions
    }

    func childElements() throws -> [any AXElementReading] {
        children
    }

    func isSameElement(as other: any AXElementReading) -> Bool {
        guard let other = other as? TestAXElement else { return false }
        return self === other
    }
}

private final class TestPasteboard: PasteboardAccessing {
    private var storedArchive: PasteboardArchive
    private(set) var changeCount = 0

    init(archive: PasteboardArchive) {
        storedArchive = archive
    }

    var utf8String: String? {
        guard let data = storedArchive.items.first?.valuesByType["public.utf8-plain-text"] else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    func archive() -> PasteboardArchive {
        storedArchive
    }

    func restore(_ archive: PasteboardArchive) {
        storedArchive = archive
        changeCount += 1
    }

    func setCopiedString(_ value: String) {
        storedArchive = PasteboardArchive(items: [
            .init(valuesByType: ["public.utf8-plain-text": Data(value.utf8)]),
        ])
        changeCount += 1
    }
}
