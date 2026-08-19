export type AlertStatus = "PENDING" | "PRICE_CHANGED" | "NO_FOLLOW" | "FALSE_POSITIVE" | "WATCHING";

export interface DemoAlert {
  id: string;
  monitorCode: string;
  model: string;
  type: "BARE" | "BUNDLE";
  sku: string;
  ownPriceFen: number;
  competitorPriceFen: number;
  competitorShop: string;
  competitorUrl: string;
  foundAt: string;
  status: AlertStatus;
  severity: "CONFIRMED_LOW" | "MANUAL_REVIEW";
  owner: string;
}

export const alerts: DemoAlert[] = [
  {
    id: "alert-1",
    monitorCode: "MON-0001",
    model: "RME Babyface Pro FS",
    type: "BARE",
    sku: "Babyface Pro FS单机",
    ownPriceFen: 701_000,
    competitorPriceFen: 700_999,
    competitorShop: "示例同行店A",
    competitorUrl: "https://example.com/demo/1",
    foundAt: "2026-08-19 09:30:05",
    status: "PENDING",
    severity: "CONFIRMED_LOW",
    owner: "运营A"
  },
  {
    id: "alert-2",
    monitorCode: "MON-0003",
    model: "Sennheiser MK4",
    type: "BARE",
    sku: "MK4官方标配",
    ownPriceFen: 321_000,
    competitorPriceFen: 320_000,
    competitorShop: "示例同行店C",
    competitorUrl: "https://example.com/demo/2",
    foundAt: "2026-08-19 09:15:21",
    status: "WATCHING",
    severity: "CONFIRMED_LOW",
    owner: "运营B"
  },
  {
    id: "alert-3",
    monitorCode: "MON-0004",
    model: "Neumann KMS 105",
    type: "BARE",
    sku: "KMS 105镍色",
    ownPriceFen: 478_000,
    competitorPriceFen: 477_000,
    competitorShop: "示例同行店A",
    competitorUrl: "https://example.com/demo/3",
    foundAt: "2026-08-19 08:57:42",
    status: "PENDING",
    severity: "CONFIRMED_LOW",
    owner: "运营C"
  },
  {
    id: "alert-4",
    monitorCode: "MON-0002",
    model: "RME Babyface Pro FS MK4录音套装",
    type: "BUNDLE",
    sku: "Babyface Pro FS+MK4套装",
    ownPriceFen: 855_000,
    competitorPriceFen: 854_000,
    competitorShop: "示例同行店B",
    competitorUrl: "https://example.com/demo/4",
    foundAt: "2026-08-19 09:30:07",
    status: "PENDING",
    severity: "CONFIRMED_LOW",
    owner: "运营A"
  },
  {
    id: "alert-5",
    monitorCode: "MON-0005",
    model: "RME Babyface Pro FS MK8套装",
    type: "BUNDLE",
    sku: "Babyface Pro FS+MK8套装",
    ownPriceFen: 936_000,
    competitorPriceFen: 935_000,
    competitorShop: "示例同行店B",
    competitorUrl: "https://example.com/demo/5",
    foundAt: "2026-08-19 08:45:18",
    status: "WATCHING",
    severity: "MANUAL_REVIEW",
    owner: "运营A"
  }
];

export const schedule = [
  "03:30", "09:30", "10:30", "11:30", "12:30", "13:30",
  "14:30", "15:30", "16:30", "17:30", "18:30", "22:30"
].map((time, index) => ({
  time,
  status: index < 3 ? "DONE" as const : index === 3 ? "RUNNING" as const : "WAITING" as const
}));

export const models = [
  { code: "MON-0001", brand: "RME", model: "Babyface Pro FS", category: "声卡", type: "裸机", owner: "运营A", enabled: true },
  { code: "MON-0002", brand: "RME", model: "Babyface Pro FS", category: "声卡", type: "套装", owner: "运营A", enabled: true },
  { code: "MON-0003", brand: "Antelope", model: "Zen Quadro", category: "声卡", type: "裸机", owner: "运营B", enabled: true },
  { code: "MON-0004", brand: "Sennheiser", model: "MK4", category: "麦克风", type: "裸机", owner: "运营B", enabled: true },
  { code: "MON-0005", brand: "Neumann", model: "KMS 105", category: "麦克风", type: "裸机", owner: "运营C", enabled: true },
  { code: "MON-0006", brand: "Kali Audio", model: "LP-UNF", category: "监听音箱", type: "裸机", owner: "运营C", enabled: false }
];

export const comparisons = [
  { key: "1", monitorCode: "MON-0001", model: "RME Babyface Pro FS", sku: "单机 / FS新版", own: 701_000, competitor: 700_999, shop: "示例同行店A", stock: "有货", updated: "09:30:05" },
  { key: "2", monitorCode: "MON-0003", model: "Sennheiser MK4", sku: "官方标配 / 国行", own: 321_000, competitor: 320_000, shop: "示例同行店C", stock: "有货", updated: "09:15:21" },
  { key: "3", monitorCode: "MON-0004", model: "Neumann KMS 105", sku: "镍色 / 国行", own: 478_000, competitor: 477_000, shop: "示例同行店A", stock: "有货", updated: "08:57:42" },
  { key: "4", monitorCode: "MON-0006", model: "Kali Audio LP-UNF", sku: "黑色一对", own: 264_000, competitor: 263_000, shop: "示例同行店C", stock: "缺货", updated: "08:43:08" }
];

export function formatFen(fen: number): string {
  return `¥${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, "0")}`;
}
