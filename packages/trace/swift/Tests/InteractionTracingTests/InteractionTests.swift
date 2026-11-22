import XCTest

@testable import InteractionTracing

final class InteractionTests: XCTestCase {
  @MainActor func testCompletionSurvivesReconnectAndDeduplicates() async throws {
    let scope = UUID().uuidString
    var events = [InteractionEvent]()
    let tracer = InteractionTracer(scope: scope) { _ in false }
    defer { tracer.close() }
    let open = tracer.start("detail.open")
    let parent = await open.measure("detail.decode") { $0 }
    open.finish("navigation.left", outcome: "cancelled")
    open.finish("details.visible")
    // finish schedules persistence off the measured interaction.
    for _ in 0..<100 where UserDefaults.standard.data(forKey: "trace.pending." + scope) == nil {
      await Task.yield()
    }
    let restored = InteractionTracer(scope: scope) { event in
      events.append(event)
      return true
    }
    await restored.flush()
    await restored.flush()
    let event = try XCTUnwrap(events.first)
    XCTAssertEqual(events.count, 1)
    XCTAssertEqual(event.traceId, open.traceId)
    XCTAssertEqual(event.outcome, "cancelled")
    let child = try XCTUnwrap(event.spans.first)
    XCTAssertEqual(child.parentSpanId, event.spanId)
    XCTAssertEqual(parent, "00-" + event.traceId + "-" + child.spanId + "-01")
    restored.close()
  }
}
