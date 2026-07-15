import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfig } from "./ConfigProvider";
import { Combobox } from "./ui/combobox";
import { ScopeTabs } from "./scoped/ScopeTabs";
import { ViewTabs } from "./scoped/ViewTabs";
import { ProjectDrawer } from "./scoped/ProjectDrawer";
import { SessionDrawer } from "./scoped/SessionDrawer";
import type { ScopedRouterConfig, RouterConfig, Provider, ProviderModel } from "@/types";

const routeFields: { field: keyof RouterConfig; labelKey: string; isNumber?: boolean }[] = [
  { field: "default", labelKey: "router.default" },
  { field: "sonnet", labelKey: "router.sonnet" },
  { field: "opus", labelKey: "router.opus" },
  { field: "fable", labelKey: "router.fable" },
  { field: "haiku", labelKey: "router.haiku" },
  { field: "background", labelKey: "router.background" },
  { field: "think", labelKey: "router.think" },
  { field: "longContext", labelKey: "router.longContext" },
  { field: "webSearch", labelKey: "router.webSearch" },
  { field: "image", labelKey: "router.image" },
];

function getModelName(model: string | ProviderModel): string {
  return typeof model === "string" ? model : model.name;
}

function isModelEnabled(model: string | ProviderModel): boolean {
  return typeof model === "string" ? true : model.enabled !== false;
}

