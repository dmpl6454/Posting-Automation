import SwiftUI

/// Calendar view of posts — the web CalendarTab's rules: a post sits on its
/// scheduled date, else published, else created (PostRules.calendarDate); the
/// newest posts are loaded a page at a time up to a limit, and the screen SAYS
/// when it stopped short rather than showing a quietly incomplete month.
struct PostsCalendarView: View {
    let filter: PostStatus?
    @Environment(SessionStore.self) private var session
    @State private var month = Calendar.current.date(from: Calendar.current.dateComponents([.year, .month], from: Date()))!
    @State private var selectedDay = Calendar.current.startOfDay(for: Date())
    @State private var posts: [Post] = []
    @State private var stoppedShort = false
    @State private var loading = false
    @State private var error: String?

    static let pageSize = 100
    static let maxPages = 5

    private var cal: Calendar { .current }
    private var byDay: [Date: [Post]] { PostRules.postsByDay(posts, calendar: cal) }

    var body: some View {
        List {
            Section {
                header
                grid
            }
            if stoppedShort {
                Section {
                    Text("Showing your latest \(posts.count) posts. Older ones aren't on the calendar — use the list view to find them.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            if let error {
                Section { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            Section(selectedDay.formatted(date: .complete, time: .omitted)) {
                let day = (byDay[selectedDay] ?? []).sorted { PostRules.calendarDate($0) < PostRules.calendarDate($1) }
                if day.isEmpty {
                    Text(loading ? "Loading…" : "No posts on this day.").foregroundStyle(.secondary)
                } else {
                    ForEach(day) { post in
                        NavigationLink(value: post) {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    StatusBadge(status: post.status)
                                    Spacer()
                                    Text(PostRules.calendarDate(post), format: .dateTime.hour().minute())
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Text(post.content.isEmpty ? "(no caption)" : post.content).font(.subheadline).lineLimit(2)
                            }
                        }
                    }
                }
            }
        }
        .refreshable { await load() }
        .task(id: filter) { await load() }
    }

    private var header: some View {
        HStack {
            Button { shiftMonth(-1) } label: { Image(systemName: "chevron.left") }
                .accessibilityLabel("Previous month")
            Spacer()
            Text(month.formatted(.dateTime.month(.wide).year())).font(.headline)
            Spacer()
            Button { shiftMonth(1) } label: { Image(systemName: "chevron.right") }
                .accessibilityLabel("Next month")
        }
        .buttonStyle(.borderless)
    }

    private var grid: some View {
        let days = monthDays()
        let symbols = cal.veryShortWeekdaySymbols
        let first = cal.firstWeekday - 1
        let ordered = Array(symbols[first...] + symbols[..<first])
        return VStack(spacing: 6) {
            HStack {
                ForEach(Array(ordered.enumerated()), id: \.offset) { _, s in
                    Text(s).font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 7), spacing: 6) {
                ForEach(Array(days.enumerated()), id: \.offset) { _, day in
                    if let day {
                        dayCell(day)
                    } else {
                        Color.clear.frame(height: 40)
                    }
                }
            }
        }
    }

    private func dayCell(_ day: Date) -> some View {
        let count = byDay[day]?.count ?? 0
        let isSelected = cal.isDate(day, inSameDayAs: selectedDay)
        let isToday = cal.isDateInToday(day)
        let failed = byDay[day]?.contains { $0.status == .FAILED } ?? false
        return Button {
            selectedDay = day
        } label: {
            VStack(spacing: 3) {
                Text("\(cal.component(.day, from: day))")
                    .font(.callout.weight(isToday ? .bold : .regular))
                    .foregroundStyle(isSelected ? .white : (isToday ? Color.accentColor : .primary))
                Circle()
                    .fill(count == 0 ? .clear : (failed ? Color.red : (isSelected ? .white : Color.accentColor)))
                    .frame(width: 5, height: 5)
            }
            .frame(maxWidth: .infinity, minHeight: 40)
            .background(isSelected ? Color.accentColor : .clear, in: RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("\(day.formatted(date: .long, time: .omitted)), \(count) post\(count == 1 ? "" : "s")")
    }

    /// The month's days, padded with nils so the first lands on its weekday.
    private func monthDays() -> [Date?] {
        guard let range = cal.range(of: .day, in: .month, for: month) else { return [] }
        let firstWeekday = cal.component(.weekday, from: month)
        let lead = (firstWeekday - cal.firstWeekday + 7) % 7
        var out: [Date?] = Array(repeating: nil, count: lead)
        for d in range {
            out.append(cal.date(byAdding: .day, value: d - 1, to: month).map { cal.startOfDay(for: $0) })
        }
        while out.count % 7 != 0 { out.append(nil) }
        return out
    }

    private func shiftMonth(_ by: Int) {
        guard let next = cal.date(byAdding: .month, value: by, to: month) else { return }
        month = next
        if !cal.isDate(selectedDay, equalTo: next, toGranularity: .month) {
            selectedDay = cal.isDate(Date(), equalTo: next, toGranularity: .month) ? cal.startOfDay(for: Date()) : next
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        var all: [Post] = []
        var cursor: String?
        var pages = 0
        do {
            repeat {
                let page: PostListPage = try await TRPCClient.shared.query(
                    "post.list",
                    input: PostListInput(status: filter?.rawValue, limit: Self.pageSize, cursor: cursor)
                )
                all += page.posts
                cursor = page.nextCursor
                pages += 1
            } while cursor != nil && pages < Self.maxPages
            posts = all
            stoppedShort = cursor != nil
            error = nil
        } catch let e as APIError where e.isUnauthorized {
            await session.handleUnauthorized()
        } catch {
            if posts.isEmpty { posts = all }
            self.error = error.localizedDescription
        }
    }
}
