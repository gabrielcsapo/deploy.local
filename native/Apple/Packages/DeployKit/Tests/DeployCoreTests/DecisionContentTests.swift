import Testing
import Foundation
@testable import DeployCore

@Test func questionContentDecodesWithNamesAndLegacyFallbacks() throws {
    let json = ##"{"id":"question:q","kind":"question","title":"Publish?","text":"Publish?","from":"custom-id","fromName":"Release notes writer","projectName":"home-gym","taskId":"task","createdAt":"2026-11-03T12:00:00Z","context":{"text":"# Draft\n\n- Ready","messageId":"message","createdAt":"2026-11-03T11:59:00Z"},"actions":[],"state":"waiting"}"##
    var item = try JSONDecoder().decode(InboxItem.self, from: Data(json.utf8))
    #expect(item.context?.text == "# Draft\n\n- Ready")
    #expect(item.context?.messageId == "message")
    #expect(item.projectName == "home-gym")
    #expect(V2Labels.agentName(item) == "Release notes writer")
    #expect(try JSONDecoder().decode(InboxItem.self, from: JSONEncoder().encode(item)) == item)
    item.fromName = nil
    #expect(V2Labels.agentName(item) == "An agent")
    item.from = "scout"
    #expect(V2Labels.agentName(item) == "Scout")
    item.from = "warden"
    item.fromName = "  "
    #expect(V2Labels.agentName(item) == "Warden")
    var legacy = try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    for key in ["context", "fromName", "projectName"] { legacy.removeValue(forKey: key) }
    let old = try JSONDecoder().decode(InboxItem.self, from: JSONSerialization.data(withJSONObject: legacy))
    #expect(old.context == nil)
    #expect(V2Labels.agentName(old) == "An agent")
}

@Test func questionOptionsAndAskedTime() {
    let actions = [InboxAction(id: "answer", label: "Answer"), InboxAction(id: "other", label: "Other"), InboxAction(id: "primary", label: "Recommended", primary: true), InboxAction(id: "dismiss", label: "Dismiss")]
    let item = InboxItem(id: "q", kind: .question, title: "Publish?", text: "Publish?", from: "scout", createdAt: "2026-11-03T12:00:00Z", actions: actions, state: .waiting)
    #expect(V2Labels.questionOptions(item).map(\.id) == ["primary", "other"])
    let now = ISO8601DateFormatter().date(from: "2026-11-03T12:12:00Z")!
    #expect(V2Labels.askedTime(item.createdAt, now: now) == "Asked 12m ago")
    #expect(V2Labels.askedTime("invalid", now: now) == "Asked · time unavailable")
}
