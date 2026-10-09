import {
  byCodeAndLevel,
  getConfigurationByKey,
  initialize,
} from "@adobe/aio-commerce-lib-config";

import appConfig from "#app.commerce.config";

export async function isAppEnabled(params) {
  await initialize({ params, schema: appConfig.businessConfig.schema });
  const enabled = await getConfigurationByKey(
    "app-enabled",
    byCodeAndLevel("global", "global"),
  );
  return enabled.config?.value !== false;
}
