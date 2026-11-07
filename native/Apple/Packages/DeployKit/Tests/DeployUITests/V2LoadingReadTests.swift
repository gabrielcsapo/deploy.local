import Foundation
import Testing
import DeployCore
@testable import DeployUI

@Suite @MainActor struct V2LoadingReadTests {
    private func store(_ directory: URL) -> V2Store { V2Store(connection: Connection(origin: "https://loading.invalid", username: "fixture", token: "fixture"), cacheDirectory: directory) }
    private enum Failure: Error { case unreachable }

    @Test func successfulEmptyIsCachedButFailureNeverCreatesACacheEntry() async {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = store(directory)
        let read = V2Read<[String]>()
        await read.load(store: store, key: "empty") { [] }
        #expect(read.state.hasData && !read.state.failed)
        #expect(read.value == [])
        let reopened = V2Read<[String]>()
        await reopened.load(store: store, key: "empty") { throw Failure.unreachable }
        #expect(reopened.state.hasData && reopened.state.failed)
        #expect(reopened.value == [])
        let missing = V2Read<[String]>()
        await missing.load(store: store, key: "missing") { throw Failure.unreachable }
        #expect(!missing.state.hasData && missing.state.failed)
        #expect(store.readCache["missing"] == nil)
    }
    @Test func delayedOldResourceCannotReplaceNewResourceOrFinishItsStatus() async {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = store(directory)
        let read = V2Read<[String]>()
        var resume: CheckedContinuation<[String], Never>?
        let old = Task {
            await read.load(store: store, key: "old") {
                await withCheckedContinuation { resume = $0 }
            }
        }
        while resume == nil { await Task.yield() }
        read.leave()
        store.readCache["new"] = ["saved"]
        await read.load(store: store, key: "new") { ["new"] }
        resume?.resume(returning: ["old"])
        await old.value
        #expect(read.value == ["new"])
        #expect(read.state.header() == "Updated just now")
        #expect(store.readCache["old"] == nil)
    }
    @Test func fastSectionRevealsWhileSiblingIsStillPending() async {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = store(directory)
        let privatePackages = V2Read<[String]>()
        let copies = V2Read<[String]>()
        var resume: CheckedContinuation<[String], Never>?
        let slow = Task { await copies.load(store: store, key: "copies") { await withCheckedContinuation { resume = $0 } } }
        while resume == nil { await Task.yield() }
        await privatePackages.load(store: store, key: "private") { ["@home/shared"] }
        #expect(privatePackages.state.hasData)
        #expect(copies.state.showsSkeleton && copies.state.pending)
        resume?.resume(returning: [])
        await slow.value
        #expect(copies.state.hasData)
    }
}
