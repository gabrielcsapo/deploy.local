// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DeployKit",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "DeployCore", targets: ["DeployCore"]),
        .library(name: "DeployUI", targets: ["DeployUI"])
    ],
    dependencies: [
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui.git", exact: "2.4.1")
    ],
    targets: [
        .target(name: "DeployCore"),
        .target(name: "DeployUI", dependencies: ["DeployCore", .product(name: "MarkdownUI", package: "swift-markdown-ui")]),
        .testTarget(name: "DeployCoreTests", dependencies: ["DeployCore"])
    ]
)
