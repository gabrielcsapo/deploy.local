import XCTest
@testable import DeployCore

final class AttachmentTests: XCTestCase {
    func testAttachmentModel() throws {
        let data = Data(#"{"id":"image","taskId":"task","runId":"run","messageId":"message","kind":"image","mimeType":"image/png","size":68,"width":1,"height":1,"name":"screen.png","caption":"Simulator","source":"agent","createdAt":"2026-10-20T00:00:00Z"}"#.utf8)
        let attachment = try JSONDecoder().decode(MediaAttachment.self, from: data)
        XCTAssertEqual(attachment.width, 1)
        XCTAssertEqual(attachment.runId, "run")
        XCTAssertEqual(attachment.caption, "Simulator")
        XCTAssertEqual(try JSONDecoder().decode(MediaAttachment.self, from: JSONEncoder().encode(attachment)), attachment)
    }
    func testCacheKeyIsScopedToOriginAccountCredentialAndAttachment() throws {
        let a = Connection(origin: "https://deploy.local", username: "alice", token: "secret")
        let key = try AuthenticatedImageCache.key(connection: a, attachmentId: "image")
        XCTAssertEqual(key, try AuthenticatedImageCache.key(connection: Connection(origin: "https://DEPLOY.local:443/", username: "alice", token: "secret"), attachmentId: "image"))
        for connection in [Connection(origin: "https://other.local", username: "alice", token: "secret"), Connection(origin: "https://deploy.local", username: "bob", token: "secret"), Connection(origin: "https://deploy.local", username: "alice", token: "new")] {
            XCTAssertNotEqual(key, try AuthenticatedImageCache.key(connection: connection, attachmentId: "image"))
        }
        XCTAssertNotEqual(key, try AuthenticatedImageCache.key(connection: a, attachmentId: "other"))
        XCTAssertFalse(key.contains("secret"))
    }
}
