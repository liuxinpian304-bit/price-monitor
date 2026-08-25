import { LockOutlined, UnlockOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Modal, Space, Tag } from "antd";
import { useEffect, useState } from "react";

import {
  isAdminSessionUnlocked,
  lockAdminSession,
  subscribeAdminSession,
  unlockAdminSession
} from "./admin-session.ts";

export function AdminAccessControl({ compact = false }: { compact?: boolean }) {
  const [unlocked, setUnlocked] = useState(isAdminSessionUnlocked);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => subscribeAdminSession((event) => {
    if (event.type === "changed") {
      setUnlocked(event.unlocked);
      return;
    }
    setUnlocked(false);
    setToken("");
    setError("管理员凭证无效或已过期，请重新输入。");
    setOpen(true);
  }), []);

  const unlock = () => {
    try {
      unlockAdminSession(token);
      setToken("");
      setError(null);
      setOpen(false);
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : "无法解锁管理员操作");
    }
  };

  const lock = () => {
    lockAdminSession();
    setToken("");
    setError(null);
  };

  return <>
    {unlocked ? <Space size={8}>
      {!compact ? <Tag color="success" icon={<UnlockOutlined />}>管理员已解锁</Tag> : null}
      <Button size="small" icon={<LockOutlined />} onClick={lock} aria-label="锁定管理员操作">
        {compact ? null : "锁定"}
      </Button>
    </Space> : <Button
      size="small"
      icon={<LockOutlined />}
      onClick={() => setOpen(true)}
      aria-label="管理员解锁"
    >
      {compact ? null : "管理员解锁"}
    </Button>}

    <Modal
      title="解锁管理员操作"
      open={open}
      okText="解锁"
      cancelText="取消"
      onOk={unlock}
      onCancel={() => {
        setOpen(false);
        setToken("");
        setError(null);
      }}
      destroyOnHidden
    >
      <Space orientation="vertical" size={12} style={{ width: "100%" }}>
        {error ? <Alert type="error" showIcon title={error} /> : null}
        <Input.Password
          aria-label="管理员凭证"
          autoComplete="current-password"
          placeholder="输入 ADMIN_API_TOKEN"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          onPressEnter={unlock}
        />
        <span className="form-help">凭证只保存在当前浏览器标签会话中，关闭标签后需要重新输入。</span>
      </Space>
    </Modal>
  </>;
}
