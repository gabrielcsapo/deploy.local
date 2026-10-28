// swift-tools-version: 6.0
import PackageDescription

// Keep slice tests inside its assigned evidence boundary.
let package = Package(
    name: "IOSPartTwoTests",
    platforms: [.macOS(.v14)],
    dependencies: [.package(name: "DeployKit", path: "../../../../native/Apple/Packages/DeployKit")],
    targets: [.testTarget(name: "IOSPartTwoTests", dependencies: [.product(name: "DeployCore", package: "DeployKit")], path: "Tests", resources: [.copy("Fixtures")])]
)
