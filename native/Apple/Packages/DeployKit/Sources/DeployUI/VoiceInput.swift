import SwiftUI
import AVFoundation
import DeployCore

private struct VoiceAvailability: Decodable, Sendable { let available: Bool }
private struct VoiceTranscript: Decodable, Sendable { let text: String }

@MainActor
struct VoiceInput: View {
    let connection: Connection?
    @Binding var draft: String
    @Environment(\.scenePhase) private var scenePhase
    @State private var available = false
    @State private var recorder: AVAudioRecorder?
    @State private var recording = false
    @State private var busy = false
    @State private var error: String?
    @State private var operation: Task<Void, Never>?
    @State private var limit: Task<Void, Never>?
    @State private var file: URL?
    var body: some View {
        HStack(spacing: 6) {
            Button {
                operation = Task { if recording { await finish() } else { await start() } }
            } label: {
                if busy { ProgressView().controlSize(.small).frame(width: WorkspaceStyle.controlSize, height: WorkspaceStyle.controlSize) }
                else { Image(systemName: recording ? "stop.fill" : "mic").font(.system(.body)).frame(width: WorkspaceStyle.controlSize, height: WorkspaceStyle.controlSize).foregroundStyle(recording ? Color.red : Color.secondary) }
            }.buttonStyle(.plain).disabled(!available || busy)
                .accessibilityLabel(recording ? "Stop dictation" : "Dictate message")
                .help(available ? "Dictate a message. Review before sending." : "Voice input is not configured on this coordinator.")
            if recording { Text("Recording").font(.caption).foregroundStyle(.red) }
        }
        .alert("Voice input", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK") { error = nil } } message: { Text(error ?? "") }
        .task(id: connection) {
            available = false
            guard let connection else { return }
            let result: VoiceAvailability? = try? await WorkspaceClient(connection: connection).request("/api/workspace/transcription")
            available = result?.available ?? false
        }
        .onDisappear { cancel() }
        .onChange(of: scenePhase) { _, phase in if phase == .background { cancel() } }
    }
    private func start() async {
        busy = true
        defer { busy = false }
        #if os(iOS)
        let granted = await AVAudioApplication.requestRecordPermission()
        #else
        let granted = await AVCaptureDevice.requestAccess(for: .audio)
        #endif
        guard !Task.isCancelled else { return }
        guard granted else { error = "Allow microphone access in system settings to dictate a message."; return }
        do {
            #if os(iOS)
            try AVAudioSession.sharedInstance().setCategory(.record, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
            #endif
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("deploy-dictation-\(UUID().uuidString).wav")
            file = url
            let audio = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false])
            guard audio.record() else { throw ClientError.response(0, "The microphone could not start recording.") }
            recorder = audio; recording = true
            limit = Task {
                do { try await Task.sleep(for: .seconds(120)); operation = Task { await finish() } } catch {}
            }
        } catch { self.error = error.localizedDescription; cleanup() }
    }
    private func finish() async {
        guard recording, let file, let connection else { return }
        limit?.cancel(); limit = nil
        recorder?.stop(); recorder = nil; recording = false; busy = true
        releaseSession()
        defer { busy = false; cleanup() }
        do {
            let data = try Data(contentsOf: file)
            let result: VoiceTranscript = try await WorkspaceClient(connection: connection).request("/api/workspace/transcription", method: "POST", body: data, contentType: "audio/wav", timeout: 100)
            guard !Task.isCancelled else { return }
            if result.text.isEmpty { error = "No speech detected. Try again." }
            else { draft += (draft.isEmpty ? "" : " ") + result.text }
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func releaseSession() {
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false)
        #endif
    }
    private func cleanup() {
        recorder?.stop(); recorder = nil; recording = false
        if let file { try? FileManager.default.removeItem(at: file) }; file = nil
        releaseSession()
    }
    private func cancel() { operation?.cancel(); limit?.cancel(); cleanup(); busy = false }
}
