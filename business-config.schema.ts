import type { BusinessConfigSchema } from "@adobe/aio-commerce-lib-config";

// businessConfig schema for the "APP MOC DATA" mock tax data provider, surfaced in App Management.
export const businessConfigSchema: BusinessConfigSchema = [
  {
    default: true,
    label: "Enable App",
    name: "app-enabled",
    type: "boolean",
  },
  {
    name: "mock-data-base-url",
    label: "Base URL APP MOC DATA",
    type: "url",
  },
  {
    name: "mock-data-api-endpoint",
    label: "API APP MOC DATA",
    type: "text",
    default: "/api/v1/web/commerce-poc/tax-calculate",
  },
  {
    name: "mock-data-api-key",
    label: "API key",
    type: "password",
  },
];
