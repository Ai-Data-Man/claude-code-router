import { useTranslation } from "react-i18next";
import { useConfig } from "@/components/ConfigProvider";
import type { ViewMode } from "@/types";

const views: { value: ViewMode; labelKey: string }[] = [
  { value: "effective", labelKey: "scoped.view_effective" },
  { value: "override", labelKey: "scoped.view_override" },
];

export function ViewTabs() {
  const { t } = useTranslation();
  const { scoped, setScoped } = useConfig();

  if (!scoped.scopedAvailable) return null;
  if (scoped.scope === "global") return null;

  return (
    <div className="flex gap-2">
      {views.map(({ value, labelKey }) => (
        <button
          key={value}
          onClick={() => setScoped((prev) => ({ ...prev, viewMode: value }))}
          className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
            scoped.viewMode === value
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
