import Foundation

@main
struct TaobaoAXHelper {
    static func main() {
        let server = JSONLineProtocol(handler: DefaultCommandHandler())

        while let input = readLine() {
            let line = server.responseLine(for: input)
            FileHandle.standardOutput.write(Data(line.utf8))
        }
    }
}
