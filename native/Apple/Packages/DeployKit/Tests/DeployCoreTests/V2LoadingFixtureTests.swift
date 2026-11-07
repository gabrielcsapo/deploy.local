#if os(macOS)
import Foundation
import Testing
@testable import DeployCore

private enum LoadingFixture {
    static let data: Result<Data, Error> = Result {
        var repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let fixture = "docs/evidence/iphone-loading-build/fixture-server.ts"
        while !FileManager.default.fileExists(atPath: repo.appendingPathComponent(fixture).path) {
            let parent = repo.deletingLastPathComponent()
            guard parent != repo else { throw CocoaError(.fileNoSuchFile) }
            repo = parent
        }
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "--import", "tsx", fixture, "--dump"]
        process.currentDirectoryURL = repo; process.standardOutput = output
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw CocoaError(.executableRuntimeMismatch) }
        return data
    }
    static func decode<T: Decodable>(_ key: String, as type: T.Type) throws -> T {
        let all = try #require(JSONSerialization.jsonObject(with: data.get()) as? [String: Any])
        let value = try #require(all[key])
        return try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }
}
@Suite struct V2LoadingFixtureTests {
    @Test func captureCacheDecodesAndPreservesResourcePresence() throws {
        let snapshot = try LoadingFixture.decode("cache", as: V2Snapshot.self)
        #expect(snapshot.loadedResources.contains("waiting"))
        #expect(snapshot.inbox.count == 1)
        #expect(snapshot.updatedAt != nil)
        #expect(snapshot.agents.first?.name == "Release notes writer")
    }
    @Test func captureResourceResponsesDecodeWithProductionTypes() throws {
        #expect(try LoadingFixture.decode("task", as: TaskDetail.self).task.title == "Fix the sync worker")
        #expect(try LoadingFixture.decode("diff", as: TaskDiff.self).files.isEmpty)
        #expect(try LoadingFixture.decode("live", as: V2Live.self).computers.first?.name == "SER")
        struct Packages: Decodable { let packages: [V2Package] }
        struct Versions: Decodable { let versions: [V2PackageVersion] }
        #expect(try LoadingFixture.decode("packages", as: Packages.self).packages.count == 1)
        #expect(try LoadingFixture.decode("copies", as: V2PackageCopies.self).sources.first?.reachable == true)
        #expect(try LoadingFixture.decode("versions", as: Versions.self).versions.first?.version == "1.2.0")
    }
}
#endif
