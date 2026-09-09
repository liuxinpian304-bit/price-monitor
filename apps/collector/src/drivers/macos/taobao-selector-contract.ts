import type { AxNode } from "./ax-node.ts";

export interface SearchPaginationState {
  currentPage: number;
  totalPages: number;
}

export type SearchAdvance =
  | { kind: "AX_ACTION"; action: "AXScrollDown" | "AXPress"; node: AxNode }
  | { kind: "KEY"; keyCode: 121 };

export type SearchRetreat =
  | { kind: "AX_ACTION"; action: "AXPress"; node: AxNode }
  | { kind: "KEY"; keyCode: 115 };

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
