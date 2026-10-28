#if os(iOS)
import SwiftUI
import VisionKit
import DeployCore

struct V2SignIn: View {
    @Bindable var workspace: WorkspaceStore
    let connected: (Connection) -> Void
    @State private var scanner = false
    @State private var password = false
    @State private var busy = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            V2Page(title: "Sign in") {
                Text("On a computer that is signed in, open Settings › Devices › Add iPhone, then scan the code it shows.").font(.system(size: 17))
                Button { scanner = true } label: {
                    Image(systemName: "qrcode.viewfinder").font(.system(size: 100, weight: .ultraLight)).frame(maxWidth: .infinity, minHeight: 240)
                }.accessibilityLabel("Scan pairing code").disabled(busy || V2Evidence.board != nil)
                Text("The code carries your coordinator's address, its certificate fingerprint and a one-time sign-in.").font(.system(size: 13)).foregroundStyle(.secondary)
                if busy { ProgressView("Signing in…") }
                if let error { Text(error).font(.system(size: 13)).foregroundStyle(.secondary) }
                Button { password = true } label: { V2Row(title: "Sign in with a password", subtitle: "Your iPhone must trust the coordinator's certificate", icon: "key") }
            }.toolbar { Button("Done") { dismiss() } }
                .sheet(isPresented: $password) { ConnectionSheet(store: workspace) }
                .sheet(isPresented: $scanner) {
                    if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                        V2QRScanner { result in
                            scanner = false
                            switch result { case .success(let value): pair(value); case .failure(let error): self.error = error.localizedDescription }
                        }.ignoresSafeArea()
                    } else { V2Empty(title: "Camera unavailable", message: "Allow camera access in iPhone Settings, or sign in with a password.").padding(24) }
                }
        }
    }
    private func pair(_ text: String) {
        guard !busy else { return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                let payload = try V2PairingPayload.parse(text)
                let device = try await V2PairingClient.exchange(payload, name: UIDevice.current.name)
                try V2PairingVault.save(device)
                connected(device.connection); dismiss()
            } catch { self.error = coordinatorErrorDescription(error) }
        }
    }
}
private struct V2QRScanner: UIViewControllerRepresentable {
    let result: (Result<String, Error>) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(result: result) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false, isGuidanceEnabled: true, isHighlightingEnabled: true)
        controller.delegate = context.coordinator
        do { try controller.startScanning() } catch { context.coordinator.finish(.failure(error)) }
        return controller
    }
    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}
    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) { controller.stopScanning() }
    @MainActor final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let result: (Result<String, Error>) -> Void
        private var finished = false
        init(result: @escaping (Result<String, Error>) -> Void) { self.result = result }
        func finish(_ value: Result<String, Error>) { guard !finished else { return }; finished = true; result(value) }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems { if case .barcode(let barcode) = item, let text = barcode.payloadStringValue { dataScanner.stopScanning(); finish(.success(text)); return } }
        }
        func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) { finish(.failure(error)) }
    }
}
#endif
