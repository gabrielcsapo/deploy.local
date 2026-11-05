import Testing
import Foundation
import Security
@testable import DeployCore

struct V2PasswordTrustTests {
    @Test func fingerprintMatchesBoard() {
        let full = "4F:A2:19:C7:0B:E3:" + String(repeating: "00:", count: 20) + "88:D1:5E:42:9C:07"
        #expect(V2CertificateFingerprint.short(full.lowercased()) == "4F:A2:19:C7:0B:E3 · 88:D1:5E:42:9C:07")
        #expect(V2CertificateFingerprint.short("00:12").isEmpty)
        #expect(V2CertificateFingerprint.short(full.replacingOccurrences(of: "4F", with: "ZZ")).isEmpty)
        #expect(V2CertificateFingerprint.full(Data("abc".utf8)) == "BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD")
    }
    @Test func trustIsScopedToHTTPSOrigin() throws {
        #expect(try V2CertificateVault.origin(" https://DEPLOY.local:443/ ") == "https://deploy.local")
        #expect(try V2CertificateVault.origin("https://deploy.local:8443") == "https://deploy.local:8443")
        for origin in ["http://localhost", "https://user:secret@deploy.local", "https://deploy.local/path", "https://deploy.local?x=y"] {
            #expect(throws: (any Error).self) { try V2CertificateVault.origin(origin) }
        }
    }
    @Test func onlyCertificateTrustFailuresOfferManualTrust() {
        #expect(V2PasswordTrust.isTrustFailure(URLError(.serverCertificateUntrusted)))
        #expect(V2PasswordTrust.isTrustFailure(URLError(.serverCertificateHasUnknownRoot)))
        for code: URLError.Code in [.timedOut, .cannotFindHost, .cancelled, .secureConnectionFailed, .userAuthenticationRequired] {
            #expect(!V2PasswordTrust.isTrustFailure(URLError(code)))
        }
    }
    @Test func parsesCAAndRejectsLeafMalformedAndOversizeCertificates() throws {
        let der = try V2PasswordTrust.certificateDER(Data(ca.utf8))
        #expect(try V2PasswordTrust.certificateDER(der) == der)
        #expect(try V2PairingClient.certificateDER(Data(ca.utf8), fingerprint: V2CertificateFingerprint.full(der)) == der)
        for data in [Data(leaf.utf8), Data("not a certificate".utf8), Data(repeating: 0, count: 65537), der + Data([0])] {
            #expect(throws: (any Error).self) { try V2PasswordTrust.certificateDER(data) }
        }
    }
    @Test func pinnedEvaluationRequiresCorrectCAHostPortAndFingerprint() throws {
        let root = try V2PasswordTrust.certificateDER(Data(ca.utf8))
        let fingerprint = V2CertificateFingerprint.full(root)
        let pinned = V2PinnedCoordinator(origin: "https://fixture.invalid", fingerprint: fingerprint, certificate: root)
        #expect(try pinned.evaluate(challenge(host: "fixture.invalid")).0 == .useCredential)
        #expect(try pinned.evaluate(challenge(host: "other.invalid")).0 == .cancelAuthenticationChallenge)
        #expect(try pinned.evaluate(challenge(host: "fixture.invalid", port: 8443)).0 == .cancelAuthenticationChallenge)
        let wrongDigest = V2PinnedCoordinator(origin: "https://fixture.invalid", fingerprint: String(repeating: "00:", count: 31) + "00", certificate: root)
        #expect(try wrongDigest.evaluate(challenge(host: "fixture.invalid")).0 == .cancelAuthenticationChallenge)
        let wrongHost = V2PinnedCoordinator(origin: "https://other.invalid", fingerprint: fingerprint, certificate: root)
        #expect(try wrongHost.evaluate(challenge(host: "other.invalid")).0 == .cancelAuthenticationChallenge)
    }
    @Test func systemTrustSkipsDownloadAndOfflineDoesNotOfferTrust() async throws {
        let trace = TrustTrace()
        let candidate = try await V2PasswordTrust.prepare(origin: "https://fixture.invalid", saved: nil, probe: { _, pinned in
            #expect(pinned == nil)
            await trace.add("system")
        }, download: { _ in
            await trace.add("download"); return Data(ca.utf8)
        })
        #expect(candidate == nil)
        #expect(await trace.values == ["system"])
        do {
            _ = try await V2PasswordTrust.prepare(origin: "https://fixture.invalid", saved: nil, probe: { _, _ in
                throw URLError(.timedOut)
            }, download: { _ in
                await trace.add("download"); return Data(ca.utf8)
            })
            Issue.record("An offline coordinator must not offer trust")
        } catch { #expect((error as? URLError)?.code == .timedOut) }
        #expect(await trace.values == ["system"])
    }
    @Test func untrustedCAIsValidatedBeforeOfferingAndSavedTrustNeverFallsBack() async throws {
        let trace = TrustTrace()
        let candidate = try #require(try await V2PasswordTrust.prepare(origin: "https://fixture.invalid", saved: nil, probe: { origin, pinned in
            #expect(origin == "https://fixture.invalid")
            await trace.add(pinned == nil ? "system" : "pinned")
            if pinned == nil { throw URLError(.serverCertificateUntrusted) }
        }, download: { origin in
            #expect(origin == "https://fixture.invalid")
            await trace.add("download"); return Data(ca.utf8)
        }))
        #expect(await trace.values == ["system", "download", "pinned"])
        #expect(candidate.fingerprint == V2CertificateFingerprint.full(candidate.certificate))
        let saved = try await V2PasswordTrust.prepare(origin: candidate.origin, saved: candidate, probe: { _, pinned in
            #expect(pinned != nil); await trace.add("saved")
        }, download: { _ in
            await trace.add("unexpected download"); return Data(ca.utf8)
        })
        #expect(saved == nil)
        do {
            _ = try await V2PasswordTrust.prepare(origin: candidate.origin, saved: candidate, probe: { _, _ in
                throw URLError(.serverCertificateUntrusted)
            }, download: { _ in
                await trace.add("unexpected download"); return Data(ca.utf8)
            })
            Issue.record("A saved pin mismatch must fail closed")
        } catch { #expect((error as? URLError)?.code == .serverCertificateUntrusted) }
        #expect(await trace.values == ["system", "download", "pinned", "saved"])
    }
    @Test func mismatchedServerChainNeverOffersTheDownloadedCA() async {
        do {
            _ = try await V2PasswordTrust.prepare(origin: "https://fixture.invalid", saved: nil, probe: { _, _ in
                throw URLError(.serverCertificateUntrusted)
            }, download: { _ in Data(ca.utf8) })
            Issue.record("An unrelated CA must not be offered")
        } catch { #expect((error as? URLError)?.code == .serverCertificateUntrusted) }
    }
    private func challenge(host: String, port: Int = 443) throws -> URLAuthenticationChallenge {
        let certificate = try #require(SecCertificateCreateWithData(nil, V2PairingClient.certificateBytes(Data(leaf.utf8)) as CFData))
        var trust: SecTrust?
        #expect(SecTrustCreateWithCertificates([certificate] as CFArray, SecPolicyCreateSSL(true, host as CFString), &trust) == errSecSuccess)
        let serverTrust = try #require(trust)
        // Fixed within the fixture's validity, independent of the day tests run.
        SecTrustSetVerifyDate(serverTrust, Date(timeIntervalSince1970: 1793757301) as CFDate)
        let space = TrustProtectionSpace(host: host, port: port, protocol: "https", realm: nil, authenticationMethod: NSURLAuthenticationMethodServerTrust)
        space.trust = serverTrust
        return URLAuthenticationChallenge(protectionSpace: space, proposedCredential: nil, previousFailureCount: 0, failureResponse: nil, error: nil, sender: ChallengeSender())
    }
}
private actor TrustTrace {
    var values: [String] = []
    func add(_ value: String) { values.append(value) }
}
private final class TrustProtectionSpace: URLProtectionSpace, @unchecked Sendable {
    var trust: SecTrust?
    override var serverTrust: SecTrust? { trust }
}
private final class ChallengeSender: NSObject, URLAuthenticationChallengeSender {
    func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) {}
    func continueWithoutCredential(for challenge: URLAuthenticationChallenge) {}
    func cancel(_ challenge: URLAuthenticationChallenge) {}
}
// Public certificates only; private fixture keys are never shipped.
private let ca = """
-----BEGIN CERTIFICATE-----
MIIC6DCCAdCgAwIBAgIJAMEzixRA5zebMA0GCSqGSIb3DQEBCwUAMCExHzAdBgNV
BAMMFlBhc3N3b3JkIHRydXN0IHRlc3QgQ0EwHhcNMjYxMTA0MDA1NTAxWhcNMzYx
MTAxMDA1NTAxWjAhMR8wHQYDVQQDDBZQYXNzd29yZCB0cnVzdCB0ZXN0IENBMIIB
IjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArU/3RR60zzicz6CYbZXVpBpj
LZmIMo7vG6eRP5yK2eX5QjKLc4N2HCuQqbceh3Y9XJgL319hRZNqksxBqOPyAhBf
mYQ/AnGr8N8soNLQ6S8Bc30ehZYt2vrlDrD07OSlR93X6sN/6nwcMQqwBRSxWZc/
YFMdheX5kd35F4sVdXMljs70CP6f4nejMoYx/k/X9g0pm7IyD2TwseNzuNTiT8aP
Nrw1liB/Liu2NIKe3qeUowns5hMkhIfSbqwftxiHEvYOiGAt92K3ry6tRO+J75gt
VvGbPYw1suZrjT3GvI5W+7acns1hzBV9ODBmlUiSAePXZhG5LaIEvBUGej5eoQID
AQABoyMwITAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG
9w0BAQsFAAOCAQEAo7uzlHc90d/eLTKY/DdHubOeo2uL5Asesj3CNgC+oSsOBEoO
aPG1HG4aUjPFezpDEjnLMV4hwTfogvYQ2eYqUUGwZSvS8sYJX1VZ5245kR18wKje
yVnAxhCuQTLhzoy5ZaPRaLdmuwT4BYiIfC4uLvCGPjOhhFKdHWBYGKQe+wlR+/M0
tx/y42KqMEaseNQn0BYFSNJc3ka3NoH4inOuC4lHHboAE0pEdJ/Uv7z/QPKYHaWH
X1PZH15qYEhNX/Fvc8nIKQW91FVBJTBfjK4LCQnsaZISVMiAX/QDpbVValuq2CKh
SMtiNia+e5B+utjh4UO1RpNwt6q/PQZPWzIo1g==
-----END CERTIFICATE-----
"""
private let leaf = """
-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIJAPVxMh0oC8FQMA0GCSqGSIb3DQEBCwUAMCExHzAdBgNV
BAMMFlBhc3N3b3JkIHRydXN0IHRlc3QgQ0EwHhcNMjYxMTA0MDA1NTAxWhcNMjcw
ODMxMDA1NTAxWjAaMRgwFgYDVQQDDA9maXh0dXJlLmludmFsaWQwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQD85o8Jp65ZaYsq22HObDKb4mPecFwsgGRS
WKvswCH5UP3aIbFPiZ/omb6XGiRaM0UoFYRmc686t9qj8LRhtoofkakIjx40ZF8d
0ovxKQzV0EfqR27KH/DpRolz19+UPqOmouxumsHqeL7tfElmQTeRaRl8h3GO+1OP
maY+g5C7qZtLdnYHk3n2E0EU0Uwno/mKW072ZIu4YdYx1FIfgd42dWFL8VlSefEq
rDnp9fucGMpZoYi9XbWw5W+d/Jgo1Swn+hileYAf069xYYsjHLs4QudOBpsW38t+
j4ca/ho342gFjRJjHKEa7N2Q3FgR/gR/fn5VAIAMEOSF9mwxS643AgMBAAGjUTBP
MAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/BAQDAgWgMBMGA1UdJQQMMAoGCCsGAQUF
BwMBMBoGA1UdEQQTMBGCD2ZpeHR1cmUuaW52YWxpZDANBgkqhkiG9w0BAQsFAAOC
AQEAo8ceKXGpOkB2J3zhX/egjisEwwTYRrD6xQWVbKGF82d7y40P4mHQ+EelwTL9
Nop+rSw/ARLKYcO5dQH7/VxggwNTArRkAa9GK5yBc0AvgcSKMPUubr3Dr6mzeH1S
LzdZkiPiIUfUmnH23sfHu2oxsnoC7WxzPYX6jBo7sGrBl9mbzlHz1gtILTyrQbix
BRKeMXCnXK9OzO2WJ2cfuUHJwt5lvc/QGUwEbm0b5DKm+bkFz2QKy3uJMAGJjwMx
MSeHJwtzq4z2Z8INmzJNh1ang0iZwaakWVD5GpSSgKpksK9EoEgPsYbx20lYBdBc
G+T+mC0qJ/JyhEpDtXFl0xoxmA==
-----END CERTIFICATE-----
"""
