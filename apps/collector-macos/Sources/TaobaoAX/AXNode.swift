import Foundation

struct AXPoint: Codable, Equatable {
    let x: Double
    let y: Double
}

struct AXSize: Codable, Equatable {
    let width: Double
    let height: Double
}

struct AXNode: Codable, Equatable {
    let path: [Int]
    let role: String?
    let subrole: String?
    let identifier: String?
    let title: String?
    let description: String?
    let value: JSONValue?
    let url: String?
    let enabled: Bool?
    let selected: Bool?
    let position: AXPoint?
    let size: AXSize?
    let actions: [String]
    let children: [AXNode]
    let domClassList: [String]?

    init(
        path: [Int],
        role: String?,
        subrole: String?,
        identifier: String?,
        title: String?,
        description: String?,
        value: JSONValue?,
        url: String?,
        enabled: Bool?,
        selected: Bool?,
        position: AXPoint?,
        size: AXSize?,
        actions: [String],
        children: [AXNode],
        domClassList: [String]? = nil
    ) {
        self.path = path
        self.role = role
        self.subrole = subrole
        self.identifier = identifier
        self.title = title
        self.description = description
        self.value = value
        self.url = url
        self.enabled = enabled
        self.selected = selected
        self.position = position
        self.size = size
        self.actions = actions
        self.children = children
        self.domClassList = domClassList
    }
}

struct AXNodeFingerprint: Codable, Equatable {
    let role: String?
    let title: String?
    let identifier: String?
    let domClassList: [String]?

    init(
        role: String?,
        title: String?,
        identifier: String?,
        domClassList: [String]? = nil
    ) {
        self.role = role
        self.title = title
        self.identifier = identifier
        self.domClassList = domClassList
    }
}

struct SkuOptionPressEvidence: Equatable {
    let role: String?
    let title: String?
    let identifier: String?
    let domClassList: [String]?
    let descendantTexts: [String]
}

enum SkuOptionPressGuard {
    static func validateRequest(
        expectedLabel: String,
        fingerprint: AXNodeFingerprint
    ) throws -> String {
        let normalizedExpectedLabel = normalizedLabel(expectedLabel)
        guard !normalizedExpectedLabel.isEmpty else {
            throw HelperError(code: "INVALID_REQUEST", message: "Invalid request.")
        }
        guard fingerprint.role == "AXGroup",
              let fingerprintClasses = fingerprint.domClassList,
              !fingerprintClasses.isEmpty,
              !hasDuplicateClasses(fingerprintClasses),
              valueItemClassCount(in: fingerprintClasses) == 1 else {
            throw guardFailure()
        }
        return normalizedExpectedLabel
    }

    static func validate(
        evidence: SkuOptionPressEvidence,
        expectedLabel: String,
        fingerprint: AXNodeFingerprint
    ) throws -> String {
        let normalizedExpectedLabel = try validateRequest(
            expectedLabel: expectedLabel,
            fingerprint: fingerprint
        )

        guard let evidenceClasses = evidence.domClassList,
              !hasDuplicateClasses(evidenceClasses) else {
            throw guardFailure()
        }
        let currentClasses = normalizedClasses(evidenceClasses)
        let fingerprintMatches = (fingerprint.role == nil || fingerprint.role == evidence.role)
            && (fingerprint.title == nil || fingerprint.title == evidence.title)
            && (fingerprint.identifier == nil || fingerprint.identifier == evidence.identifier)
            && (fingerprint.domClassList == nil
                || normalizedClasses(fingerprint.domClassList) == currentClasses)
        guard fingerprintMatches else {
            throw HelperError(
                code: "NODE_FINGERPRINT_MISMATCH",
                message: "Accessibility node fingerprint changed."
            )
        }

        guard evidence.role == "AXGroup",
              let currentClasses,
              valueItemClassCount(in: evidenceClasses) == 1,
              !currentClasses.contains(where: isDisabledClass) else {
            throw guardFailure()
        }

        let matchingLabels = evidence.descendantTexts
            .map(normalizedLabel)
            .filter { $0 == normalizedExpectedLabel }
        guard matchingLabels.count == 1 else { throw guardFailure() }
        return normalizedExpectedLabel
    }

    static func normalizedLabel(_ value: String) -> String {
        value.components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    private static func normalizedClasses(_ values: [String]?) -> [String]? {
        guard let values else { return nil }
        return Array(Set(values)).sorted()
    }

    private static func valueItemClassCount(in values: [String]?) -> Int {
        values?.filter { $0.hasPrefix("valueItem--") }.count ?? 0
    }

    private static func hasDuplicateClasses(_ values: [String]) -> Bool {
        Set(values).count != values.count
    }

    private static func isDisabledClass(_ value: String) -> Bool {
        let lowercase = value.lowercased()
        if lowercase.contains("disabled") || lowercase.contains("unavailable") {
            return true
        }
        guard let expression = try? NSRegularExpression(pattern: "sold.?out") else {
            return true
        }
        let range = NSRange(lowercase.startIndex..<lowercase.endIndex, in: lowercase)
        return expression.firstMatch(in: lowercase, range: range) != nil
    }

    private static func guardFailure() -> HelperError {
        HelperError(
            code: "SKU_OPTION_GUARD_FAILED",
            message: "SKU option did not satisfy required accessibility guards."
        )
    }
}
