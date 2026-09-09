import Foundation
import Dispatch

enum AXAttribute {
    static let focusedWindow = "AXFocusedWindow"
    static let mainWindow = "AXMainWindow"
    static let role = "AXRole"
    static let subrole = "AXSubrole"
    static let identifier = "AXIdentifier"
    static let title = "AXTitle"
    static let description = "AXDescription"
    static let value = "AXValue"
    static let url = "AXURL"
    static let enabled = "AXEnabled"
    static let selected = "AXSelected"
    static let position = "AXPosition"
    static let size = "AXSize"
    static let domClassList = "AXDOMClassList"

    static let allowed = [
        role, subrole, identifier, title, description, value, url, enabled, selected, position, size, domClassList,
    ]
}

enum AXAttributeSanitizer {
    private static let sensitiveTerms = ["cookie", "token", "authorization", "webhook"]

    static func text(attribute: String, value: String) -> String? {
        let candidate = "\(attribute)\n\(value)".lowercased()
        guard !sensitiveTerms.contains(where: candidate.contains) else {
            return nil
        }
        return value
    }
}

protocol AXElementReading: AnyObject {
    func value(for attribute: String) throws -> Any?
    func referencedElement(for attribute: String) throws -> (any AXElementReading)?
    func actionNames() throws -> [String]
    func childElements() throws -> [any AXElementReading]
    func isSameElement(as other: any AXElementReading) -> Bool
}

enum AXRootScope: String, Codable, Equatable {
    case focusedWindow
    case mainWindow
}

struct AXScopedRoot {
    let element: any AXElementReading
    let scope: AXRootScope
}

struct AXScopedRootResolver {
    func resolve(applicationRoot: any AXElementReading) throws -> AXScopedRoot {
        if let focused = try applicationRoot.referencedElement(for: AXAttribute.focusedWindow) {
            return AXScopedRoot(element: focused, scope: .focusedWindow)
        }
        if let main = try applicationRoot.referencedElement(for: AXAttribute.mainWindow) {
            return AXScopedRoot(element: main, scope: .mainWindow)
        }
        throw HelperError(
            code: "FRONT_WINDOW_NOT_AVAILABLE",
            message: "A focused or main application window is required."
        )
    }
}

struct AXTreeLimits: Equatable {
    static let standard = AXTreeLimits(
        maxNodeCount: 4_000,
        maxDepth: 28,
        maxDurationNanoseconds: 6_000_000_000,
        maxEncodedBytes: 8 * 1_024 * 1_024
    )

    let maxNodeCount: Int
    let maxDepth: Int
    let maxDurationNanoseconds: UInt64
    let maxEncodedBytes: Int
}

struct AXTreeSerialization: Equatable {
    let node: AXNode
    let visitedNodeCount: Int
    let maximumDepth: Int
    let elapsedMilliseconds: Int
}

struct AXTreeSerializer {
    let limits: AXTreeLimits
    let nowNanoseconds: () -> UInt64

