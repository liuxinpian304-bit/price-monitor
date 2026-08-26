import Foundation

enum AXAttribute {
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

    static let allowed = [
        role, subrole, identifier, title, description, value, url, enabled, selected, position, size,
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
    func actionNames() throws -> [String]
    func childElements() throws -> [any AXElementReading]
    func isSameElement(as other: any AXElementReading) -> Bool
}

struct AXTreeSerializer {
    static let defaultMaxNodeCount = 2_000
    static let defaultMaxDepth = 25

    let maxNodeCount: Int
    let maxDepth: Int

    init(
        maxNodeCount: Int = Self.defaultMaxNodeCount,
        maxDepth: Int = Self.defaultMaxDepth
    ) {
        self.maxNodeCount = maxNodeCount
        self.maxDepth = maxDepth
    }

    func serialize(root: any AXElementReading) throws -> AXNode {
        guard maxNodeCount > 0, maxDepth >= 0 else {
            throw treeLimitError()
        }

        var nodeCount = 0
        return try serialize(
            element: root,
            path: [],
            depth: 0,
            ancestors: [],
            nodeCount: &nodeCount
        )
    }

    private func serialize(
        element: any AXElementReading,
        path: [Int],
        depth: Int,
        ancestors: [any AXElementReading],
        nodeCount: inout Int
    ) throws -> AXNode {
        guard depth <= maxDepth else {
            throw treeLimitError()
        }

        nodeCount += 1
        guard nodeCount <= maxNodeCount else {
            throw treeLimitError()
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
                nodeCount: &nodeCount
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
            children: children
        )
    }

    private func safeString(_ value: Any?, attribute: String) -> String? {
        guard let value = value as? String else { return nil }
        return AXAttributeSanitizer.text(attribute: attribute, value: value)
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

    private func treeLimitError() -> HelperError {
        HelperError(code: "TREE_LIMIT_REACHED", message: "Accessibility tree limit reached.")
    }
}
