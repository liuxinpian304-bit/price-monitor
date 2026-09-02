import type { AxNode } from "./ax-node.ts";

export type SearchAdvance =
  | { kind: "AX_ACTION"; action: "AXScrollDown"; node: AxNode }
  | { kind: "KEY"; keyCode: 121 };

export interface SelectedDetailPage {
  platformItemId: string | null;
  url: string;
  title: string;
  shopName: string;
  shareNode: AxNode | null;
}

export interface SelectedSearchCard {
  rank: number;
  platformItemId: string | null;
  url: string;
  title: string;
  shopName: string;
  displayPriceMinText: string;
  displayPriceMaxText: string;
  sponsored: boolean;
  actionNode: AxNode;
  cardNode: AxNode;
}