    init(
        limits: AXTreeLimits = .standard,
        nowNanoseconds: @escaping () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }
    ) {
        self.limits = limits
        self.nowNanoseconds = nowNanoseconds
    }

    func serialize(
        root: any AXElementReading,
        scope: AXRootScope
    ) throws -> AXTreeSerialization {
        if limits.maxNodeCount <= 0 {
            throw axTreeLimitError(
                reason: "nodeCount",
                scope: scope,
                visitedNodeCount: 0,
                maximumDepth: 0,
                elapsedMilliseconds: 0
            )
        }
        if limits.maxDepth <= 0 {
            throw axTreeLimitError(
                reason: "depth",
                scope: scope,
                visitedNodeCount: 0,
                maximumDepth: 0,
                elapsedMilliseconds: 0
            )
        }
        if limits.maxDurationNanoseconds == 0 {
            throw axTreeLimitError(
                reason: "duration",
                scope: scope,
                visitedNodeCount: 0,
                maximumDepth: 0,
                elapsedMilliseconds: 0
            )
        }
        if limits.maxEncodedBytes <= 0 {
            throw axTreeLimitError(
                reason: "encodedBytes",
                scope: scope,
                visitedNodeCount: 0,
                maximumDepth: 0,
                elapsedMilliseconds: 0
            )
        }

        let startedAt = nowNanoseconds()
        var visitedNodeCount = 0
        var maximumDepth = 0
        let node = try serialize(
            element: root,
            path: [],
            depth: 0,
            ancestors: [],
            scope: scope,
            startedAt: startedAt,
            visitedNodeCount: &visitedNodeCount,
            maximumDepth: &maximumDepth
        )
        let elapsedNanoseconds = elapsedNanoseconds(since: startedAt)
        let elapsedMilliseconds = milliseconds(from: elapsedNanoseconds)
        guard elapsedNanoseconds <= limits.maxDurationNanoseconds else {
            throw axTreeLimitError(
                reason: "duration",
                scope: scope,
                visitedNodeCount: visitedNodeCount,
                maximumDepth: maximumDepth,
                elapsedMilliseconds: elapsedMilliseconds
            )
        }
        return AXTreeSerialization(
            node: node,
            visitedNodeCount: visitedNodeCount,
            maximumDepth: maximumDepth,
            elapsedMilliseconds: elapsedMilliseconds
        )
    }

    private func serialize(
        element: any AXElementReading,
        path: [Int],
        depth: Int,
        ancestors: [any AXElementReading],
        scope: AXRootScope,
        startedAt: UInt64,
        visitedNodeCount: inout Int,
        maximumDepth: inout Int
    ) throws -> AXNode {
        maximumDepth = max(maximumDepth, depth)
        let elapsedNanoseconds = elapsedNanoseconds(since: startedAt)
        let elapsedMilliseconds = milliseconds(from: elapsedNanoseconds)
        guard elapsedNanoseconds <= limits.maxDurationNanoseconds else {
            throw axTreeLimitError(
                reason: "duration",
                scope: scope,
                visitedNodeCount: visitedNodeCount,
                maximumDepth: maximumDepth,
                elapsedMilliseconds: elapsedMilliseconds
            )
        }
        guard depth <= limits.maxDepth else {
            throw axTreeLimitError(
                reason: "depth",
                scope: scope,
                visitedNodeCount: visitedNodeCount,
                maximumDepth: maximumDepth,
                elapsedMilliseconds: elapsedMilliseconds
            )
        }

        visitedNodeCount += 1
        guard visitedNodeCount <= limits.maxNodeCount else {
            throw axTreeLimitError(
                reason: "nodeCount",
                scope: scope,
                visitedNodeCount: visitedNodeCount,
                maximumDepth: maximumDepth,
                elapsedMilliseconds: elapsedMilliseconds
            )
        }

        var attributes: [String: Any] = [:]
        for name in AXAttribute.allowed {
            if let value = try element.value(for: name) {
                attributes[name] = value
            }
        }

        let childElements = try element.childElements()
        let nextAncestors = ancestors + [element]
        var children: [AXNode] = []
        children.reserveCapacity(childElements.count)

        for (index, child) in childElements.enumerated() {
            if nextAncestors.contains(where: { $0.isSameElement(as: child) }) {
                continue
            }
            children.append(try serialize(
                element: child,
                path: path + [index],
                depth: depth + 1,
                ancestors: nextAncestors,
                scope: scope,
                startedAt: startedAt,
                visitedNodeCount: &visitedNodeCount,
                maximumDepth: &maximumDepth
            ))
        }

        return AXNode(
            path: path,
            role: safeString(attributes[AXAttribute.role], attribute: AXAttribute.role),
            subrole: safeString(attributes[AXAttribute.subrole], attribute: AXAttribute.subrole),
            identifier: safeString(attributes[AXAttribute.identifier], attribute: AXAttribute.identifier),
            title: safeString(attributes[AXAttribute.title], attribute: AXAttribute.title),
            description: safeString(attributes[AXAttribute.description], attribute: AXAttribute.description),
            value: safeJSONValue(attributes[AXAttribute.value], attribute: AXAttribute.value),
            url: safeURL(attributes[AXAttribute.url]),
            enabled: bool(attributes[AXAttribute.enabled]),
            selected: bool(attributes[AXAttribute.selected]),
            position: attributes[AXAttribute.position] as? AXPoint,
            size: attributes[AXAttribute.size] as? AXSize,
            actions: try element.actionNames()
                .compactMap { AXAttributeSanitizer.text(attribute: "AXActions", value: $0) }
                .sorted(),
            children: children,
            domClassList: safeDOMClassList(attributes[AXAttribute.domClassList])
        )
    }

    private func safeString(_ value: Any?, attribute: String) -> String? {
        guard let value = value as? String else { return nil }
        return AXAttributeSanitizer.text(attribute: attribute, value: value)
    }

    private func safeDOMClassList(_ value: Any?) -> [String]? {
        guard let values = value as? [String] else { return nil }
        let safeValues = Set(values.compactMap {
            AXAttributeSanitizer.text(attribute: AXAttribute.domClassList, value: $0)
        }.filter { !$0.isEmpty })
        return safeValues.isEmpty ? nil : safeValues.sorted()
    }

    private func safeURL(_ value: Any?) -> String? {
        let string: String?
        if let value = value as? URL {
            string = value.absoluteString
        } else {
            string = value as? String
        }
        guard let string else { return nil }
        return AXAttributeSanitizer.text(attribute: AXAttribute.url, value: string)
    }

    private func safeJSONValue(_ value: Any?, attribute: String) -> JSONValue? {
        guard let value else { return nil }

        if let value = value as? String {
            guard let safe = AXAttributeSanitizer.text(attribute: attribute, value: value) else {
                return .null
            }
            return .string(safe)
        }
        if let value = value as? Bool {
            return .boolean(value)
        }
        if let value = value as? NSNumber {
            return .number(value.doubleValue)
        }
        if let value = value as? URL,
           let safe = AXAttributeSanitizer.text(attribute: attribute, value: value.absoluteString) {
            return .string(safe)
        }
        return .null
    }

    private func bool(_ value: Any?) -> Bool? {
        if let value = value as? Bool {
            return value
        }
        return (value as? NSNumber)?.boolValue
    }

    private func elapsedNanoseconds(since startedAt: UInt64) -> UInt64 {
        let current = nowNanoseconds()
        return current >= startedAt ? current - startedAt : 0
    }

    private func milliseconds(from nanoseconds: UInt64) -> Int {
        let value = nanoseconds / 1_000_000
        return value > UInt64(Int.max) ? Int.max : Int(value)
    }
}

