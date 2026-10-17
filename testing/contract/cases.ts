// Wire fixtures, generated from the types in shared/src/protocol.ts with the TypeScript checker.
// protocol.ts has no runtime schemas, so the checker is the one source that can't drift from the
// types: rename or retype a field there and the generated JSON changes with it, and the Swift side
// (testing/swift, ContractTests) then fails to decode or re-encode it.
//
// Each exported type gets several cases:
//   max   every optional field present, every `T | null` field set
//   min   every optional field absent, every `T | null` field null
//   null  every optional field present, `T | null` fields null (a patch field's "clear it")
// and each of those repeats once per member of the widest union inside the type, so every string
// literal and every discriminated-union variant appears in at least one case.

import ts from "typescript";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface WireCase {
  label: string;
  json: Json;
  /** JSON path (`$.ticket.runs[0]`) of each object whose type has a name → that type's name, so a field Swift drops can be traced to the type that owns it */
  owners: Record<string, string>;
}

export interface Generated {
  /** Exported interface and type alias name → its cases */
  types: Record<string, WireCase[]>;
  /** Every string literal union a type alias is made of (the values Swift's enum must know) */
  literals: Record<string, string[]>;
  /** Exported `as const` string arrays (`TICKET_STATUSES`) → their values */
  consts: Record<string, string[]>;
  /** Exported names that carry no wire data, with why */
  skipped: Record<string, string>;
}

type Mode = "max" | "min" | "null";
const MODES: Mode[] = ["max", "min", "null"];
/** Past this nesting an optional field is dropped and a required array is empty, so recursive types end */
const MAX_DEPTH = 6;

export function protocolProgram(file: string): ts.Program {
  return ts.createProgram([file], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
  });
}

/** The declared name of an object type (`Ticket`), when it has one that isn't from TypeScript's own lib */
function typeName(type: ts.Type): string | undefined {
  const own = type.symbol?.name;
  if (own && !own.startsWith("__")) return own;
  const alias = type.aliasSymbol;
  if (alias && alias.declarations?.every((d) => !d.getSourceFile().fileName.includes("node_modules/typescript"))) return alias.name;
  return undefined;
}

class Sampler {
  /** The widest union met while sampling one case; the next index covers its other members */
  width = 1;
  owners: Record<string, string> = {};

  constructor(
    private checker: ts.TypeChecker,
    private mode: Mode,
    private index: number,
  ) {}

  sample(type: ts.Type, name: string, depth: number, path: string): Json | undefined {
    const c = this.checker;
    if (type.flags & ts.TypeFlags.StringLiteral) return (type as ts.StringLiteralType).value;
    if (type.flags & ts.TypeFlags.NumberLiteral) return (type as ts.NumberLiteralType).value;
    if (type.flags & ts.TypeFlags.BooleanLiteral) return c.typeToString(type) === "true";
    if (type.flags & ts.TypeFlags.Null) return null;
    if (type.flags & ts.TypeFlags.Undefined) return undefined;
    if (type.flags & ts.TypeFlags.String) return `${name}-sample`;
    if (type.flags & ts.TypeFlags.Number) return 3;
    if (type.flags & ts.TypeFlags.Boolean) return true;
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { sample: name };
    if (type.isUnion()) return this.union(type, name, depth, path);
    if (type.isIntersection()) return this.object(type, name, depth, path);
    if (c.isTupleType(type)) return c.getTypeArguments(type as ts.TypeReference).map((t, i) => this.sample(t, `${name}${i}`, depth + 1, `${path}[${i}]`) ?? null);
    if (c.isArrayType(type)) {
      if (depth > MAX_DEPTH) return [];
      const element = c.getTypeArguments(type as ts.TypeReference)[0]!;
      const item = this.sample(element, name, depth + 1, `${path}[0]`);
      return item === undefined ? [] : [item];
    }
    if (type.flags & ts.TypeFlags.Object) return this.object(type, name, depth, path);
    throw new Error(`contract: can't make a sample for ${c.typeToString(type)} (field "${name}")`);
  }

