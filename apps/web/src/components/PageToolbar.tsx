import type { ReactNode } from "react";

export function PageToolbar({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <div className="page-toolbar">
    <div>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </div>
    {actions ? <div className="page-actions">{actions}</div> : null}
  </div>;
}
