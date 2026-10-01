import { useCallback } from "react";

import { useCommerceProxyAction } from "./use-commerce-proxy-action.ts";

/**
 * Returns a function that deletes a Commerce tax class by id.
 */
export function useDeleteCommerceTaxClass() {
  const callProxyAction = useCommerceProxyAction();

  return useCallback(
    (classId: number) => callProxyAction(`taxClasses/${classId}`, "DELETE"),
    [callProxyAction],
  );
}
