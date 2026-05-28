import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useConfig } from "@/components/ConfigProvider";
import { api } from "@/lib/api";
import { X, Plus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface ProjectDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function ProjectDrawer({ open, onClose }: ProjectDrawerProps) {
  const { t } = useTranslation();
  const { scoped, setScoped, refreshProjectIndex } = useConfig();
  const [searchTerm, setSearchTerm] = useState("");
  const [manualPath, setManualPath] = useState("");

  useEffect(() => {
    if (open) refreshProjectIndex();
  }, [open, refreshProjectIndex]);

  if (!open) return null;

  const filtered = scoped.projectItems.filter((p) =>
    p.path.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.label.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSelect = (projectPath: string) => {
    setScoped((prev) => ({ ...prev, activeProjectPath: projectPath }));
    onClose();
  };

  const handleAddManual = async () => {
    if (!manualPath.trim()) return;
    try {
      await api.saveProjectConfig(manualPath.trim(), {});
      await refreshProjectIndex();
      setScoped((prev) => ({ ...prev, activeProjectPath: manualPath.trim() }));
      setManualPath("");
      onClose();
    } catch (err) {
      console.error("Failed to add project:", err);
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative w-[420px] max-h-full bg-white border-l shadow-xl overflow-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">{t("scoped.project_select")}</h3>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder={t("scoped.search_project")}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8"
          />
        </div>
        <div className="space-y-2 mb-4">
          {filtered.map((project) => (
            <button
              key={project.path}
              onClick={() => handleSelect(project.path)}
              className={`w-full text-left p-3 rounded-xl border transition-colors ${
                scoped.activeProjectPath === project.path
                  ? "border-blue-400 bg-blue-50"
                  : "border-gray-200 hover:bg-gray-50"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">{project.label}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${project.hasOverride ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"}`}>
                  {project.hasOverride ? t("scoped.has_override") : t("scoped.inherit_only")}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-1 truncate">{project.path}</p>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-4">{t("scoped.no_projects")}</p>
          )}
        </div>
        <div className="border-t pt-3">
          <p className="text-sm font-medium mb-2">{t("scoped.add_manually")}</p>
          <div className="flex gap-2">
            <Input
              placeholder="/path/to/project"
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              className="flex-1"
            />
            <Button onClick={handleAddManual} disabled={!manualPath.trim()}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
