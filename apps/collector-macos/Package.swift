// swift-tools-version: 5.7
import PackageDescription

let package = Package(
    name: "TaobaoAX",
    platforms: [.macOS(.v12)],
    products: [
        .executable(name: "taobao-ax-helper", targets: ["TaobaoAX"]),
    ],
    targets: [
        .executableTarget(name: "TaobaoAX"),
        .testTarget(name: "TaobaoAXTests", dependencies: ["TaobaoAX"]),
    ]
)
