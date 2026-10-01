#if DEBUG
import HarnessKit
import SwiftUI

/// Debug screen for the content components until the Summaries tab renders them: sample markdown
/// (headings, lists, a table, code in several languages, a diff, ticket keys, file links) and the
/// summaries of one ticket with their attachments. Launch with `-debugScreen content`, and
/// `-debugTicket KEY` to pick the ticket whose summaries show (default GREET-1).
struct ContentPreviewView: View {
    @AppStorage("debugTicket") private var ticketKey = "GREET-1"
    @Environment(BoardStore.self) private var store
    @Environment(\.palette) private var c
    @State private var summaries: [Summary] = []
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ForEach(summaries) { s in
                    VStack(alignment: .leading, spacing: 6) {
                        MarkdownView(text: s.body)
                        AttachmentRow(attachments: s.attachments)
                    }
                    .padding(12)
                    .background(c.bgElev, in: .rect(cornerRadius: 12))
                }
                if let error { Text(error).foregroundStyle(c.red) }
                MarkdownView(text: Self.sample)
                    .padding(12)
                    .background(c.bgElev, in: .rect(cornerRadius: 12))
                CodeBlockView(code: Self.lines, language: "ts", showLineNumbers: true, highlightLines: 2...3)
            }
            .padding()
        }
        .fileLinkScope(ticketKey: ticketKey)
        .navigationTitle("Content")
        .task {
            do { summaries = try await store.client.listSummaries(ticketKey) } catch { self.error = "\(error)" }
        }
    }

    static let lines = """
    import { greet } from "./greet";
    const name = process.argv[2] ?? "world";
    console.log(greet(name));
    """

    static let sample = #"""
    ## Summary

    Fixed the greeting in [src/greet.ts:3](harness://file/src/greet.ts#L3) and the README (README.md); see GREET-2 and **not** UTF-8 or SHA-256. Docs live at [example.com](https://example.com), and `bun test` passes.

    ### Checklist
    - Rewrote *greet* with an `Intl` fallback
    - Added tests for [the edge cases](src/greet.test.ts#L10-L24)
    - A long item that wraps across more than one line, so the bullet stays on the first line while the rest flows below it

    1. Build
    2. Test
    3. Ship

    > Quoted context from the ticket, with a link to GREET-1.

    | File | Change | Lines |
    | --- | :-: | --: |
    | `src/greet.ts` | Rewrote the greeting so it falls back to English when the locale isn't one we know, which is a long cell that wraps | 42 |
    | README.md | Usage | 3 |

    ---

    ```swift
    struct Point: Equatable {
        var x = 0.5 // a comment
        func moved(by d: Double) -> Point { Point(x: x + d) }
    }
    ```

    ```python
    def greet(name: str) -> str:
        return f"Hello, {name}!"  # friendly
    ```

    ```json
    { "name": "greet", "version": "1.2.0", "private": true }
    ```

    ```diff
    diff --git a/src/greet.ts b/src/greet.ts
    --- a/src/greet.ts
    +++ b/src/greet.ts
    @@ -1,3 +1,3 @@
     export function greet(name: string) {
    -  return "Hi " + name;
    +  return `Hello, ${name}!`;
     }
    ```
    """#
}
#endif
