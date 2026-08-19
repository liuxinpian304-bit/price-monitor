import { InboxOutlined } from "@ant-design/icons";
import { Alert, Button, Modal, Table, Upload } from "antd";
import { useEffect, useState } from "react";

import { apiRequest } from "../../api/client.ts";

export interface ImportError {
  sheet: string;
  row: number;
  field: string;
  message: string;
}

export function ImportDialog({
  open,
  onClose,
  errors = [],
  onImported
}: {
  open: boolean;
  onClose: () => void;
  errors?: ImportError[];
  onImported?: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [importErrors, setImportErrors] = useState<ImportError[]>(errors);
  const [uploading, setUploading] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => setImportErrors(errors), [errors]);

  const upload = async () => {
    if (!file) {
      setImportErrors([{ sheet: "文件", row: 0, field: "文件", message: "请选择要导入的 Excel 文件" }]);
      return;
    }
    setUploading(true);
    setSuccess(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result = await apiRequest<{ imported: number; updated: number; errors: ImportError[] }>("/api/catalog/import", {
        method: "POST",
        body: formData,
        role: "ADMIN",
        actorId: "本地管理员"
      });
      setImportErrors(result.errors);
      if (result.errors.length === 0) {
        setSuccess(`导入完成：新增 ${result.imported} 个，更新 ${result.updated} 个`);
        onImported?.();
      }
    } catch (uploadError) {
      setImportErrors([{ sheet: "接口", row: 0, field: "导入", message: uploadError instanceof Error ? uploadError.message : "导入失败" }]);
    } finally {
      setUploading(false);
    }
  };

  return <Modal
    title="导入监控型号"
    open={open}
    onCancel={onClose}
    width={760}
    footer={<><Button onClick={onClose}>关闭</Button><Button type="primary" loading={uploading} onClick={() => void upload()}>开始导入</Button></>}
  >
    <Upload.Dragger
      accept=".xlsx"
      maxCount={1}
      beforeUpload={(selected) => {
        setFile(selected);
        setImportErrors([]);
        setSuccess(null);
        return false;
      }}
      onRemove={() => {
        setFile(null);
        return true;
      }}
      className="import-dropzone"
    >
      <p className="ant-upload-drag-icon"><InboxOutlined /></p>
      <p className="ant-upload-text">选择或拖入运营录入模板</p>
      <p className="ant-upload-hint">仅支持 .xlsx，系统会先校验全部工作表，再一次性导入</p>
    </Upload.Dragger>

    {success ? <Alert className="import-success" type="success" showIcon message={success} /> : null}
    {importErrors.length > 0 ? <div className="import-errors">
      <Alert type="error" showIcon message={`发现 ${importErrors.length} 处问题，本次未写入任何数据`} />
      <Table
        rowKey={(error) => `${error.sheet}-${error.row}-${error.field}`}
        pagination={false}
        size="small"
        dataSource={importErrors}
        columns={[
          { title: "工作表", dataIndex: "sheet", width: 120 },
          { title: "行号", dataIndex: "row", width: 90, render: (row: number) => `第 ${row} 行` },
          { title: "字段", dataIndex: "field", width: 120 },
          { title: "问题", dataIndex: "message" }
        ]}
      />
    </div> : null}
  </Modal>;
}
