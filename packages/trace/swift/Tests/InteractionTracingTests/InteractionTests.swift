import XCTest

@testable import InteractionTracing

final class InteractionTests: XCTestCase {
  @MainActor func testBurstDrainsAcrossMultipleBatches() async throws {
    var batches: [[InteractionEvent]] = []
    let tracer = InteractionTracer(batchingScope: UUID().uuidString) { events in
      batches.append(events)
      return true
    }
    defer { tracer.close() }
    let opened = (0..<40).map { _ in tracer.start("http.get.inbox") }
    for open in opened { open.finish("response.received") }
    for _ in 0..<100 where batches.flatMap({ $0 }).count < opened.count {
      await Task.yield()
      await tracer.flush()
    }
    XCTAssertEqual(Set(batches.flatMap { $0.map(\.traceId) }), Set(opened.map(\.traceId)))
    XCTAssertEqual(batches.flatMap { $0 }.count, opened.count)
    XCTAssertTrue(batches.allSatisfy { $0.count <= 16 })
  }
  @MainActor func testChildStatusDistinguishesCancellationFromNetworkFailure() async throws {
    var recorded: InteractionEvent?
    let tracer = InteractionTracer(scope: UUID().uuidString) { event in
      recorded = event
      return true
    }
    defer { tracer.close() }
    let interaction = tracer.start("network.test")
    for error in [CancellationError(), URLError(.cancelled), URLError(.timedOut)] as [Error] {
      do {
        try await interaction.measure("http.fetch") { _ in throw error }
        XCTFail("The original error should propagate")
      } catch {}
    }
    interaction.finish("complete")
    for _ in 0..<100 where recorded == nil { await Task.yield() }
    let event = try XCTUnwrap(recorded)
    XCTAssertEqual(event.spans.map(\.failed), [false, false, true])
  }
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
