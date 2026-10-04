// Attaching files from the Mac (DESIGN.md "Attachments"), shared by the two places that take them:
// a New session's draft editor (the list is the draft's promptAttachments) and a ticket's message
// composer (the list goes with the next message). A file on disk is registered by its path when
// the service is on this Mac; anything else (pasted image data, an image dragged out of a browser,
// a file for a service on another machine) is uploaded. Either shows as a pending row until the
// service answers with its Attachment, which is what the list holds. The caller owns the list:
// `get` reads it and `set` replaces it.

import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { MAX_PROMPT_ATTACHMENTS, type Attachment } from "@harness/shared";
import { addAttachments, removeAttachment } from "@harness/shared/state";
import { useStore } from "../state/store";
import { clipboardImageFiles, isFileDrag, isLocalService, limitMessage, planFiles } from "../state/promptAttachmentFiles";
import { forgetPreview, rememberPreview, type PendingUpload } from "./PromptAttachments";

export interface PromptAttachmentTarget {
  get: () => readonly Attachment[];
  set: (list: Attachment[]) => void;
}

export function usePromptAttachmentInput({
  target,
  enabled = true,
  what = "a session",
}: {
  /** The list to add to, or null while there's nowhere to attach (no session yet). */
  target: PromptAttachmentTarget | null;
  /** False: drops and pastes aren't taken (a paste then pastes as usual). */
  enabled?: boolean;
  /** What the limit applies to, for its toast ("a session", "a message"). */
  what?: string;
}) {
  const { client, toast } = useStore();
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const on = enabled && !!target;

  const attachAll = (t: PromptAttachmentTarget, added: Attachment[], skippedBefore = 0) => {
    const current = t.get();
    const { list, skipped } = addAttachments(current, added);
    if (list.length !== current.length) t.set(list);
    const message = limitMessage(skipped + skippedBefore, MAX_PROMPT_ATTACHMENTS, what);
    if (message) toast(message, "error");
  };

  /** Attach `files`; false when none of them was something to attach (a paste then pastes as usual). */
  const attachFiles = (files: File[], uploadAny: boolean): boolean => {
    // Uploads that finish later go to the list they were started for.
    const t = target;
    if (!t || !enabled || !files.length) return false;
    const plan = planFiles(files, (f) => window.harness?.pathForFile(f) ?? null, { uploadAny, local: isLocalService(client.baseUrl) });
    // A file already in the list (or twice in this batch) isn't registered again.
    const have = new Set(t.get().map((a) => a.path));
    const registers = plan.registers.filter((r) => !have.has(r.path) && (have.add(r.path), true));
    if (!registers.length && !plan.uploads.length) return plan.registers.length > 0;
    const jobs = [
      ...registers.map((r) => ({ name: r.name, file: r.file, run: () => client.registerAttachment(r.path, r.name) })),
      ...plan.uploads.map((u) => ({ name: u.name, file: u.file, run: () => client.uploadAttachment(u.file, u.name, u.mimeType) })),
    ];
    // Room left (counting what's already on its way): the rest isn't registered or uploaded at all.
    const room = Math.max(0, MAX_PROMPT_ATTACHMENTS - t.get().length - pending.length);
    const taken = jobs.slice(0, room);
    const message = limitMessage(jobs.length - taken.length, MAX_PROMPT_ATTACHMENTS, what);
    if (message) toast(message, "error");
    // All at once, but added in the order they were dropped or picked, whichever answers first.
    let previous: Promise<unknown> = Promise.resolve();
    for (const job of taken) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setPending((p) => [...p, { id, name: job.name }]);
      const running = job.run();
      previous = previous
        .then(() => running)
        .then(
          (a) => {
            // The row shows the picture from the file in hand, without a round trip.
            rememberPreview(a.id, job.file);
            attachAll(t, [a]);
          },
          (e: unknown) => toast(`Couldn't attach ${job.name}: ${e instanceof Error ? e.message : String(e)}`, "error"),
        )
        .finally(() => setPending((p) => p.filter((x) => x.id !== id)));
    }
    return true;
  };

  const remove = (index: number) => {
    if (!target) return;
    const list = target.get();
    const gone = list[index];
    target.set(removeAttachment(list, index));
    if (gone) forgetPreview(gone.id);
  };

  /** The textarea's onPaste: text pastes as text; files (a Finder copy, a screenshot) are attached instead. */
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length && attachFiles(files, false)) e.preventDefault();
  };

  /** "Paste image": the image on the system clipboard, read without a paste event (a menu item). */
  const pasteFromClipboard = async () => {
    if (!on) return;
    let files: File[] = [];
    try {
      files = await clipboardImageFiles(await navigator.clipboard.read());
    } catch {
      files = [];
    }
    if (!files.length || !attachFiles(files, false)) toast("There's no image on the clipboard.", "info");
  };

  const dragOver = (e: DragEvent) => {
    if (!on || !isFileDrag(e.dataTransfer?.types)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const dragEnter = (e: DragEvent) => {
    if (!on || !isFileDrag(e.dataTransfer?.types)) return;
    dragOver(e);
    dragDepth.current++;
    setDropping(true);
  };
  const dragLeave = (e: DragEvent) => {
    if (!isFileDrag(e.dataTransfer?.types)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDropping(false);
  };
  const drop = (e: DragEvent) => {
    if (!isFileDrag(e.dataTransfer?.types)) return;
    dragDepth.current = 0;
    setDropping(false);
    // Not taken (an approval waits): the window's drop guard swallows it.
    if (!on) return;
    e.preventDefault();
    attachFiles(Array.from(e.dataTransfer.files), true);
  };

  return {
    pending,
    dropping: dropping && on,
    fileInput,
    attachFiles,
    remove,
    onPaste,
    pasteFromClipboard,
    /** Spread on the element that takes drops. */
    dropProps: { onDragEnter: dragEnter, onDragOver: dragOver, onDragLeave: dragLeave, onDrop: drop },
    /** The hidden multi-select file input the Attach button / "Choose files…" clicks. */
    pickFiles: () => fileInput.current?.click(),
    onFilesPicked: (e: { target: HTMLInputElement }) => {
      attachFiles(Array.from(e.target.files ?? []), true);
      e.target.value = "";
    },
  };
}
