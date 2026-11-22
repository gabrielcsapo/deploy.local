// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "InteractionTracing", platforms: [.iOS(.v17), .macOS(.v14), .tvOS(.v17)],
  products: [.library(name: "InteractionTracing", targets: ["InteractionTracing"])],
  targets: [
    .target(name: "InteractionTracing"),
    .testTarget(name: "InteractionTracingTests", dependencies: ["InteractionTracing"]),
  ])
