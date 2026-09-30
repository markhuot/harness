// Opening links in markdown: http(s) and mailto go to Safari (or Mail); a file link
// (harness://file/…, or a bare relative path) opens the file viewer, resolved in the ticket or
// project the markdown belongs to, which the screen that renders it provides with FileLinkScope.

import { createContext, useContext, type ReactNode } from "react";
import { Linking } from "react-native";
import { useRouter } from "expo-router";
import { parseFileLink } from "@harness/shared";
import { fileRouteFor, type FileLinkContext } from "../lib/fileViewer";
import { useMaybeStore } from "../state/store";

const Ctx = createContext<FileLinkContext>({});

export function FileLinkScope({ ticketKey, projectId, children }: FileLinkContext & { children: ReactNode }) {
  return <Ctx.Provider value={{ ticketKey, projectId }}>{children}</Ctx.Provider>;
}

export function useOpenLink() {
  const ctx = useContext(Ctx);
  const router = useRouter();
  const store = useMaybeStore();
  return (url: string) => {
    const link = /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^harness:/i.test(url) ? null : parseFileLink(url);
    if (!link) return void Linking.openURL(url).catch(() => store?.toast("Couldn't open that link", "error"));
    const params = fileRouteFor(link, ctx);
    if (!params) return store?.toast("That file link doesn't say which ticket or project it's in", "error");
    router.push({ pathname: "/file", params: { ...params } });
  };
}
