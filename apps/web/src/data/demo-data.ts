export type AlertStatus = "PENDING" | "PRICE_CHANGED" | "NO_FOLLOW" | "FALSE_POSITIVE" | "WATCHING";

export interface DemoAlert {
  id: string;
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
    model: "RME Babyface Pro FS",
    type: "BARE",
    sku: "Babyface Pro FS单机",
    ownPriceFen: 730_000,
    competitorPriceFen: 629_999,
    competitorShop: "音频玩家旗舰店",
    competitorUrl: "https://detail.tmall.com/item.htm?id=1001",
    foundAt: "2026-08-19 09:30:05",
    status: "PENDING",
    severity: "CONFIRMED_LOW",
    owner: "张三"
  },
  {
    id: "alert-2",
    model: "Sennheiser MK4",
    type: "BARE",
    sku: "MK4官方标配",
    ownPriceFen: 219_900,
    competitorPriceFen: 199_900,
    competitorShop: "声华音频专营店",
    competitorUrl: "https://detail.tmall.com/item.htm?id=1003",
    foundAt: "2026-08-19 09:15:21",
    status: "WATCHING",
    severity: "CONFIRMED_LOW",
    owner: "李四"
  },
  {
    id: "alert-3",
    model: "Neumann KMS 105",
    type: "BARE",
    sku: "KMS 105镍色",
    ownPriceFen: 689_900,
    competitorPriceFen: 639_900,
    competitorShop: "麦田音响专营店",
    competitorUrl: "https://detail.tmall.com/item.htm?id=1004",
    foundAt: "2026-08-19 08:57:42",
    status: "PENDING",
    severity: "CONFIRMED_LOW",
    owner: "王五"
  },
  {
    id: "alert-4",
    model: "RME Babyface Pro FS MK4录音套装",
    type: "BUNDLE",
    sku: "Babyface Pro FS+MK4套装",
    ownPriceFen: 829_900,
    competitorPriceFen: 799_900,
    competitorShop: "同行录音设备店",
    competitorUrl: "https://detail.tmall.com/item.htm?id=1002",
    foundAt: "2026-08-19 09:30:07",
    status: "PENDING",
    severity: "CONFIRMED_LOW",
    owner: "张三"
  },
  {
    id: "alert-5",
    model: "RME Babyface Pro FS MK8套装",
    type: "BUNDLE",
    sku: "Babyface Pro FS+MK8套装",
    ownPriceFen: 899_900,
    competitorPriceFen: 859_900,
    competitorShop: "专业录音旗舰店",
    competitorUrl: "https://detail.tmall.com/item.htm?id=1005",
    foundAt: "2026-08-19 08:45:18",
    status: "WATCHING",
    severity: "MANUAL_REVIEW",
    owner: "张三"
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
  { code: "MON-0001", brand: "RME", model: "Babyface Pro FS", category: "声卡", type: "裸机", owner: "张三", enabled: true },
  { code: "MON-0002", brand: "RME", model: "Babyface Pro FS", category: "声卡", type: "套装", owner: "张三", enabled: true },
  { code: "MON-0003", brand: "Antelope", model: "Zen Quadro", category: "声卡", type: "裸机", owner: "李四", enabled: true },
  { code: "MON-0004", brand: "Sennheiser", model: "MK4", category: "麦克风", type: "裸机", owner: "李四", enabled: true },
  { code: "MON-0005", brand: "Neumann", model: "KMS 105", category: "麦克风", type: "裸机", owner: "王五", enabled: true },
  { code: "MON-0006", brand: "Kali Audio", model: "LP-UNF", category: "监听音箱", type: "裸机", owner: "王五", enabled: false }
];

export const comparisons = [
  { key: "1", model: "RME Babyface Pro FS", sku: "单机 / FS新版", own: 730_000, competitor: 629_999, shop: "音频玩家旗舰店", stock: "有货", updated: "09:30:05" },
  { key: "2", model: "Sennheiser MK4", sku: "官方标配 / 国行", own: 219_900, competitor: 199_900, shop: "声华音频专营店", stock: "有货", updated: "09:15:21" },
  { key: "3", model: "Neumann KMS 105", sku: "镍色 / 国行", own: 689_900, competitor: 639_900, shop: "麦田音响专营店", stock: "有货", updated: "08:57:42" },
  { key: "4", model: "Kali Audio LP-UNF", sku: "黑色一对", own: 289_900, competitor: 259_900, shop: "新城旗舰店", stock: "缺货", updated: "08:43:08" }
];

export function formatFen(fen: number): string {
  return `¥${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, "0")}`;
}
