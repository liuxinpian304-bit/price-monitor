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
}

struct AXNodeFingerprint: Codable, Equatable {
    let role: String?
    let title: String?
    let identifier: String?
}
