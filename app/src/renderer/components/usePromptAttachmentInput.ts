// Attaching files to a prompt from the Mac (DESIGN.md "Prompt attachments"), shared by the two
// places that take them: a New session's draft editor (the list is the draft's promptAttachments)
// and a ticket's message composer (the list goes with the next message). Files on disk go in by
// path; anything else (pasted image data, an image dragged out of a browser, a file for a service
// on another machine) is uploaded first, showing as a pending row until it's there. The caller owns
// the list: `get` reads it and `set` replaces it.

import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { MAX_PROMPT_ATTACHMENTS, type PromptAttachment, type PromptAttachmentInput } from "@harness/shared";
import { addPromptAttachments, removePromptAttachment } from "@harness/shared/state";
import { useStore } from "../state/store";
import { clipboardImageFiles, isFileDrag, isLocalService, limitMessage, planFiles } from "../state/promptAttachmentFiles";
import { forgetPreview, rememberPreview, type PendingUpload } from "./PromptAttachments";

export interface PromptAttachmentTarget {
  get: () => readonly PromptAttachment[];
  set: (list: PromptAttachment[]) => void;
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

  const attachInputs = (t: PromptAttachmentTarget, inputs: PromptAttachmentInput[], skippedBefore = 0) => {
    const current = t.get();
    const { list, skipped } = addPromptAttachments(current, inputs);
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
    if (!plan.byPath.length && !plan.uploads.length) return false;
    for (const { input, file } of plan.byPath) rememberPreview(input.path, file);
    // Room left once the files on disk are in (and the uploads already on their way): the rest isn't uploaded at all.
    const room = Math.max(0, MAX_PROMPT_ATTACHMENTS - t.get().length - plan.byPath.length - pending.length);
    const uploads = plan.uploads.slice(0, room);
    attachInputs(t, plan.byPath.map((p) => p.input), plan.uploads.length - uploads.length);
    for (const u of uploads) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setPending((p) => [...p, { id, name: u.name }]);
      client
        .uploadPromptAttachment(u.file, u.name, u.mimeType)
        .then(
          (a) => {
            rememberPreview(a.path, u.file);
            attachInputs(t, [a]);
          },
          (e: unknown) => toast(`Couldn't attach ${u.name}: ${e instanceof Error ? e.message : String(e)}`, "error"),
        )
        .finally(() => setPending((p) => p.filter((x) => x.id !== id)));
    }
    return true;
  };

  const remove = (index: number) => {
    if (!target) return;
    const list = target.get();
    const gone = list[index];
    target.set(removePromptAttachment(list, index));
    if (gone) forgetPreview(gone.path);
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
