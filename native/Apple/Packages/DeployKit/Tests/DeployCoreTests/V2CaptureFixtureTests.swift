#if os(macOS)
import Foundation
import Testing
@testable import DeployCore

// Decode the capture server's actual HTTP JSON, not a second hand-maintained fixture.
private enum CaptureResponses {
    static let data: Result<Data, Error> = Result {
        var repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        while !FileManager.default.fileExists(atPath: repo.appendingPathComponent("docs/evidence/design-chat-build/fixture-server.ts").path) {
            let parent = repo.deletingLastPathComponent()
            guard parent != repo else { throw CocoaError(.fileNoSuchFile) }
            repo = parent
        }
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "--import", "tsx", "docs/evidence/design-chat-build/fixture-server.ts", "--dump"]
        process.currentDirectoryURL = repo
        process.standardOutput = output
        process.environment = ProcessInfo.processInfo.environment.merging(["DEPLOY_MDNS_ADDRESS": "127.0.0.1"]) { _, new in new }
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw CocoaError(.executableRuntimeMismatch) }
        return data
    }
    static func decode<T: Decodable>(_ key: String, as type: T.Type) throws -> T {
        let all = try JSONSerialization.jsonObject(with: data.get()) as! [String: Any]
        return try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: all[key]!))
    }
}

struct V2CaptureFixtureTests {
    @Test func nativeTaskDecodesActualFixtureJSON() throws {
        let detail = try CaptureResponses.decode("task", as: TaskDetail.self)
        #expect(detail.task.id == "welcome")
    }
    @Test func nativeDiffDecodesActualFixtureJSON() throws {
        let diff = try CaptureResponses.decode("diff", as: TaskDiff.self)
        #expect(diff.status == "ready")
    }
    @Test func chatReviewDecodesActualFixtureJSON() throws {
        let review = try CaptureResponses.decode("chat", as: V2DesignReview.self)
        #expect(V2ReviewModel.canvasBoards(review).first?.name == "Welcome")
        #expect(review.boards.count == 2)
    }
    @Test func sentReviewDecodesActualFixtureJSON() throws {
        let review = try CaptureResponses.decode("sent", as: V2DesignReview.self)
        #expect(review.boards.count == 22)
    }
    @Test func nativeEncodedReviewURLDecodesActualFixtureJSON() throws {
        #expect(V2Client.segment("deploy-local") == "deploy%2Dlocal")
        let review = try CaptureResponses.decode("chatEncoded", as: V2DesignReview.self)
        #expect(review.boards.count == 2)
    }
    @Test func fixtureReviewsBelongToTheirOwnTasks() throws {
        struct Response: Decodable { let items: [InboxItem] }
        let inbox = try CaptureResponses.decode("inbox", as: Response.self)
        #expect(inbox.items.filter { $0.taskId == "welcome" }.map(\.title) == ["Welcome: ask first"])
        let review = try CaptureResponses.decode("sent", as: V2DesignReview.self)
        #expect(review.task == "agents")
    }
    @Test func nativeConversationIncludesTheAgentReply() throws {
        // Inspect messages independently so this fails even before TaskDetail is decodable.
        struct Response: Decodable { let messages: [Message] }
        let detail = try CaptureResponses.decode("task", as: Response.self)
        #expect(detail.messages.contains { $0.role == "assistant" && $0.content.contains("I redrew Welcome") })
    }
    @Test func sentReviewTaskDestinationDecodesActualFixtureJSON() throws {
        let detail = try CaptureResponses.decode("sentTask", as: TaskDetail.self)
        #expect(detail.task.id == "agents")
    }
}
#endif
