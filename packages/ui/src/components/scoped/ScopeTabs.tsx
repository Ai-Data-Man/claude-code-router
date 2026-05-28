import { useTranslation } from "react-i18next";
import { useConfig } from "@/components/ConfigProvider";
import type { ScopeType } from "@/types";

const scopes: { value: ScopeType; labelKey: string }[] = [
  { value: "global", labelKey: "scoped.scope_global" },
  { value: "project", labelKey: "scoped.scope_project" },
  { value: "session", labelKey: "scoped.scope_session" },
];

export function ScopeTabs() {
  const { t } = useTranslation();
  const { scoped, setScoped } = useConfig();

  if (!scoped.scopedAvailable) return null;

  return (
    <div className="flex gap-2">
      {scopes.map(({ value, labelKey }) => (
        <button
          key={value}
          onClick={() => setScoped((prev) => ({ ...prev, scope: value }))}
          className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
            scoped.scope === value
              ? "bg-blue-50 border-blue-300 text-blue-700"
              : "bg-white border-gray-200 text-gray-500 hover:bg-gray-50"
          }`}
        >
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
}
