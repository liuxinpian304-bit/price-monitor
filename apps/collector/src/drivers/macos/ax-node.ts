export type AxJsonValue = string | number | boolean | null | AxJsonValue[] | { [key: string]: AxJsonValue };

export interface AxPoint {
  x: number;
  y: number;
}

export interface AxSize {
  width: number;
  height: number;
}

export interface AxNode {
  fixtureMetadata?: {
    kind: "synthetic-sanitized" | "live-sanitized";
    profile: string;
    liveValidationRequiredBy?: string;
  };
  path: number[];
  role: string | null;
  subrole: string | null;
  identifier: string | null;
  title: string | null;
  description: string | null;
  value: AxJsonValue;
  url: string | null;
  enabled: boolean | null;
  selected: boolean | null;
  position: AxPoint | null;
  size: AxSize | null;
  actions: string[];
  children: AxNode[];
}

export interface AxNodeFingerprint {
  role?: string;
  title?: string;
  identifier?: string;
}

export function axNodeText(node: AxNode): string | null {
  if (typeof node.value === "string" && node.value.trim() !== "") return node.value.trim();
  if (node.title?.trim()) return node.title.trim();
  if (node.description?.trim()) return node.description.trim();
  return null;
}

export function walkAxNodes(root: AxNode): AxNode[] {
  const nodes: AxNode[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    nodes.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child) pending.push(child);
    }
  }
  return nodes;
}

export function findAxNode(root: AxNode, predicate: (node: AxNode) => boolean): AxNode | null {
  return walkAxNodes(root).find(predicate) ?? null;
}

export function fingerprintFor(node: AxNode): AxNodeFingerprint {
  const fingerprint: AxNodeFingerprint = {};
  if (node.role) fingerprint.role = node.role;
  if (node.title) fingerprint.title = node.title;
  if (node.identifier) fingerprint.identifier = node.identifier;
  return fingerprint;
}
