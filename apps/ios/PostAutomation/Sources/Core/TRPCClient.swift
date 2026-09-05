import Foundation

// MARK: - Errors

/// The error payload tRPC returns, unwrapped from its superjson envelope:
/// `{"error":{"json":{"message":"UNAUTHORIZED","code":-32001,"data":{"code":"UNAUTHORIZED","httpStatus":401,"path":"post.list"}}}}`
/// (shape verified against production).
struct TRPCErrorPayload: Decodable, Equatable {
    struct Data: Decodable, Equatable {
        let code: String?
        let httpStatus: Int?
        let path: String?
    }
    let message: String
    let data: Data?

    var code: String { data?.code ?? "UNKNOWN" }
}

enum APIError: Error, LocalizedError, Equatable {
    /// tRPC returned a structured error (UNAUTHORIZED, FORBIDDEN, BAD_REQUEST, ...).
    case trpc(TRPCErrorPayload)
    /// Non-JSON or unexpected HTTP failure (e.g. nginx 429/502 HTML page).
    case http(status: Int, body: String)
    /// JSON came back but did not match the expected shape.
    case decoding(String)
    case invalidResponse

    var isUnauthorized: Bool {
        if case .trpc(let p) = self { return p.code == "UNAUTHORIZED" || p.data?.httpStatus == 401 }
        if case .http(let s, _) = self { return s == 401 }
        return false
    }

    var errorDescription: String? {
        switch self {
        case .trpc(let p):
            switch p.code {
            case "UNAUTHORIZED": return "Your session has expired. Please sign in again."
            case "FORBIDDEN": return p.message.isEmpty ? "You don't have permission to do that." : p.message
            case "TOO_MANY_REQUESTS": return "Too many requests — please wait a moment and try again."
            default: return p.message
            }
        case .http(let status, _):
            if status == 429 { return "Too many requests — please wait a moment and try again." }
            if status >= 500 { return "The server is temporarily unavailable (HTTP \(status))." }
            return "Request failed (HTTP \(status))."
        case .decoding(let detail):
            return "Unexpected response from server. \(detail)"
        case .invalidResponse:
            return "Invalid response from server."
        }
    }
}

// MARK: - Superjson envelope

/// tRPC is configured with the `superjson` transformer, so every input and
/// output is wrapped as `{ "json": <value>, "meta"?: {...} }`. We only ever read
/// `json`; `meta` marks Dates/BigInts which we handle by decoding ISO strings
/// and skipping BigInt fields entirely.
private struct SuperJSONInput<T: Encodable>: Encodable {
    let json: T
}

private struct SuperJSONEnvelope<T: Decodable>: Decodable {
    struct ResultBox: Decodable {
        struct DataBox: Decodable { let json: T }
        let data: DataBox
    }
    struct ErrorBox: Decodable { let json: TRPCErrorPayload }
    let result: ResultBox?
    let error: ErrorBox?
}

/// Marker for procedures that take no input.
struct NoInput: Encodable {}

// MARK: - Client

/// Minimal tRPC-over-HTTP client.
///
/// Auth is the NextAuth session cookie (see `AuthService`). `URLSession` with the
/// shared `HTTPCookieStorage` attaches it automatically to every request to the
/// API host, and persists it across launches — the same mechanism a browser uses.
final class TRPCClient {
    static let shared = TRPCClient()

    let baseURL: URL
    let session: URLSession

