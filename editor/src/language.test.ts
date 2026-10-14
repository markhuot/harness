import { describe, expect, test } from "bun:test";
import { BUNDLED_LANGUAGES, PLAIN, resolveLanguage } from "./language";
import { langForPath } from "@harness/shared/diff";

describe("resolveLanguage", () => {
  test("a Terraform file is HCL, the language the Changes tab highlights it in", () => {
    expect(resolveLanguage("infra/main.tf")).toBe("hcl");
    expect(resolveLanguage("infra/main.tf")).toBe(langForPath("infra/main.tf") as string);
  });
  test("paths, bare extensions and language names land on one Shiki language", () => {
    expect(resolveLanguage("src/app.ts")).toBe("typescript");
    expect(resolveLanguage("ts")).toBe("typescript");
    expect(resolveLanguage("typescript")).toBe("typescript");
    expect(resolveLanguage("deploy.sh")).toBe("shellscript");
    expect(resolveLanguage("resources/views/a.blade.php")).toBe("blade");
    expect(resolveLanguage("Dockerfile")).toBe("docker");
    expect(resolveLanguage(".env.local")).toBe("dotenv");
  });
  test("nothing, or a name for plain text, is plain text", () => {
    expect(resolveLanguage(undefined)).toBe(PLAIN);
    expect(resolveLanguage("")).toBe(PLAIN);
    expect(resolveLanguage("notes.txt")).toBe(PLAIN);
    expect(resolveLanguage("plaintext")).toBe(PLAIN);
  });
  test("a supported set (the iOS bundle) turns every other language into plain text", () => {
    const ios = new Set(BUNDLED_LANGUAGES);
    expect(resolveLanguage("main.tf", ios)).toBe("hcl");
    expect(resolveLanguage("a.zig", ios)).toBe(PLAIN);
    expect(resolveLanguage("a.ts", new Set(["python"]))).toBe(PLAIN);
  });
  test("every language the app maps a common extension to is one the iOS bundle carries", () => {
    const ios = new Set(BUNDLED_LANGUAGES);
    for (const file of ["a.ts", "a.tsx", "a.js", "a.json", "a.yml", "a.toml", "a.php", "a.rb", "a.py", "a.go", "a.rs", "a.swift", "a.kt", "a.java", "a.c", "a.cpp", "a.cs", "a.css", "a.html", "a.xml", "a.md", "a.sql", "a.tf", "Dockerfile", "Makefile"]) {
      expect([file, resolveLanguage(file, ios)]).not.toEqual([file, PLAIN]);
    }
  });
});
