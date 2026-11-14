import XCTest
@testable import DeployCore

final class AttachmentTests: XCTestCase {
    func testVideoDurationAndAuthenticatedAssetRequest() throws {
        XCTAssertEqual(formatMediaDuration(12.9), "0:12")
        XCTAssertEqual(formatMediaDuration(600), "10:00")
        XCTAssertEqual(formatMediaDuration(3601), "60:01")
        XCTAssertEqual(formatMediaDuration(0), "0:00")
        XCTAssertNil(formatMediaDuration(nil)); XCTAssertNil(formatMediaDuration(.infinity)); XCTAssertNil(formatMediaDuration(-1))
        let connection = Connection(origin: "https://deploy.local", username: "alice", token: "secret")
        let request = try AuthenticatedMedia.request(connection: connection, attachmentId: "video-id")
        XCTAssertEqual(request.url?.absoluteString, "https://deploy.local/api/attachments/video-id")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Deploy-Username"), "alice")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Deploy-Token"), "secret")
        XCTAssertEqual(try AuthenticatedMedia.asset(connection: connection, attachmentId: "video-id").url, request.url)
        XCTAssertThrowsError(try AuthenticatedMedia.request(connection: connection, attachmentId: "../escape"))
    }
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

extension AttachmentTests {
    func testStoredLinksResolveToNewResourcesWithoutRewritingForeignLinks() throws {
        let connection = Connection(origin: "https://deploy.local", username: "alice", token: "secret")
        for (old, new) in [("/api/v2/attachments/abc", "/api/conversation-attachments/abc"),
                           ("/api/workspace/attachments/abc", "/api/attachments/abc")] {
            for suffix in ["", "/thumbnail", "?download=1#image"] {
                XCTAssertEqual(storedAttachmentURL(old + suffix, connection: connection)?.absoluteString,
                               "https://deploy.local" + new + suffix)
                XCTAssertEqual(storedAttachmentURL("https://deploy.local" + old + suffix, connection: connection)?.absoluteString,
                               "https://deploy.local" + new + suffix)
            }
            let markdown = "🖼 ![image](\(old)) [download](https://deploy.local\(old)?download=1) https://foreign.test\(old) //foreign.test\(old) /nested\(old)"
            let converted = "🖼 ![image](\(new)) [download](https://deploy.local\(new)?download=1) https://foreign.test\(old) //foreign.test\(old) /nested\(old)"
            XCTAssertEqual(convertStoredAttachmentText(markdown), converted)
            XCTAssertEqual(convertStoredAttachmentText(converted), converted)
            for prefix in ["https://foreign.test", "//foreign.test", "/nested", "https://deploy.local:8443", "https://alice:secret@deploy.local"] {
                XCTAssertNil(storedAttachmentURL(prefix + old, connection: connection))
            }
        }
        let custom = Connection(origin: "http://localhost:5194", username: "alice", token: "secret")
        XCTAssertEqual(storedAttachmentURL("http://localhost:5194/api/v2/attachments/abc", connection: custom)?.path,
                       "/api/conversation-attachments/abc")
        XCTAssertNil(storedAttachmentURL("/api/v2/tasks/abc", connection: connection))
        XCTAssertNil(storedAttachmentURL("/api/attachments/../user", connection: connection))
    }
}
