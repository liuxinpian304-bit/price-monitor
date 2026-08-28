import { ExportOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Descriptions, Result, Select, Space, Spin, Table, Tag, message } from "antd";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { useApiData } from "../api/client.ts";
import {
  collectionRunDetailReportPath,
  fetchCollectionEvidence,
  requeueCollectionRun
} from "../api/collection-runs.ts";
import type {
  CollectionRunReportConfidence,
  CollectionRunReportDetail,
  CollectionRunReportFilters,
  CollectionRunReportMatch,
  CollectionRunReportPrice,
  CollectionRunReportSku,
  CollectionRunReportSource
} from "../api/types.ts";
import { PageToolbar } from "../components/PageToolbar.tsx";
import { formatFen } from "../data/demo-data.ts";
import { ConfirmedLowsSection } from "../features/collection-runs/ConfirmedLowsSection.tsx";
import { MissingOwnSection } from "../features/collection-runs/MissingOwnSection.tsx";
import { PriceBoardSection } from "../features/collection-runs/PriceBoardSection.tsx";
import { RunBusinessSummary } from "../features/collection-runs/RunBusinessSummary.tsx";
import { formatDateTime } from "../features/operations/table-tools.ts";

function pauseGuidance(status: string): string | null {
  if (status === "PAUSED_LOGIN") return "请在已登记的 Mac 上打开淘宝桌面版，恢复登录后再重新入队。";
  if (status === "PAUSED_CHALLENGE") return "请在已登记的 Mac 上按平台要求完成验证，确认回到搜索结果后再重新入队。";
  return null;
}

function priceText(value: number | null): string {
  return value === null ? "--" : formatFen(value);
}

function replaceFilter<K extends keyof CollectionRunReportFilters>(
  current: CollectionRunReportFilters,
  key: K,
  value: CollectionRunReportFilters[K] | undefined
): CollectionRunReportFilters {
  const next = { ...current };
  if (value === undefined) delete next[key];
  else Object.assign(next, { [key]: value });
  return next;
}

function PriceComponents({ row }: { row: CollectionRunReportSku }) {
  const prices = row.prices;
  return <div className="sku-price-components">
    <span>标价 {priceText(prices.listPriceFen)}</span>
    <span>活动 {priceText(prices.activityPriceFen)}</span>
    <span>公开优惠 {formatFen(prices.publicDiscountFen)}</span>
    <span>券 {formatFen(prices.couponDiscountFen)}</span>
    <span>满减 {formatFen(prices.fullReductionFen)}</span>
    <span>直降 {formatFen(prices.directDiscountFen)}</span>
    <span>费用 {formatFen(prices.mandatoryFeeFen)}</span>
    <strong>到手 {priceText(prices.payableFen)}</strong>
  </div>;
}

function EvidenceButton({ runId, sha256 }: { runId: string; sha256: string | null }) {
  const [opening, setOpening] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  if (!sha256) return <span>无</span>;

  const openEvidence = async () => {
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      messageApi.error("浏览器阻止了证据窗口");
      return;
    }
    popup.opener = null;
    setOpening(true);
    try {
      const blob = await fetchCollectionEvidence(runId, sha256);
      const url = URL.createObjectURL(blob);
      popup.location.href = url;
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      popup.close();
      messageApi.error(error instanceof Error ? error.message : "无法打开证据");
    } finally {
      setOpening(false);
    }
  };

  return <>{contextHolder}<Button size="small" loading={opening} onClick={() => void openEvidence()}>查看证据</Button></>;
}

function InitialDetailState({ loading, error, errorStatus }: {
  loading: boolean;
  error: string | null;
  errorStatus: number | null;
}) {
  if (loading) return <section className="panel collection-report-state"><Spin /><span>正在加载采集运行</span></section>;
  const authorizationError = errorStatus === 401 || errorStatus === 403;
  return <section className="panel collection-report-state"><Result
    status={errorStatus === 404 ? "404" : authorizationError ? "403" : "error"}
    title={errorStatus === 404 ? "采集运行不存在" : authorizationError ? "需要管理员权限" : "采集运行加载失败"}
    subTitle={error ?? "无法连接后台接口"}
  /></section>;
}

