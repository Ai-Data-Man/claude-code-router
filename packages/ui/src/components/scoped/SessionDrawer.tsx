import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useConfig } from "@/components/ConfigProvider";
import { X, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface SessionDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function SessionDrawer({ open, onClose }: SessionDrawerProps) {
  const { t } = useTranslation();
  const { scoped, setScoped, refreshSessionIndex } = useConfig();
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  useEffect(() => {
    if (open) {
      refreshSessionIndex({
        limit: 20,
        projectPath: projectFilter !== "all" ? projectFilter : undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
      });
    }
  }, [open, projectFilter, fromDate, toDate, refreshSessionIndex]);

  if (!open) return null;

  const handleSelect = (sessionId: string, projectPath: string) => {
    setScoped((prev) => ({ ...prev, activeSessionId: sessionId, activeProjectPath: projectPath }));
    onClose();
  };

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-[420px] max-h-full bg-white border-l shadow-xl overflow-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">{t("scoped.session_select")}</h3>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-3">
          <select
            className="h-9 rounded-md border border-gray-200 text-sm px-2"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          >
            <option value="all">{t("scoped.all_projects")}</option>
            {scoped.projectItems.map((p) => (
              <option key={p.path} value={p.path}>{p.label}</option>
            ))}
          </select>
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="text-sm" />
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="text-sm" />
        </div>
        <div className="space-y-2">
          {scoped.sessionItems.map((session) => (
            <button
              key={session.id}
              onClick={() => handleSelect(session.id, session.projectPath)}
              className={`w-full text-left p-3 rounded-xl border transition-colors ${
                scoped.activeSessionId === session.id
                  ? "border-blue-400 bg-blue-50"
                  : "border-gray-200 hover:bg-gray-50"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm">{session.id.slice(0, 8)}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${session.hasOverride ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"}`}>
                  {session.hasOverride ? t("scoped.has_override") : t("scoped.inherit_only")}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-1">{session.lastActivityAt}</p>
            </button>
          ))}
          {scoped.sessionItems.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-4">{t("scoped.no_sessions")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
