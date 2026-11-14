import SwiftUI

/// One TikTok channel's posting settings in Compose — the same rules as the
/// web's TikTokPostSettings (TikTok's Content Sharing Guidelines): the
/// creator's nickname is shown, visibility has NO default and lists exactly the
/// creator's options, Comment/Duet/Stitch start off and are greyed (with the
/// reason written out) when the creator turned them off, commercial disclosure
/// is off by default, and branded content can't be private.
struct TikTokChannelSettings: View {
    let channel: Channel
    let result: TikTokCreatorInfoResult?
    let loadError: String?
    @Binding var draft: TikTokDraft
    let onRetry: () -> Void

    var body: some View {
        Section {
            if let loadError {
                blocked(loadError)
            } else if let result {
                if result.canPost, let info = result.creator {
                    ready(info)
                } else {
                    blocked(result.reason ?? "This TikTok account can't post right now. Try again later.")
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Loading this account's TikTok settings…").font(.footnote).foregroundStyle(.secondary)
                }
            }
        } header: {
            HStack(spacing: 6) {
                Text("TikTok · \(result?.creator?.nickname.isEmpty == false ? result!.creator!.nickname : channel.name)")
                if let u = result?.creator?.username, !u.isEmpty { Text("@\(u)").textCase(nil) }
            }
        }
    }

    private func blocked(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(message, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange)
            Button("Check again", action: onRetry).font(.footnote)
        }
    }

    @ViewBuilder
    private func ready(_ info: TikTokCreatorInfo) -> some View {
        let brandedOn = draft.discloseCommercial && draft.brandContent
        Picker(TikTokText.privacyPlaceholder, selection: Binding(
            get: { draft.privacyLevel.flatMap { info.privacyLevelOptions.contains($0) ? $0 : nil } ?? "" },
            set: { level in
                // Menu pickers don't reliably honour a disabled row — refuse here too.
                if level == "SELF_ONLY" && draft.discloseCommercial && draft.brandContent { return }
                draft.privacyLevel = level.isEmpty ? nil : level
            }
        )) {
            Text("Choose…").tag("")
            ForEach(info.privacyLevelOptions, id: \.self) { level in
                Text(TikTokText.privacyLabels[level] ?? level)
                    .tag(level)
                    .disabled(level == "SELF_ONLY" && brandedOn)
            }
        }
        if brandedOn && info.privacyLevelOptions.contains("SELF_ONLY") {
            Text(TikTokText.brandedPrivate).font(.caption).foregroundStyle(.secondary)
        }

        interaction("Allow comments", isOn: $draft.allowComment, off: info.commentDisabled)
        interaction("Allow Duet", isOn: $draft.allowDuet, off: info.duetDisabled)
        interaction("Allow Stitch", isOn: $draft.allowStitch, off: info.stitchDisabled)

        Toggle(isOn: $draft.discloseCommercial) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Disclose commercial content")
                Text("Turn on to disclose that this video promotes goods or services in exchange for something of value. It could promote yourself, a third party, or both.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        if draft.discloseCommercial {
            Toggle(isOn: $draft.brandOrganic) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Your brand")
                    Text("You are promoting yourself or your own business.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Toggle(isOn: $draft.brandContent) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Branded content")
                    Text("You are promoting another brand or a third party.").font(.caption).foregroundStyle(.secondary)
                    if draft.privacyLevel == "SELF_ONLY" {
                        Text(TikTokText.brandedPrivate).font(.caption).foregroundStyle(.orange)
                    }
                }
            }
            // Branded content can't be private — blocked while "Only me" is
            // chosen, unless it's already on (so it can be switched off).
            .disabled(draft.privacyLevel == "SELF_ONLY" && !draft.brandContent)
            if !draft.brandOrganic && !draft.brandContent {
                Text(TikTokText.commercialHint).font(.caption).foregroundStyle(.orange)
            }
            if let label = TikTokText.commercialLabel(draft) {
                Text(label).font(.caption.weight(.semibold))
            }
        }

        Toggle(isOn: $draft.isAigc) {
            VStack(alignment: .leading, spacing: 2) {
                Text("AI-generated content")
                Text("Label this video as AI-generated on TikTok.").font(.caption).foregroundStyle(.secondary)
            }
        }
        if let max = info.maxVideoPostDurationSec {
            Text("This account can post videos up to \(Self.duration(max)).").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func interaction(_ label: String, isOn: Binding<Bool>, off: Bool) -> some View {
        Toggle(isOn: isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                if off { Text(TikTokText.interactionOff).font(.caption).foregroundStyle(.secondary) }
            }
        }
        // A setting the creator turned off can't be switched on — but one that is
        // already on can still be switched off, or the post would be stuck.
        .disabled(off && !isOn.wrappedValue)
    }

    static func duration(_ sec: Double) -> String {
        let s = Int(sec.rounded())
        return s >= 60 ? "\(s / 60) min\(s % 60 == 0 ? "" : " \(s % 60) s")" : "\(s) s"
    }
}