    /// Optional org override, sent as `x-organization-id`. When nil the server
    /// resolves the caller's default membership (OWNER-first, oldest tie-break).
    var organizationId: String?

    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(baseURL: URL = APIConfig.baseURL, session: URLSession? = nil) {
        self.baseURL = baseURL
        if let session {
            self.session = session
        } else {
            let cfg = URLSessionConfiguration.default
            cfg.httpCookieStorage = HTTPCookieStorage.shared
            cfg.httpCookieAcceptPolicy = .always
            cfg.httpShouldSetCookies = true
            cfg.timeoutIntervalForRequest = 30
            cfg.waitsForConnectivity = true
            self.session = URLSession(configuration: cfg)
        }

        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom(TRPCClient.decodeDate)
        self.decoder = d

        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, enc in
            var c = enc.singleValueContainer()
            try c.encode(TRPCClient.isoWithFraction.string(from: date))
        }
        self.encoder = e
    }

    // MARK: Public API

    /// GET query with no input, e.g. `channel.list`, `analytics.dashboardStats`.
    func query<Output: Decodable>(_ path: String) async throws -> Output {
        try await query(path, input: Optional<NoInput>.none)
    }

    /// GET query with an input object (URL-encoded superjson).
    func query<Input: Encodable, Output: Decodable>(_ path: String, input: Input?) async throws -> Output {
        var components = URLComponents(url: baseURL.appendingPathComponent("\(APIConfig.trpcPath)/\(path)"), resolvingAgainstBaseURL: false)!
        if let input {
            let body = try encoder.encode(SuperJSONInput(json: input))
            components.queryItems = [URLQueryItem(name: "input", value: String(decoding: body, as: UTF8.self))]
        }
        var req = URLRequest(url: components.url!)
        req.httpMethod = "GET"
        applyCommonHeaders(&req)
        return try await perform(req)
    }

    /// POST mutation with a JSON body (superjson-wrapped).
    func mutate<Input: Encodable, Output: Decodable>(_ path: String, input: Input) async throws -> Output {
        var req = URLRequest(url: baseURL.appendingPathComponent("\(APIConfig.trpcPath)/\(path)"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try encoder.encode(SuperJSONInput(json: input))
        applyCommonHeaders(&req)
        return try await perform(req)
    }

    // MARK: Internals

    private func applyCommonHeaders(_ req: inout URLRequest) {
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("PostAutomation-iOS/0.1", forHTTPHeaderField: "User-Agent")
        if let organizationId { req.setValue(organizationId, forHTTPHeaderField: "x-organization-id") }
    }

    private func perform<Output: Decodable>(_ req: URLRequest) async throws -> Output {
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        return try TRPCClient.decodeResponse(data: data, status: http.statusCode, decoder: decoder)
    }

    /// Pure, testable: turns raw bytes + status into a typed value or an APIError.
    static func decodeResponse<Output: Decodable>(data: Data, status: Int, decoder: JSONDecoder) throws -> Output {
        // Try the superjson envelope first regardless of status — tRPC returns
        // JSON error envelopes with 4xx/5xx statuses, and we want the structured
        // message rather than a generic HTTP error.
        if let envelope = try? decoder.decode(SuperJSONEnvelope<Output>.self, from: data) {
            if let err = envelope.error { throw APIError.trpc(err.json) }
            if let result = envelope.result { return result.data.json }
        }
        // Not a tRPC envelope: nginx HTML (429/502/504), empty body, etc.
        guard (200..<300).contains(status) else {
            throw APIError.http(status: status, body: String(decoding: data.prefix(300), as: UTF8.self))
        }
        // 2xx but shape mismatch — surface the decoding problem precisely.
        do {
            _ = try decoder.decode(SuperJSONEnvelope<Output>.self, from: data)
            throw APIError.invalidResponse
        } catch let e as DecodingError {
            throw APIError.decoding(describe(e))
        }
    }

    // MARK: Dates

    static let isoWithFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Prisma DateTime → superjson → ISO 8601 string (usually with milliseconds).
    static func decodeDate(_ decoder: Decoder) throws -> Date {
        let c = try decoder.singleValueContainer()
        let s = try c.decode(String.self)
        if let d = isoWithFraction.date(from: s) ?? isoPlain.date(from: s) { return d }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unrecognised date: \(s)")
    }

    private static func describe(_ e: DecodingError) -> String {
        switch e {
        case .keyNotFound(let k, let ctx): return "Missing key '\(k.stringValue)' at \(path(ctx))"
        case .typeMismatch(let t, let ctx): return "Type mismatch (\(t)) at \(path(ctx))"
        case .valueNotFound(let t, let ctx): return "Null for \(t) at \(path(ctx))"
        case .dataCorrupted(let ctx): return ctx.debugDescription
        @unknown default: return "Unknown decoding error"
        }
    }
    private static func path(_ ctx: DecodingError.Context) -> String {
        ctx.codingPath.map(\.stringValue).joined(separator: ".")
    }
}
