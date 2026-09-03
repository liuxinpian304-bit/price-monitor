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
}
