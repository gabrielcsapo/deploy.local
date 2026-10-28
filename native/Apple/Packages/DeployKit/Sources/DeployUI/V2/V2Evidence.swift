#if os(iOS)
import Foundation

// Fixture navigation is compiled out on devices and in release builds.
enum V2Evidence {
    static var board: String? {
        #if DEBUG && targetEnvironment(simulator)
        let arguments = ProcessInfo.processInfo.arguments
        guard let fixture = arguments.firstIndex(of: "--v2-fixture"), arguments.indices.contains(fixture + 1),
              let url = URL(string: arguments[fixture + 1]), url.host == "127.0.0.1", url.scheme == "http",
              let port = url.port, (5180...5199).contains(port),
              let index = arguments.firstIndex(of: "--v2-board"), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
        #else
        return nil
        #endif
    }
}
#endif