export function CollectionRunDetailPage() {
  const { runId = "" } = useParams();
  const [filters, setFilters] = useState<CollectionRunReportFilters>({});
  const [positionPage, setPositionPage] = useState(1);
  const [issuePage, setIssuePage] = useState(1);
  const [skuPage, setSkuPage] = useState(1);
  const [requeueing, setRequeueing] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const path = useMemo(() => collectionRunDetailReportPath(runId, filters, {
    positionPage,
    positionPageSize: 50,
    issuePage,
    issuePageSize: 50,
    skuPage,
    skuPageSize: 50
  }), [filters, issuePage, positionPage, runId, skuPage]);
  const {
    data: report,
    loading,
    error,
    errorStatus,
    hasSuccessfulData,
    refresh
  } = useApiData<CollectionRunReportDetail>(path, null, { role: "ADMIN" });

  if (!hasSuccessfulData || !report) {
    return <>
      <PageToolbar title="采集运行报告" description={runId} actions={<Link to="/runs">返回报告列表</Link>} />
      <InitialDetailState loading={loading} error={error} errorStatus={errorStatus} />
    </>;
  }

  const guidance = pauseGuidance(report.status);
  const changeFilter = <K extends keyof CollectionRunReportFilters>(
    key: K,
    value: CollectionRunReportFilters[K] | undefined
  ) => {
    setSkuPage(1);
    setFilters((current) => replaceFilter(current, key, value));
  };

  const requeue = async () => {
    setRequeueing(true);
    try {
      await requeueCollectionRun(report.id);
      await refresh();
      messageApi.success("运行已重新入队，等待已登记采集器领取。");
    } catch (requeueError) {
      messageApi.error(requeueError instanceof Error ? requeueError.message : "重新入队失败");
    } finally {
      setRequeueing(false);
    }
  };

  return <>
    {contextHolder}
    <PageToolbar
      title={report.model.label}
      description={`${report.model.monitorCode} · ${report.id}`}
      actions={<Link to="/runs">返回报告列表</Link>}
    />
    {error ? <Alert className="data-warning" type="warning" showIcon title="采集报告刷新失败，当前显示上次成功数据。" description={error} /> : null}
    {guidance ? <Alert
      className="data-warning"
      type="warning"
      showIcon
      title={report.status === "PAUSED_LOGIN" ? "采集已因登录暂停" : "采集已因平台验证暂停"}
      description={guidance}
      action={<Button type="primary" icon={<ReloadOutlined />} loading={requeueing} onClick={() => void requeue()}>重新入队</Button>}
    /> : null}

    <section className="panel run-overview">
      <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
        <Descriptions.Item label="运行状态"><Tag>{report.status}</Tag></Descriptions.Item>
        <Descriptions.Item label="完成度"><Tag color={report.completion.complete ? "success" : "warning"}>{report.completion.label}</Tag></Descriptions.Item>
        <Descriptions.Item label="搜索结束">
          {report.completion.terminationReason === "END_MARKER"
            ? "已验证页面到底"
            : report.completion.terminationReason === "LIMIT_REACHED"
              ? "已达到采集上限"
              : "未记录或未验证"}
        </Descriptions.Item>
        <Descriptions.Item label="SKU"><strong>{report.pagination.skus.total}</strong> / {report.totalSkuCount} 条</Descriptions.Item>
        <Descriptions.Item label="发现 / 抓取">{report.completion.discoveredCount} / {report.completion.fetchedCount}</Descriptions.Item>
        <Descriptions.Item label="匹配 / 失败">{report.completion.matchedCount} / {report.completion.failedCount}</Descriptions.Item>
        <Descriptions.Item label="通知"><Tag>{report.notification.state}</Tag> {report.notification.attempts} 次</Descriptions.Item>
        <Descriptions.Item label="采集器">{report.collector ? `${report.collector.name} · ${report.collector.appVersion ?? "版本未知"}` : "未分配"}</Descriptions.Item>
        <Descriptions.Item label="计划时间">{formatDateTime(report.scheduledFor)}</Descriptions.Item>
        <Descriptions.Item label="开始 / 结束">{report.startedAt ? formatDateTime(report.startedAt) : "--"} / {report.finishedAt ? formatDateTime(report.finishedAt) : "--"}</Descriptions.Item>
        <Descriptions.Item label="未完成">{report.completion.incompleteCount} 项</Descriptions.Item>
      </Descriptions>
      {report.error ? <div className="run-error"><strong>{report.error.code}</strong>{report.error.message ? `：${report.error.message}` : ""}</div> : null}
    </section>

    <RunBusinessSummary completion={report.completion} summary={report.businessSummary} />
    <PriceBoardSection shops={report.priceBoard.shops} />
    <ConfirmedLowsSection rows={report.confirmedLows} />
    <MissingOwnSection groups={report.missingOwnGroups} />

    <section className="panel table-panel run-positions-panel">
      <div className="panel-heading"><h2>搜索位置</h2><span>已捕获 {report.completion.positionsCaptured} / {report.completion.requestedPositions}</span></div>
      <div className="collection-runs-scroll" data-testid="collection-run-positions-scroll">
        <Table
          rowKey={(position) => `${position.rank}-${position.platformItemId}`}
          dataSource={report.positions}
          loading={loading}
          locale={{ emptyText: "暂无搜索位置" }}
          pagination={{
            current: report.pagination.positions.page,
            pageSize: report.pagination.positions.pageSize,
            total: report.pagination.positions.total,
            showSizeChanger: false,
            onChange: setPositionPage
          }}
          scroll={{ x: 1_050 }}
          columns={[
            { title: "排名", dataIndex: "rank", width: 90, render: (rank: number) => `排名 ${rank}` },
            { title: "商品", width: 320, render: (_value, position) => <div className="run-product-cell"><strong>{position.title}</strong><small>{position.platformItemId}</small></div> },
            { title: "店铺", dataIndex: "shopName", width: 180 },
            { title: "展示价", width: 150, render: (_value, position) => position.displayPriceMinFen === position.displayPriceMaxFen ? formatFen(position.displayPriceMinFen) : `${formatFen(position.displayPriceMinFen)} - ${formatFen(position.displayPriceMaxFen)}` },
            { title: "推广", dataIndex: "sponsored", width: 100, render: (value: boolean) => value ? <Tag color="warning">推广</Tag> : <Tag>自然</Tag> },
            { title: "采集时间", dataIndex: "capturedAt", width: 180, render: formatDateTime },
            { title: "商品", width: 88, render: (_value, position) => position.url ? <a href={position.url} target="_blank" rel="noreferrer" aria-label={`打开位置 ${position.rank}`}><ExportOutlined /></a> : "--" }
          ]}
        />
      </div>
    </section>

    <section className="panel table-panel run-sku-panel">
      <div className="table-tools run-filter-tools">
        <strong>每个 SKU（筛选结果 {report.pagination.skus.total} / 全部 {report.totalSkuCount}）</strong>
        <Space wrap>
          <Select<CollectionRunReportSource | undefined> aria-label="来源筛选" allowClear placeholder="全部来源" value={filters.source} onChange={(value) => changeFilter("source", value)} options={[{ value: "OWN", label: "我方" }, { value: "COMPETITOR", label: "同行" }]} />
          <Select<CollectionRunReportMatch | undefined> aria-label="匹配筛选" allowClear placeholder="全部匹配" value={filters.match} onChange={(value) => changeFilter("match", value)} options={[{ value: "EXACT", label: "精确可比" }, { value: "REVIEW", label: "人工复核" }, { value: "EXCLUDED", label: "排除" }]} />
          <Select<CollectionRunReportPrice | undefined> aria-label="价格筛选" allowClear placeholder="全部价格" value={filters.price} onChange={(value) => changeFilter("price", value)} options={[{ value: "LOWER", label: "同行更低" }, { value: "NOT_LOWER", label: "同行不低" }]} />
          <Select<CollectionRunReportConfidence | undefined> aria-label="置信度筛选" allowClear placeholder="全部置信度" value={filters.confidence} onChange={(value) => changeFilter("confidence", value)} options={[{ value: "CONFIRMED", label: "已确认" }, { value: "ESTIMATED", label: "估算" }, { value: "MANUAL_REVIEW", label: "人工复核" }]} />
        </Space>
      </div>
      <div className="collection-runs-scroll" data-testid="collection-run-skus-scroll">
        <Table
          rowKey="id"
          dataSource={report.skus}
          loading={loading}
          locale={{ emptyText: "暂无 SKU" }}
          pagination={{
            current: report.pagination.skus.page,
            pageSize: report.pagination.skus.pageSize,
            total: report.pagination.skus.total,
            showSizeChanger: false,
            onChange: setSkuPage
          }}
          scroll={{ x: 1540 }}
          columns={[
            { title: "来源 / 排名", width: 120, render: (_value, row: CollectionRunReportSku) => <div><Tag>{row.source === "OWN" ? "我方" : "同行"}</Tag><small>{row.ranks.length ? `排名 ${row.ranks.join(",")}` : "非搜索位"}</small></div> },
            { title: "商品 / SKU", width: 300, render: (_value, row: CollectionRunReportSku) => <div className="run-product-cell"><strong>{row.title}</strong><span>{row.skuText ?? "未标注 SKU"}</span><small>{row.shopName}</small></div> },
            { title: "价格组件", width: 290, render: (_value, row: CollectionRunReportSku) => <PriceComponents row={row} /> },
            { title: "库存", dataIndex: "stockState", width: 100, render: (value: string) => <Tag color={value === "IN_STOCK" ? "success" : value === "OUT_OF_STOCK" ? "default" : "warning"}>{value}</Tag> },
            { title: "匹配", width: 160, render: (_value, row: CollectionRunReportSku) => <div><Tag color={row.match.category === "EXACT" ? "success" : row.match.category === "EXCLUDED" ? "default" : "warning"}>{row.match.category}</Tag><small>{row.match.confidenceBps / 100}%</small></div> },
            { title: "比价结论", width: 140, render: (_value, row: CollectionRunReportSku) => <div>{row.comparison.state === "LOWER" ? <Tag color="error">{row.comparison.state}</Tag> : <Tag>{row.comparison.state}</Tag>}{row.comparison.differenceFen !== null ? <small>{formatFen(row.comparison.differenceFen)}</small> : null}</div> },
            { title: "置信度", dataIndex: "confidence", width: 130, render: (value: string) => <Tag>{value}</Tag> },
            { title: "说明", width: 260, render: (_value, row: CollectionRunReportSku) => row.match.reasons.join("；") || "--" },
            { title: "商品", width: 88, render: (_value, row: CollectionRunReportSku) => row.url ? <a href={row.url} target="_blank" rel="noreferrer" aria-label={`打开商品 ${row.id}`}><ExportOutlined /></a> : "--" },
            { title: "证据", width: 110, render: (_value, row: CollectionRunReportSku) => <EvidenceButton runId={report.id} sha256={row.evidenceSha256} /> }
          ]}
        />
      </div>
    </section>

    <section className="panel table-panel run-issues-panel">
      <div className="panel-heading"><h2>问题与未完成项</h2><span>{report.pagination.issues.total} 项</span></div>
      <div className="collection-runs-scroll">
        <Table
          rowKey="id"
          dataSource={report.issues}
          loading={loading}
          locale={{ emptyText: "暂无问题" }}
          pagination={{
            current: report.pagination.issues.page,
            pageSize: report.pagination.issues.pageSize,
            total: report.pagination.issues.total,
            showSizeChanger: false,
            onChange: setIssuePage
          }}
          scroll={{ x: 900 }}
          columns={[
            { title: "代码", dataIndex: "code", width: 220 },
            { title: "商品 / SKU", width: 220, render: (_value, issue) => `${issue.platformItemId ?? "--"} / ${issue.skuId ?? "--"}` },
            { title: "说明", dataIndex: "message" },
            { title: "采集时间", dataIndex: "capturedAt", width: 180, render: formatDateTime },
            { title: "证据", width: 110, render: (_value, issue) => <EvidenceButton runId={report.id} sha256={issue.evidenceSha256} /> }
          ]}
        />
      </div>
    </section>
  </>;
}