export function Router() {
  const { t } = useTranslation();
  const { config, setConfig, scoped, setScoped, getEffectiveRouter, getFieldSource, saveScopedRouter } = useConfig();
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false);

  if (!config) {
    return (
      <Card className="flex h-full flex-col rounded-lg border shadow-sm">
        <CardHeader className="border-b p-4">
          <CardTitle className="text-lg">{t("router.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex-grow flex items-center justify-center p-4">
          <div className="text-gray-500">Loading router configuration...</div>
        </CardContent>
      </Card>
    );
  }

  const effectiveRouter = getEffectiveRouter();

  const handleRouterChange = async (field: string, value: string | number) => {
    if (scoped.scopedAvailable && scoped.scope !== "global") {
      const patch: ScopedRouterConfig = {};
      if (scoped.scope === "project") {
        patch[field] = value as any;
        const updated = { ...scoped.projectRouter, ...patch };
        setScoped((prev) => ({ ...prev, projectRouter: updated }));
        await saveScopedRouter(updated);
      } else if (scoped.scope === "session") {
        patch[field] = value as any;
        const updated = { ...scoped.sessionRouter, ...patch };
        setScoped((prev) => ({ ...prev, sessionRouter: updated }));
        await saveScopedRouter(updated);
      }
    } else {
      const currentRouter = config.Router || {};
      const newRouter = { ...currentRouter, [field]: value };
      setConfig({ ...config, Router: newRouter as RouterConfig });
    }
  };

  const handleForceUseImageAgentChange = (value: boolean) => {
    setConfig({ ...config, forceUseImageAgent: value });
  };

  const handleResetField = async (field: string) => {
    if (scoped.scope === "project") {
      const updated = { ...scoped.projectRouter };
      delete (updated as any)[field];
      setScoped((prev) => ({ ...prev, projectRouter: updated }));
      await saveScopedRouter(updated);
    } else if (scoped.scope === "session") {
      const updated = { ...scoped.sessionRouter };
      delete (updated as any)[field];
      setScoped((prev) => ({ ...prev, sessionRouter: updated }));
      await saveScopedRouter(updated);
    }
  };

  // Generate model options from shared providers, filtering out disabled ones
  const providers: Provider[] = Array.isArray(config.Providers) ? config.Providers : [];
  const modelOptions = providers.flatMap((provider) => {
    if (!provider || provider.enabled === false) return [];
    const models = Array.isArray(provider.models) ? provider.models : [];
    const providerName = provider.name || "Unknown Provider";
    return models
      .filter((model) => isModelEnabled(model))
      .map((model) => {
        const modelName = getModelName(model);
        return {
          value: `${providerName},${modelName}`,
          label: `${providerName}, ${modelName}`,
        };
      });
  });

  const disabledSelections = new Set<string>();
  providers.forEach((provider) => {
    if (provider.enabled === false) {
      (provider.models || []).forEach((model) => {
        const modelName = getModelName(model);
        disabledSelections.add(`${provider.name},${modelName}`);
      });
    } else {
      (provider.models || []).forEach((model) => {
        if (typeof model !== 'string' && model.enabled === false) {
          disabledSelections.add(`${provider.name},${model.name}`);
        }
      });
    }
  });

  const isOverrideView = scoped.viewMode === "override" && scoped.scope !== "global";

  return (
    <>
      <Card className="flex h-full flex-col rounded-lg border shadow-sm">
        <CardHeader className="border-b p-4 space-y-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">{t("router.title")}</CardTitle>
            {scoped.scopedAvailable && scoped.scope === "project" && (
              <Button variant="outline" size="sm" onClick={() => setProjectDrawerOpen(true)}>
                {t("scoped.project_select")}
              </Button>
            )}
            {scoped.scopedAvailable && scoped.scope === "session" && (
              <Button variant="outline" size="sm" onClick={() => setSessionDrawerOpen(true)}>
                {t("scoped.session_select")}
              </Button>
            )}
          </div>
          <ScopeTabs />
          <ViewTabs />
        </CardHeader>
        <CardContent className="flex-grow space-y-5 overflow-y-auto p-4">
          {routeFields.map(({ field, labelKey }) => {
            // In override view, only show fields that have been overridden at current scope
            if (isOverrideView) {
              const currentOverrides = scoped.scope === "project" ? scoped.projectRouter : scoped.sessionRouter;
              if (!(currentOverrides as any)?.[field as string]) {
                return null;
              }
            }

            const source = scoped.scopedAvailable && scoped.scope !== "global"
              ? getFieldSource(field as keyof RouterConfig)
              : null;

            return (
              <div key={field} className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t(labelKey)}</Label>
                  {source && (
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${source.overridden ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"}`}>
                        {source.source}
                      </span>
                      {source.overridden && scoped.scope !== "global" && (
                        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => handleResetField(field)}>
                          {t("scoped.reset_inherit")}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <Combobox
                  options={modelOptions}
                  value={effectiveRouter[field] as string || ""}
                  onChange={(value) => handleRouterChange(field, value)}
                  placeholder={t("router.selectModel")}
                  searchPlaceholder={t("router.searchModel")}
                  emptyPlaceholder={t("router.noModelFound")}
                />
                {field === "longContext" && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="longContextThreshold">{t("router.longContextThreshold")}</Label>
                      {source && scoped.scope !== "global" && source.overridden && (
                        <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => handleResetField("longContextThreshold") }>
                          {t("scoped.reset_inherit")}
                        </Button>
                      )}
                    </div>
                    <Input
                      id="longContextThreshold"
                      type="number"
                      value={effectiveRouter.longContextThreshold}
                      onChange={(e) => handleRouterChange("longContextThreshold", parseInt(e.target.value, 10) || 60000)}
                      placeholder="60000"
                    />
                  </div>
                )}
                {disabledSelections.has((effectiveRouter[field] as string) || '') && (
                  <p className="text-xs text-amber-600">
                    {t("router.disabled_reference_warning")}
                  </p>
                )}
              </div>
            );
          })}
          {scoped.scope === "global" && (
            <div className="space-y-2">
              <div className="flex items-center gap-4">
                <div className="flex-1" />
                <div className="w-48">
                  <Label htmlFor="forceUseImageAgent">{t("router.forceUseImageAgent")}</Label>
                  <select
                    id="forceUseImageAgent"
                    value={config.forceUseImageAgent ? "true" : "false"}
                    onChange={(e) => handleForceUseImageAgentChange(e.target.value === "true")}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="false">{t("common.no")}</option>
                    <option value="true">{t("common.yes")}</option>
                  </select>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <ProjectDrawer open={projectDrawerOpen} onClose={() => setProjectDrawerOpen(false)} />
      <SessionDrawer open={sessionDrawerOpen} onClose={() => setSessionDrawerOpen(false)} />
    </>
  );
}
