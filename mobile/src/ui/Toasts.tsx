// Toasts below the status bar (errors stay longer), like the desktop's bottom-right stack.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "../state/app";
import { Icon } from "./Icon";

interface Toast {
  id: number;
  message: string;
  kind: "error" | "info";
}

const Ctx = createContext<(message: string, kind?: "error" | "info") => void>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const insets = useSafeAreaInsets();
  const c = useColors();
  const toast = useCallback((message: string, kind: "error" | "info" = "error") => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-2), { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 2600);
  }, []);
  const value = useMemo(() => toast, [toast]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <View pointerEvents="box-none" style={{ position: "absolute", top: insets.top + 6, left: 12, right: 12, gap: 8 }}>
        {toasts.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
            accessibilityRole="alert"
            style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", padding: 12, borderRadius: 14, backgroundColor: c.bgElev, borderWidth: 1, borderColor: t.kind === "error" ? c.red : c.border, shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } }}
          >
            <Icon name={t.kind === "error" ? "alert" : "checkCircle"} size={16} color={t.kind === "error" ? c.red : c.green} strokeWidth={2} />
            <Text style={{ color: c.text, fontSize: 14.5, flex: 1, lineHeight: 20 }} selectable>
              {t.message}
            </Text>
          </Pressable>
        ))}
      </View>
    </Ctx.Provider>
  );
}
