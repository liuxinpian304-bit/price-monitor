import { Alert, Tag } from "antd";

import type { CollectionRunBusinessSummary, CollectionRunCompletion } from "../../api/types.ts";

interface RunBusinessSummaryProps {
  completion: CollectionRunCompletion;
  summary: CollectionRunBusinessSummary;
}

const METRIC_LABELS: Array<[keyof Pick<
  CollectionRunBusinessSummary,
  "distinctShopCount" | "distinctItemCount" | "skuCount" | "matchedSkuCount" | "confirmedLowCount" | "missingCombinationCount" | "reviewCount" | "excludedCount"
>, string]> = [
  ["distinctShopCount", "店铺"],
  ["distinctItemCount", "商品"],
  ["skuCount", "SKU"],
  ["matchedSkuCount", "已匹配 SKU"],
  ["confirmedLowCount", "确认低价"],
  ["missingCombinationCount", "缺失组合"],
  ["reviewCount", "待复核"],
  ["excludedCount", "异常 / 排除"]
];

export function RunBusinessSummary({ completion, summary }: RunBusinessSummaryProps) {
  return <div className="panel run-business-summary" aria-label="经营报告摘要">
    {!completion.complete ? <Alert
      className="run-business-coverage"
      type="warning"
      showIcon
      title={`部分覆盖：已捕获 ${completion.positionsCaptured} / ${completion.requestedPositions} 个搜索位置`}
      description="以下经营结果仅覆盖本次已采集数据。"
    /> : null}
    <div className="run-business-summary-grid">
      <div className="run-business-summary-item run-business-summary-completion">
        <span>搜索完成度</span>
        <strong>{completion.positionsCaptured} / {completion.requestedPositions}</strong>
      </div>
      {METRIC_LABELS.map(([key, label]) => <div className="run-business-summary-item" key={key}>
        <span>{label}</span>
        <strong>{summary[key]}</strong>
      </div>)}
      <div className="run-business-summary-item run-business-own-catalog">
        <span>我方目录</span>
        <strong>{summary.ownCollectedListingCount} / {summary.ownConfiguredListingCount}</strong>
        <Tag color={summary.ownCatalogComplete ? "success" : "warning"}>
          {summary.ownCatalogComplete ? "我方目录采集完整" : "我方目录采集不完整"}
        </Tag>
      </div>
    </div>
  </div>;
}
