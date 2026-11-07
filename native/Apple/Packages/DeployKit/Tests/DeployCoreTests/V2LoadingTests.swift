import Foundation
import Testing
@testable import DeployCore

@Suite struct V2LoadingTests {
    let now = ContinuousClock.now

    @Test func onlyMissingDataUsesSkeletonsIncludingSuccessfulEmptyCache() {
        var missing = V2LoadState()
        #expect(missing.showsSkeleton)
        var cached = V2LoadState(hasData: true)
        let cachedRead = cached.begin(foreground: true, at: now)
        #expect(!cached.showsSkeleton)
        #expect(cached.header(at: now) == "Updating…")
        let read = missing.begin(foreground: true, at: now)
        let accepted0 = missing.succeed(read, at: now)
        #expect(accepted0)
        #expect(missing.hasData)
        #expect(!missing.showsSkeleton)
        let accepted1 = cached.succeed(cachedRead, at: now)
        #expect(accepted1)
    }
    @Test func firstLoadShowsSkeletonsWithNoHeaderLine() {
        var state = V2LoadState()
        let read = state.begin(foreground: true, at: now)
        #expect(state.header(at: now) == nil)
        #expect(state.header(at: now + .seconds(11)) == nil)
        #expect(state.isSlow(at: now + .seconds(11)))
        let accepted = state.succeed(read, at: now + .seconds(12))
        #expect(accepted)
        #expect(state.header(at: now + .seconds(12)) == nil)
    }
    @Test func failureIsNeverSuccessfulEmptyAndReplacesPendingImmediately() {
        var state = V2LoadState()
        let read = state.begin(foreground: true, at: now)
        let accepted2 = state.fail(read)
        #expect(accepted2)
        #expect(state.failed)
        #expect(!state.hasData)
        #expect(!state.showsSkeleton)
        #expect(!state.isSlow(at: now + .seconds(20)))
        let retry = state.begin(foreground: true, at: now + .seconds(30))
        #expect(state.failed)
        let accepted3 = state.succeed(retry, at: now + .seconds(31))
        #expect(accepted3)
        #expect(!state.failed)
        #expect(state.hasData)
    }
    @Test func retriesAndPollsDoNotRestartTenSecondClock() {
        var state = V2LoadState(hasData: true)
        _ = state.begin(foreground: true, at: now)
        _ = state.begin(foreground: true, at: now + .seconds(8))
        _ = state.begin(foreground: false, at: now + .seconds(9))
        #expect(!state.isSlow(at: now + .seconds(9)))
        #expect(state.isSlow(at: now + .seconds(10)))
        #expect(state.header(at: now + .seconds(10)) == "Waiting for SER…")
    }
    @Test func navigationRejectsOldResponsesEvenForSameResource() {
        var state = V2LoadState()
        let old = state.begin(foreground: true, at: now)
        state.leave()
        let current = state.begin(foreground: true, at: now + .seconds(1))
        let accepted4 = !state.succeed(old, at: now + .seconds(2))
        #expect(accepted4)
        let accepted5 = !state.fail(old)
        #expect(accepted5)
        #expect(!state.hasData)
        let accepted6 = state.succeed(current, at: now + .seconds(3))
        #expect(accepted6)
        state.leave()
        #expect(state.header(at: now + .seconds(4)) == nil)
    }
    @Test func pollsStayQuietAndCannotCompleteForegroundStatus() {
        var state = V2LoadState(hasData: true)
        let poll = state.begin(foreground: false, at: now)
        #expect(state.header(at: now) == nil)
        let accepted7 = state.succeed(poll, at: now + .seconds(1))
        #expect(accepted7)
        #expect(state.header(at: now + .seconds(1)) == nil)
        let foreground = state.begin(foreground: true, at: now + .seconds(2))
        let concurrentPoll = state.begin(foreground: false, at: now + .seconds(3))
        let accepted8 = state.succeed(concurrentPoll, at: now + .seconds(4))
        #expect(accepted8)
        #expect(state.header(at: now + .seconds(4)) == "Updating…")
        let accepted9 = state.succeed(foreground, at: now + .seconds(5))
        #expect(accepted9)
        #expect(state.header(at: now + .seconds(6)) == "Updated just now")
        #expect(state.header(at: now + .seconds(65)) == "Updated 1 min ago")
    }
    @Test func cachedFailureKeepsReadableData() {
        var state = V2LoadState(hasData: true)
        let read = state.begin(foreground: true, at: now)
        let accepted10 = state.fail(read)
        #expect(accepted10)
        #expect(state.hasData)
        #expect(state.failed)
        #expect(!state.showsSkeleton)
    }
}
