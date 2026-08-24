import Foundation

enum CommandName: String, Codable, Equatable {
    case diagnose
    case snapshot
    case perform
    case setValue
    case keyPress
    case captureCopiedText
    case screenshot
}

indirect enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case boolean(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value.")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        switch self {
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .boolean(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }
}

struct HelperCommand: Codable, Equatable {
    let id: String
    let command: CommandName
    let bundleId: String
    let nodePath: [Int]?
    let action: String?
    let value: String?
    let keyCode: Int?
    let destination: String?
}

struct HelperResponse: Codable, Equatable {
    let id: String
    let ok: Bool
    let payload: JSONValue?
    let error: HelperError?
}

struct HelperError: Codable, Equatable, Error {
    let code: String
    let message: String
}

protocol CommandHandling {
    func handle(_ command: HelperCommand) throws -> JSONValue?
}

struct DefaultCommandHandler: CommandHandling {
    func handle(_ command: HelperCommand) throws -> JSONValue? {
        throw HelperError(code: "NOT_IMPLEMENTED", message: "Command is not implemented.")
    }
}

struct JSONLineProtocol {
    static let safeInvalidRequestID = "invalid-request"

    private let handler: any CommandHandling

    init(handler: any CommandHandling) {
        self.handler = handler
    }

    func response(for input: String) -> HelperResponse {
        guard let data = input.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .object(let object) = value,
              case .string(let id)? = object["id"] else {
            return invalidRequest(id: Self.safeInvalidRequestID)
        }

        guard case .string(let commandName)? = object["command"],
              case .string? = object["bundleId"] else {
            return invalidRequest(id: id)
        }

        guard CommandName(rawValue: commandName) != nil else {
            return failure(id: id, code: "UNSUPPORTED_COMMAND", message: "Unsupported command.")
        }

        let command: HelperCommand

        do {
            command = try JSONDecoder().decode(HelperCommand.self, from: data)
        } catch {
            return invalidRequest(id: id)
        }

        do {
            let payload = try handler.handle(command)
            return HelperResponse(id: id, ok: true, payload: payload, error: nil)
        } catch let error as HelperError {
            return HelperResponse(id: id, ok: false, payload: nil, error: error)
        } catch {
            return failure(id: id, code: "INTERNAL_ERROR", message: "Internal error.")
        }
    }

    func responseLine(for input: String) -> String {
        let response = response(for: input)

        guard let encoded = try? JSONEncoder().encode(response) else {
            return "{\"id\":\"invalid-request\",\"ok\":false,\"error\":{\"code\":\"INTERNAL_ERROR\",\"message\":\"Internal error.\"}}\n"
        }

        return String(decoding: encoded, as: UTF8.self) + "\n"
    }

    private func invalidRequest(id: String) -> HelperResponse {
        failure(id: id, code: "INVALID_REQUEST", message: "Invalid request.")
    }

    private func failure(id: String, code: String, message: String) -> HelperResponse {
        HelperResponse(id: id, ok: false, payload: nil, error: HelperError(code: code, message: message))
    }
}
