import Foundation

// Web-parity Phase 7: Create with AI, Repurpose, Super Agent.

/// Arbitrary JSON, so an AI action's `payload` round-trips to
/// `chat.executeAction` exactly as the server produced it.
enum JSONValue: Codable, Equatable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    init(from d: Decoder) throws {
        let c = try d.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to e: Encoder) throws {
        var c = e.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    subscript(key: String) -> JSONValue? { if case .object(let o) = self { return o[key] }; return nil }
}

// MARK: Super Agent

struct ChatAction: Codable, Equatable {
    var type: String
    var payload: [String: JSONValue]
    /// Stamped by the server; the stable lock + `clientActionId` key.
    var idempotencyKey: String?
}

struct ChatThreadSummary: Decodable, Identifiable {
    struct Last: Decodable { var content: String; var role: String }
    var id: String
    var title: String
    var updatedAt: Date?
    var messages: [Last]?
    var preview: String? { messages?.first?.content }
}

struct ChatAttachment: Decodable, Equatable {
    struct Media: Decodable, Equatable { var id: String; var url: String; var thumbnailUrl: String?; var fileType: String? }
    var media: Media
}

struct ChatMessageDTO: Decodable, Identifiable, Equatable {
    var id: String
    var role: String
    var content: String
    var createdAt: Date?
    var action: ChatAction?
    var executedActionId: String?
    var provider: String?
    var attachments: [ChatAttachment]

    enum K: String, CodingKey { case id, role, content, createdAt, metadata, attachments }
    private struct Meta: Decodable { var action: ChatAction?; var executedActionId: String?; var provider: String? }

    init(id: String, role: String, content: String, action: ChatAction? = nil) {
        self.id = id; self.role = role; self.content = content
        createdAt = Date(); self.action = action; attachments = []
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id)
        role = (try? c.decode(String.self, forKey: .role)) ?? "assistant"
        content = (try? c.decode(String.self, forKey: .content)) ?? ""
        createdAt = try? c.decodeIfPresent(Date.self, forKey: .createdAt)
        let meta = try? c.decodeIfPresent(Meta.self, forKey: .metadata)
        action = meta?.action
        executedActionId = meta?.executedActionId
        provider = meta?.provider
        attachments = (try? c.decodeIfPresent([ChatAttachment].self, forKey: .attachments)) ?? []
    }
}

struct ChatThreadDetail: Decodable {
    var id: String
    var title: String
    var messages: [ChatMessageDTO]
}

enum ChatStreamEvent: Equatable {
    case chunk(String)
    case done(displayText: String?, action: ChatAction?)
    case error(String)

    /// One SSE line → an event. Anything that isn't a known `data:` JSON event is ignored.
    static func parse(line: String) -> ChatStreamEvent? {
        guard line.hasPrefix("data:") else { return nil }
        let json = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        struct Raw: Decodable { var type: String; var content: String?; var displayText: String?; var action: ChatAction?; var message: String? }
        guard let raw = try? JSONDecoder().decode(Raw.self, from: Data(json.utf8)) else { return nil }
        switch raw.type {
        case "chunk": return .chunk(raw.content ?? "")
        case "done": return .done(displayText: raw.displayText, action: raw.action)
        case "error": return .error(raw.message ?? "The assistant couldn't reply.")
        default: return nil
        }
    }
}

// MARK: Repurpose

struct RepurposeResult: Decodable {
    struct Extracted: Decodable { var title: String?; var siteName: String?; var url: String? }
    struct Media: Decodable { var url: String; var mediaId: String? }
    var extracted: Extracted?
    var platformContent: [String: String]
    var mediaUrls: [String]
    var mediaMap: [String: Media]?
    var carouselMediaIds: [String]?
    var format: String
    var mediaFailed: Bool?
    var renderedHeadline: String?
}

struct RepurposeDraftInput: Encodable, Equatable {
    let content: String
    let contentVariants: [String: String]
    let channelIds: [String]
    let mediaIds: [String]
    let aiGenerated = true
}

enum AIRules {
    static let tones = ["professional", "casual", "humorous", "formal", "inspiring"]
    static let postActions: Set<String> = ["publish_now", "schedule_post", "bulk_schedule"]
    static let mediaRequiredPlatforms: Set<String> = ["INSTAGRAM", "FACEBOOK"]

    /// The web's actionKey: the server-stamped idempotencyKey, else the message id.
    static func actionKey(_ m: ChatMessageDTO) -> String { m.action?.idempotencyKey ?? m.id }

    /// Actions already run, from the persisted `executedActionId` markers — so
    /// "Done" survives a reload and a re-tap can't create a second live post.
    static func executedKeys(_ messages: [ChatMessageDTO]) -> Set<String> {
        Set(messages.compactMap(\.executedActionId).filter { !$0.isEmpty })
    }

    /// Post actions carry the thread's attached images, as on the web.
    static func payloadWithMedia(_ action: ChatAction, mediaIds: [String]) -> [String: JSONValue] {
        var p = action.payload
        if postActions.contains(action.type), !mediaIds.isEmpty, p["mediaIds"] == nil {
            p["mediaIds"] = .array(mediaIds.map { .string($0) })
        }
        return p
    }

    static func actionTitle(_ type: String) -> String {
        type.replacingOccurrences(of: "_", with: " ").capitalized
    }

    /// Media for the draft: carousel slides in order, else each distinct image.
    static func repurposeMediaIds(_ r: RepurposeResult) -> [String] {
        if let ids = r.carouselMediaIds, !ids.isEmpty { return ids }
        var seen = Set<String>(), out: [String] = []
        for key in (r.mediaMap ?? [:]).keys.sorted() {
            if let id = r.mediaMap?[key]?.mediaId, !id.isEmpty, seen.insert(id).inserted { out.append(id) }
        }
        return out
    }

    /// The web's shouldBlockMediaLessPublish, for image formats.
    static func mediaLessBlock(mediaIds: [String], selectedPlatforms: [String]) -> String? {
        guard mediaIds.isEmpty, selectedPlatforms.contains(where: mediaRequiredPlatforms.contains) else { return nil }
        return "No image was produced. Instagram and Facebook need one — try again, or remove those channels."
    }

    /// The draft request: the first caption is the default, every platform's
    /// caption rides as a variant (exactly what the web's Create Drafts sends).
    static func draftInput(_ r: RepurposeResult, channels: [Channel]) -> RepurposeDraftInput {
        let platforms = channels.map(\.platform.raw)
        let first = platforms.compactMap { r.platformContent[$0] }.first
            ?? r.platformContent.keys.sorted().compactMap { r.platformContent[$0] }.first ?? ""
        return RepurposeDraftInput(content: first, contentVariants: r.platformContent,
                                   channelIds: channels.map(\.id), mediaIds: repurposeMediaIds(r))
    }
}