  private union(type: ts.UnionType, name: string, depth: number, path: string): Json | undefined {
    // `boolean` is `true | false` to the checker: sample it as one value
    const members = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
    const nullable = type.types.some((t) => t.flags & ts.TypeFlags.Null);
    const optional = type.types.some((t) => t.flags & ts.TypeFlags.Undefined);
    if (nullable && this.mode !== "max") return null;
    if (optional && !nullable && this.mode === "min") return undefined;
    if (members.length === 2 && members.every((t) => t.flags & ts.TypeFlags.BooleanLiteral)) return true;
    this.width = Math.max(this.width, members.length);
    const pick = members[this.index % members.length]!;
    return this.sample(pick, name, depth, path);
  }

  private object(type: ts.Type, name: string, depth: number, path: string): Json | undefined {
    const c = this.checker;
    const owner = typeName(type);
    if (owner) this.owners[path] = owner;
    const props = c.getPropertiesOfType(type);
    const index = c.getIndexInfosOfType(type)[0];
    if (props.length === 0 && index) {
      const value = this.sample(index.type, name, depth + 1, `${path}.key`);
      return value === undefined ? {} : { key: value };
    }
    const out: { [key: string]: Json } = {};
    for (const prop of props) {
      const optional = !!(prop.flags & ts.SymbolFlags.Optional);
      if (optional && (this.mode === "min" || depth >= MAX_DEPTH)) continue;
      const propType = c.getTypeOfSymbol(prop);
      // An optional's type includes `undefined`; the union handler ignores it, since presence is decided above
      const value = this.sample(propType, prop.name, depth + 1, `${path}.${prop.name}`);
      if (value !== undefined) out[prop.name] = value;
    }
    return out;
  }
}

function casesFor(checker: ts.TypeChecker, type: ts.Type, name: string): WireCase[] {
  const seen = new Set<string>();
  const cases: WireCase[] = [];
  for (const mode of MODES) {
    let width = 1;
    for (let index = 0; index < width; index++) {
      const sampler = new Sampler(checker, mode, index);
      const json = sampler.sample(type, name, 0, "$");
      width = Math.max(width, sampler.width);
      if (json === undefined) continue;
      const key = JSON.stringify(json);
      if (seen.has(key)) continue;
      seen.add(key);
      cases.push({ label: `${mode}#${index}`, json, owners: sampler.owners });
    }
  }
  return cases;
}

/** Literal values of `type` when it is a union of string literals alone (a Swift OpenEnum's cases) */
function stringLiterals(type: ts.Type): string[] | null {
  const parts = type.isUnion() ? type.types : [type];
  if (parts.length === 0 || !parts.every((t) => t.flags & ts.TypeFlags.StringLiteral)) return null;
  return parts.map((t) => (t as ts.StringLiteralType).value);
}

export function generate(file: string, skip: Record<string, string>): Generated {
  const program = protocolProgram(file);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (!source) throw new Error(`contract: can't read ${file}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`contract: ${file} has no exports`);

  const out: Generated = { types: {}, literals: {}, consts: {}, skipped: {} };
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const name = symbol.name;
    if (skip[name]) {
      out.skipped[name] = skip[name]!;
      continue;
    }
    if (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) {
      const type = checker.getDeclaredTypeOfSymbol(symbol);
      out.types[name] = casesFor(checker, type, name);
      const literals = stringLiterals(type);
      if (literals) out.literals[name] = literals;
    } else if (symbol.flags & ts.SymbolFlags.Variable) {
      const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration!);
      const values = type.flags & ts.TypeFlags.Object && checker.isTupleType(type)
        ? checker.getTypeArguments(type as ts.TypeReference).map((t) => (t.flags & ts.TypeFlags.StringLiteral ? (t as ts.StringLiteralType).value : null))
        : null;
      if (values && values.every((v) => v !== null)) out.consts[name] = values as string[];
    }
  }
  return out;
}

/** Every exported name in a protocol source, by declaration kind (syntax only: no type checker) */
export function exportedNames(sourceText: string): { types: string[]; values: string[] } {
  const source = ts.createSourceFile("protocol.ts", sourceText, ts.ScriptTarget.ESNext, true);
  const types: string[] = [];
  const values: string[] = [];
  for (const node of source.statements) {
    const exported = ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) types.push(node.name.text);
    else if (ts.isFunctionDeclaration(node) && node.name) values.push(node.name.text);
    else if (ts.isVariableStatement(node)) for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name)) values.push(d.name.text);
  }
  return { types, values };
}
