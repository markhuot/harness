// URLs the OS opens the app with. harness://file/… is rewritten for the file viewer (see
// fileScreenHref); everything else (harness://pair, harness://settings, …) routes by its path as before.
import { fileScreenHref } from "../src/lib/fileViewer";

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return fileScreenHref(path) ?? path;
  } catch {
    return path;
  }
}
