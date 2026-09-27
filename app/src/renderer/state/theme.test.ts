import { expect, test } from "bun:test";
import { currentTheme } from "./theme";

test("currentTheme reads <html data-theme>, else falls back to a resolved theme", () => {
  const doc = (theme?: string) => ({ documentElement: { dataset: theme ? { theme } : {} } }) as unknown as Document;
  expect(currentTheme(doc("dark"))).toBe("dark");
  expect(currentTheme(doc("light"))).toBe("light");
  expect(["light", "dark"]).toContain(currentTheme(doc("sepia")));
  expect(["light", "dark"]).toContain(currentTheme(doc()));
});