func axTreeLimitError(
    reason: String,
    scope: AXRootScope,
    visitedNodeCount: Int,
    maximumDepth: Int,
    elapsedMilliseconds: Int,
    encodedBytes: Int? = nil
) -> HelperError {
    var details: [String: JSONValue] = [
        "reason": .string(reason),
        "scope": .string(scope.rawValue),
        "visitedNodeCount": .number(Double(visitedNodeCount)),
        "maximumDepth": .number(Double(maximumDepth)),
        "elapsedMilliseconds": .number(Double(elapsedMilliseconds)),
    ]
    if let encodedBytes {
        details["encodedBytes"] = .number(Double(encodedBytes))
    }
    return HelperError(
        code: "TREE_LIMIT_REACHED",
        message: "Accessibility tree limit reached.",
        details: .object(details)
    )
}

struct AXSnapshotEncoder {
    func encode(
        _ serialization: AXTreeSerialization,
        scope: AXRootScope,
        limits: AXTreeLimits
    ) throws -> JSONValue {
        let data = try JSONEncoder().encode(serialization.node)
        guard data.count <= limits.maxEncodedBytes else {
            throw axTreeLimitError(
                reason: "encodedBytes",
                scope: scope,
                visitedNodeCount: serialization.visitedNodeCount,
                maximumDepth: serialization.maximumDepth,
                elapsedMilliseconds: serialization.elapsedMilliseconds,
                encodedBytes: data.count
            )
        }
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }
}
